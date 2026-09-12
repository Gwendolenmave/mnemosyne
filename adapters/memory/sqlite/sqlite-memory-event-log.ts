/**
 * Mnemosyne canonical container: one local SQLite file holding the
 * append-only memory event stream (kernel vocabulary), the Mnemosyne
 * governance/prior event overlays, and rebuildable projections.
 *
 * This adapter implements the transplanted MemoryEventLog contract for the
 * kernel stream and owns schema migrations, integrity self-checks, and the
 * controlled backup path (VACUUM INTO; live file copying is rejected by
 * design — M1.1a deliverable 5).
 *
 * Storage discipline (M1.1a): memory_events is the ONLY authoritative
 * truth. memory_items / memory_tags / priors_current / fts_items are
 * fold-derived materializations and may be dropped and rebuilt at any
 * time. Migration failures roll back atomically; a database newer than
 * this build disables memory cleanly instead of guessing.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryEventEnvelope } from "../../../core/domain/memory.js";
import { validateMemoryEventStream } from "../../../core/domain/memory-validation.js";
import type {
  MemoryEventLog,
  MemoryEventLogAppendOutcome,
  MemoryEventLogAppendToEmptyOutcome,
} from "../../../core/ports/memory-event-log.js";

export const MNEMOSYNE_SCHEMA_VERSION = 1;

export interface MnemosyneMigration {
  version: number;
  description: string;
  sql: string;
}

/**
 * Schema v1 — the full M1.1a container; v2 adds the workflow-provenance
 * column (three-paths directive: minimal additive migration; NULL =
 * legacy/unknown, never backfilled). Applied atomically in order.
 */
export const MNEMOSYNE_MIGRATIONS: readonly MnemosyneMigration[] = [
  {
    version: 1,
    description: "mnemosyne canonical container v1 (events, projections, fts, provenance)",
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE memory_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL UNIQUE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('memory','governance','prior')),
  subject_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  actor        TEXT NOT NULL
);
CREATE INDEX idx_events_subject ON memory_events(subject_kind, subject_id);

CREATE TABLE memory_items (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  scope           TEXT NOT NULL,
  au_id           TEXT,
  sensitivity     TEXT NOT NULL,
  importance      INTEGER NOT NULL,
  approval_state  TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  seal_state      TEXT NOT NULL,
  confirmed_by    TEXT,
  retrieval       TEXT NOT NULL,
  supersedes      TEXT,
  source_basis    TEXT,
  tags_text       TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  expires_at      TEXT
);

CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);

CREATE TABLE priors_current (
  key         TEXT PRIMARY KEY,
  version     INTEGER NOT NULL,
  body        TEXT NOT NULL,
  token_est   INTEGER NOT NULL,
  approved_by TEXT NOT NULL,
  changelog   TEXT NOT NULL,
  expires_at  TEXT
);

CREATE TABLE sources (
  id           TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('memory','prior','fragment')),
  subject_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  pointer      TEXT NOT NULL,
  note         TEXT
);
CREATE INDEX idx_sources_subject ON sources(subject_kind, subject_id);

CREATE TABLE fragments (
  id         TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  source_id  TEXT
);

CREATE VIRTUAL TABLE fts_items USING fts5(
  item_id UNINDEXED, title_seg, body_seg, tags_seg, tokenize='unicode61'
);
`,
  },
  {
    version: 2,
    description: "memory_items.provenance column (three-paths workflow roles; NULL = legacy)",
    sql: `ALTER TABLE memory_items ADD COLUMN provenance TEXT;`,
  },
];

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface SqliteBackupReport {
  path: string;
  integrity: string;
  schemaVersion: number;
}

/** Human-language failure used when the on-disk schema is ahead of the code. */
export class MemorySchemaTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `memory database is from a newer Delos (schema v${found} > v${supported}); ` +
        `memory stays off this run, chat is unaffected`,
    );
    this.name = "MemorySchemaTooNewError";
  }
}

export class SqliteMemoryEventLog implements MemoryEventLog {
  readonly transport: string;
  readonly db: DatabaseSync;
  private readonly migrations: readonly MnemosyneMigration[];

  constructor(path: string, options?: { migrations?: readonly MnemosyneMigration[] }) {
    this.migrations = options?.migrations ?? MNEMOSYNE_MIGRATIONS;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.transport = `sqlite ${path}`;
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode=WAL");
      const integ = this.db.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      if (integ.integrity_check !== "ok") {
        throw new Error(
          `memory database failed its integrity check (${integ.integrity_check}); ` +
            `memory stays off this run, chat is unaffected`,
        );
      }
    }
    this.migrate();
  }

  /** Applied schema version from the ledger (0 for a fresh database). */
  get schemaVersion(): number {
    const rows = this.db.prepare("SELECT version FROM migration_ledger").all() as Array<{
      version: number;
    }>;
    return rows.reduce((max, row) => Math.max(max, row.version), 0);
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migration_ledger (" +
        "version INTEGER PRIMARY KEY, description TEXT NOT NULL, " +
        "applied_at TEXT NOT NULL, checksum TEXT NOT NULL)",
    );
    const applied = new Set(
      (this.db.prepare("SELECT version FROM migration_ledger").all() as Array<{ version: number }>).map(
        (row) => row.version,
      ),
    );
    const newest = Math.max(0, ...applied);
    const supported = Math.max(0, ...this.migrations.map((m) => m.version));
    if (newest > supported) {
      throw new MemorySchemaTooNewError(newest, supported);
    }
    for (const migration of this.migrations) {
      if (applied.has(migration.version)) {
        continue;
      }
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare(
            "INSERT INTO migration_ledger (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)",
          )
          .run(migration.version, migration.description, new Date().toISOString(), sha256Hex(migration.sql));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Kernel MemoryEventLog contract (subject_kind = 'memory')
  // -------------------------------------------------------------------------

  private readKernelRows(): MemoryEventEnvelope[] {
    const rows = this.db
      .prepare("SELECT payload FROM memory_events WHERE subject_kind = 'memory' ORDER BY seq")
      .all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as MemoryEventEnvelope);
  }

  async readAll(): Promise<MemoryEventEnvelope[]> {
    return this.readKernelRows();
  }

  async append(
    envelopes: readonly MemoryEventEnvelope[],
  ): Promise<MemoryEventLogAppendOutcome> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.readKernelRows();
      const result = validateMemoryEventStream([...existing, ...envelopes]);
      if (!result.ok) {
        this.db.exec("ROLLBACK");
        return { status: "rejected", issues: result.issues };
      }
      this.insertKernelTail(result.value.slice(existing.length));
      this.db.exec("COMMIT");
      return { status: "appended", count: envelopes.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async appendToEmpty(
    envelopes: readonly MemoryEventEnvelope[],
  ): Promise<MemoryEventLogAppendToEmptyOutcome> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = validateMemoryEventStream(envelopes);
      if (!result.ok) {
        this.db.exec("ROLLBACK");
        return { status: "rejected", issues: result.issues };
      }
      const count = (
        this.db
          .prepare("SELECT count(*) AS c FROM memory_events WHERE subject_kind = 'memory'")
          .get() as { c: number }
      ).c;
      if (count > 0) {
        this.db.exec("ROLLBACK");
        return { status: "not-empty", existingCount: count };
      }
      this.insertKernelTail(result.value);
      this.db.exec("COMMIT");
      return { status: "appended", count: envelopes.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertKernelTail(tail: readonly MemoryEventEnvelope[]): void {
    const insert = this.db.prepare(
      "INSERT INTO memory_events (event_id, subject_kind, subject_id, type, payload, occurred_at, actor) " +
        "VALUES (?, 'memory', ?, ?, ?, ?, 'system')",
    );
    for (const envelope of tail) {
      insert.run(
        envelope.eventId,
        envelope.event.memoryId,
        envelope.event.type,
        JSON.stringify(envelope),
        envelope.occurredAt,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Controlled backup (acceptance #4): refuse overwrite, validate copy.
  // -------------------------------------------------------------------------

  backupTo(destinationPath: string): SqliteBackupReport {
    if (existsSync(destinationPath)) {
      throw new Error(`refusing to overwrite an existing backup file: ${destinationPath}`);
    }
    this.db.prepare("VACUUM INTO ?").run(destinationPath);
    const copy = new DatabaseSync(destinationPath);
    try {
      const integ = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check;
      if (integ !== "ok") {
        throw new Error(`backup failed its integrity check (${integ}); do not trust ${destinationPath}`);
      }
      const version = (
        copy.prepare("SELECT max(version) AS v FROM migration_ledger").get() as { v: number | null }
      ).v;
      if (version !== this.schemaVersion) {
        throw new Error(
          `backup schema v${String(version)} does not match live schema v${this.schemaVersion}`,
        );
      }
      return { path: destinationPath, integrity: integ, schemaVersion: version ?? 0 };
    } finally {
      copy.close();
    }
  }

  close(): void {
    this.db.close();
  }
}
