/**
 * Episode Projection physical container (L1-T01): the offline `episodes.db`
 * SQLite schema from DELOS-L1-EPISODE-PROJECTION-DESIGN-03R2 §1.1.6 — SIX
 * logical objects (episodes, episode_messages, history_payloads,
 * episodes_fts, overrides_applied, meta) in WAL mode, opened at an EXPLICIT
 * injected path. The schema version is held SOLELY by `meta.schema_version`
 * (no separate ledger table, no checksum, no applied-at wall clock).
 *
 * Storage discipline: episodes.db is a rebuildable projection, never a
 * source of truth (the true sources are transcripts + episode-overrides.jsonl
 * + rebuild reports). This adapter owns the schema and its migration ONLY.
 * The rebuild flow that populates rows — Pass1 segmentation, Pass2 summaries,
 * override replay, package promotion, history retirement, atomic swap-in —
 * is a later ticket and lives nowhere in this file.
 *
 * Isolation (§1.7): this file never imports a Mnemosyne module, never opens
 * delos-memory.db, and never defaults to a live path. The constructor path
 * is required and must not be blank; callers (a future composition root)
 * inject data/projections/episodes.db, tests inject a temp directory.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const EPISODES_SCHEMA_VERSION = 1;

export interface EpisodesMigration {
  version: number;
  description: string;
  sql: string;
}

/**
 * Schema v1 — the five content objects of the §1.1.6 container. The sixth
 * object, `meta`, is the version table and is created by the migrator (see
 * migrate()), so version bookkeeping never depends on a migration body
 * having created it. Column names, SQLite types, nullability, and the
 * composite primary keys match the spec exactly; no "handy for later"
 * semantic columns are added. The composite primary key on episode_messages
 * guarantees one message maps to at most one episode (§1.1.6: "no dual
 * assignment").
 */
export const EPISODES_MIGRATIONS: readonly EpisodesMigration[] = [
  {
    version: 1,
    description:
      "episode projection container v1 (episodes, episode_messages, history_payloads, episodes_fts, overrides_applied)",
    sql: `
CREATE TABLE episodes (
  episode_id               TEXT NOT NULL PRIMARY KEY,
  channel                  TEXT NOT NULL,
  thread                   TEXT NOT NULL,
  realm                    TEXT NOT NULL,
  realm_basis              TEXT NOT NULL,
  au_id                    TEXT,
  domain                   TEXT NOT NULL,
  start_message_id         TEXT NOT NULL,
  end_message_id           TEXT NOT NULL,
  started_at_utc           TEXT NOT NULL,
  ended_at_utc             TEXT NOT NULL,
  started_at_local         TEXT NOT NULL,
  ended_at_local           TEXT NOT NULL,
  participants             TEXT NOT NULL,
  initiator                TEXT NOT NULL,
  title                    TEXT NOT NULL,
  entities_lexical         TEXT NOT NULL,
  status                   TEXT NOT NULL,
  continuation_links       TEXT NOT NULL,
  has_continuation         INTEGER NOT NULL,
  source_hash              TEXT NOT NULL,
  index_version            TEXT NOT NULL,
  summary_version          TEXT NOT NULL,
  confidence               REAL NOT NULL,
  sensitivity              TEXT NOT NULL,
  generated_payload        TEXT,
  generated_pending_reason TEXT,
  generated_pending_detail TEXT,
  published_payload        TEXT,
  overrides_applied_ids    TEXT NOT NULL,
  message_count            INTEGER NOT NULL,
  proactive_count          INTEGER NOT NULL
);

CREATE TABLE episode_messages (
  conversation_id TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  episode_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);

CREATE TABLE history_payloads (
  episode_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  payload           TEXT NOT NULL,
  superseded_reason TEXT NOT NULL,
  superseded_at     TEXT NOT NULL,
  PRIMARY KEY (episode_id, seq)
);

CREATE VIRTUAL TABLE episodes_fts USING fts5(
  title, entities, summary, episode_id UNINDEXED, tokenize='unicode61'
);

CREATE TABLE overrides_applied (
  override_id TEXT NOT NULL PRIMARY KEY,
  kind        TEXT NOT NULL,
  op          TEXT NOT NULL,
  target      TEXT NOT NULL,
  state       TEXT NOT NULL,
  detail      TEXT
);
`,
  },
];

/** Human-language failure used when the on-disk schema is ahead of the code. */
export class EpisodesSchemaTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `episode projection is from a newer Delos (schema v${found} > v${supported}); ` +
        `it stays unopened this run and will be rebuilt, chat is unaffected`,
    );
    this.name = "EpisodesSchemaTooNewError";
  }
}

/** Human-language failure when the projection's own bookkeeping is malformed. */
export class EpisodesProjectionCorruptError extends Error {
  constructor(detail: string) {
    super(`episode projection is corrupt (${detail}); it will be rebuilt, chat is unaffected`);
    this.name = "EpisodesProjectionCorruptError";
  }
}

/**
 * Strict fail-closed parse of meta.schema_version: ONLY a complete non-
 * negative decimal safe integer is accepted. A malformed value ("1garbage",
 * "1.5"), a negative, or an out-of-safe-range value throws a corrupt-
 * projection error rather than being silently coerced (which could skip a
 * migration that should have run). It is never downgraded to 0.
 */
function parseSchemaVersion(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new EpisodesProjectionCorruptError(
      `meta.schema_version is not a decimal integer: ${JSON.stringify(raw)}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EpisodesProjectionCorruptError(`meta.schema_version is out of range: "${raw}"`);
  }
  return value;
}

/**
 * Migration set integrity: every version must be a positive safe integer,
 * unique, and strictly ascending in array order — never relying on a caller
 * happening to sort correctly.
 */
function validateMigrations(migrations: readonly EpisodesMigration[]): void {
  let previous = 0;
  const seen = new Set<number>();
  for (const migration of migrations) {
    const v = migration.version;
    if (!Number.isSafeInteger(v) || v <= 0) {
      throw new Error(`migration version must be a positive integer, got ${String(v)}`);
    }
    if (seen.has(v)) {
      throw new Error(`duplicate migration version ${v}`);
    }
    if (v <= previous) {
      throw new Error(`migration versions must be strictly ascending; ${v} does not exceed ${previous}`);
    }
    seen.add(v);
    previous = v;
  }
}

/**
 * Owns the schema and version of one episodes.db file. Read/write query
 * surfaces belong to the reader and the rebuild flow (later tickets); this
 * class deliberately exposes only open/migrate/version/close so T01 is a
 * foundation, not a half-built pipeline.
 */
export class EpisodesProjectionDb {
  readonly db: DatabaseSync;
  private readonly migrations: readonly EpisodesMigration[];

  constructor(path: string, options?: { migrations?: readonly EpisodesMigration[] }) {
    this.migrations = options?.migrations ?? EPISODES_MIGRATIONS;
    if (path.trim().length === 0) {
      throw new Error("episodes.db path must not be blank/whitespace");
    }
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    try {
      if (path !== ":memory:") {
        this.db.exec("PRAGMA journal_mode=WAL");
        const integ = this.db.prepare("PRAGMA integrity_check").get() as {
          integrity_check: string;
        };
        if (integ.integrity_check !== "ok") {
          throw new Error(
            `episode projection failed its integrity check (${integ.integrity_check}); ` +
              `it will be rebuilt, chat is unaffected`,
          );
        }
      }
      this.migrate();
    } catch (error) {
      // Release the open SQLite handle before surfacing the failure, so a
      // corruption / migration / too-new error never leaves a dangling lock.
      try {
        this.db.close();
      } catch {
        // already closing / never fully opened — nothing more to do.
      }
      throw error;
    }
  }

  /** Applied schema version, held solely by meta.schema_version (0 if fresh). */
  get schemaVersion(): number {
    return this.readSchemaVersion();
  }

  private readSchemaVersion(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (row === undefined) return 0;
    return parseSchemaVersion(row.value);
  }

  private migrate(): void {
    // Reject a malformed migration set up front (positive, unique, strictly
    // ascending versions) rather than relying on caller ordering.
    validateMigrations(this.migrations);
    // The meta version table is created by the migrator (with a NOT NULL key),
    // so version bookkeeping never depends on a migration body creating it.
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    const current = this.readSchemaVersion();
    const supported = Math.max(0, ...this.migrations.map((m) => m.version));
    if (current > supported) {
      throw new EpisodesSchemaTooNewError(current, supported);
    }
    for (const migration of this.migrations) {
      if (migration.version <= current) {
        continue;
      }
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
              "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run(String(migration.version));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
