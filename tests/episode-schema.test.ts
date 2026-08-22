import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EPISODES_MIGRATIONS,
  EpisodesProjectionCorruptError,
  EpisodesProjectionDb,
  EpisodesSchemaTooNewError,
} from "../adapters/projections/sqlite/episodes-projection-db.js";
import type { DatabaseSync } from "node:sqlite";

/**
 * L1-T01 physical schema tests: the six §1.1.6 objects, column-for-column
 * (name/type/nullability/primary key), the version held solely by
 * meta.schema_version (NO migration_ledger), the composite-key
 * dual-assignment guard, FTS creation with no T01 write path, transactional
 * migration + rollback + newer-schema fail-closed, handle-release on error,
 * blank-path rejection, WAL, and the explicit-path / temp-only isolation.
 */

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "episodes-")), "episodes.db");
}

type ColSpec = [name: string, type: string, notnull: number, pk: number];

function columnsOf(db: DatabaseSync, table: string): ColSpec[] {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
  return rows.map((r) => [r.name, r.type, r.notnull, r.pk]);
}

const EPISODES: ColSpec[] = [
  ["episode_id", "TEXT", 1, 1],
  ["channel", "TEXT", 1, 0],
  ["thread", "TEXT", 1, 0],
  ["realm", "TEXT", 1, 0],
  ["realm_basis", "TEXT", 1, 0],
  ["au_id", "TEXT", 0, 0],
  ["domain", "TEXT", 1, 0],
  ["start_message_id", "TEXT", 1, 0],
  ["end_message_id", "TEXT", 1, 0],
  ["started_at_utc", "TEXT", 1, 0],
  ["ended_at_utc", "TEXT", 1, 0],
  ["started_at_local", "TEXT", 1, 0],
  ["ended_at_local", "TEXT", 1, 0],
  ["participants", "TEXT", 1, 0],
  ["initiator", "TEXT", 1, 0],
  ["title", "TEXT", 1, 0],
  ["entities_lexical", "TEXT", 1, 0],
  ["status", "TEXT", 1, 0],
  ["continuation_links", "TEXT", 1, 0],
  ["has_continuation", "INTEGER", 1, 0],
  ["source_hash", "TEXT", 1, 0],
  ["index_version", "TEXT", 1, 0],
  ["summary_version", "TEXT", 1, 0],
  ["confidence", "REAL", 1, 0],
  ["sensitivity", "TEXT", 1, 0],
  ["generated_payload", "TEXT", 0, 0],
  ["generated_pending_reason", "TEXT", 0, 0],
  ["generated_pending_detail", "TEXT", 0, 0],
  ["published_payload", "TEXT", 0, 0],
  ["overrides_applied_ids", "TEXT", 1, 0],
  ["message_count", "INTEGER", 1, 0],
  ["proactive_count", "INTEGER", 1, 0],
];

const EPISODE_MESSAGES: ColSpec[] = [
  ["conversation_id", "TEXT", 1, 1],
  ["message_id", "TEXT", 1, 2],
  ["episode_id", "TEXT", 1, 0],
  ["seq", "INTEGER", 1, 0],
];

const HISTORY_PAYLOADS: ColSpec[] = [
  ["episode_id", "TEXT", 1, 1],
  ["seq", "INTEGER", 1, 2],
  ["payload", "TEXT", 1, 0],
  ["superseded_reason", "TEXT", 1, 0],
  ["superseded_at", "TEXT", 1, 0],
];

const OVERRIDES_APPLIED: ColSpec[] = [
  ["override_id", "TEXT", 1, 1],
  ["kind", "TEXT", 1, 0],
  ["op", "TEXT", 1, 0],
  ["target", "TEXT", 1, 0],
  ["state", "TEXT", 1, 0],
  ["detail", "TEXT", 0, 0],
];

// meta.key carries an explicit NOT NULL constraint (notnull = 1).
const META: ColSpec[] = [
  ["key", "TEXT", 1, 1],
  ["value", "TEXT", 1, 0],
];

test("episodes / episode_messages / history_payloads / overrides_applied / meta match §1.1.6 column-for-column", () => {
  const db = new EpisodesProjectionDb(":memory:");
  assert.deepEqual(columnsOf(db.db, "episodes"), EPISODES);
  assert.deepEqual(columnsOf(db.db, "episode_messages"), EPISODE_MESSAGES);
  assert.deepEqual(columnsOf(db.db, "history_payloads"), HISTORY_PAYLOADS);
  assert.deepEqual(columnsOf(db.db, "overrides_applied"), OVERRIDES_APPLIED);
  assert.deepEqual(columnsOf(db.db, "meta"), META);
  db.close();
});

test("all six §1.1.6 objects exist, meta.schema_version = 1, and NO migration_ledger table", () => {
  const db = new EpisodesProjectionDb(":memory:");
  const present = new Set(
    (db.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{
      name: string;
    }>).map((r) => r.name),
  );
  for (const name of [
    "episodes",
    "episode_messages",
    "history_payloads",
    "episodes_fts",
    "overrides_applied",
    "meta",
  ]) {
    assert.ok(present.has(name), `missing object: ${name}`);
  }
  // The seventh ledger table is gone; the version lives solely in meta.
  assert.equal(present.has("migration_ledger"), false, "migration_ledger must not exist");
  const version = db.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string;
  };
  assert.equal(version.value, "1");
  assert.equal(db.schemaVersion, 1);
  db.close();
});

test("composite PK (conversation_id, message_id) forbids dual assignment", () => {
  const db = new EpisodesProjectionDb(":memory:");
  const insert = db.db.prepare(
    "INSERT INTO episode_messages (conversation_id, message_id, episode_id, seq) VALUES (?, ?, ?, ?)",
  );
  insert.run("c-20990101-0002", "m-000481", `ep-${"a".repeat(32)}`, 0);
  assert.throws(
    () => insert.run("c-20990101-0002", "m-000481", `ep-${"b".repeat(32)}`, 1),
    /UNIQUE|constraint|PRIMARY/i,
  );
  insert.run("c-20990101-0002", "m-000482", `ep-${"a".repeat(32)}`, 1);
  db.close();
});

test("episodes_fts is created over title/entities/summary and is empty (no T01 write path)", () => {
  const db = new EpisodesProjectionDb(":memory:");
  const count = db.db.prepare("SELECT count(*) AS c FROM episodes_fts").get() as { c: number };
  assert.equal(count.c, 0);
  const rows = db.db.prepare("SELECT title, entities, summary, episode_id FROM episodes_fts").all();
  assert.equal(rows.length, 0);
  db.close();
});

test("a failing migration rolls back atomically and leaves the database recoverable", () => {
  const path = tempDb();
  const bad = [
    { version: 1, description: "good part", sql: "CREATE TABLE ok_table (id TEXT);" },
    { version: 2, description: "broken", sql: "CREATE TABLE broken (id TEXT); THIS IS NOT SQL;" },
  ];
  assert.throws(() => new EpisodesProjectionDb(path, { migrations: bad }));
  // Recovery: reopening with only the good migration succeeds (the refused
  // build also released its handle), and the broken table left no trace.
  const recovered = new EpisodesProjectionDb(path, { migrations: [bad[0]!] });
  assert.equal(recovered.schemaVersion, 1);
  const brokenTable = recovered.db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'broken'")
    .all();
  assert.equal(brokenTable.length, 0);
  recovered.close();
});

test("a projection newer than this build fails closed AND releases the handle", () => {
  const path = tempDb();
  const db = new EpisodesProjectionDb(path);
  db.db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
  db.close();
  // Default build (supports v1) refuses a v999 projection with a human error.
  assert.throws(
    () => new EpisodesProjectionDb(path),
    (error: unknown) =>
      error instanceof EpisodesSchemaTooNewError && /rebuilt, chat is unaffected/.test(error.message),
  );
  // The refused open released its SQLite handle: a build that supports v999
  // opens the very same file (a lingering lock would block this on Windows).
  const future = new EpisodesProjectionDb(path, {
    migrations: [...EPISODES_MIGRATIONS, { version: 999, description: "future noop", sql: "SELECT 1;" }],
  });
  assert.equal(future.schemaVersion, 999);
  future.close();
});

test("blank / whitespace-only paths are rejected before any file is opened", () => {
  assert.throws(() => new EpisodesProjectionDb(""), /must not be blank/);
  assert.throws(() => new EpisodesProjectionDb("   "), /must not be blank/);
});

test("a malformed schema_version fails closed as corrupt, never silently coerced (Errata 3)", () => {
  for (const bad of ["1garbage", "1.5", "-1", "99999999999999999999"]) {
    const path = tempDb();
    const db = new EpisodesProjectionDb(path);
    db.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(bad);
    db.close();
    assert.throws(
      () => new EpisodesProjectionDb(path),
      (error: unknown) => error instanceof EpisodesProjectionCorruptError,
      `schema_version "${bad}" must fail closed`,
    );
  }
});

test("injected migrations must be positive, unique, and strictly ascending (Errata 3)", () => {
  const good = { version: 1, description: "ok", sql: "CREATE TABLE t (id TEXT);" };
  assert.throws(
    () => new EpisodesProjectionDb(":memory:", { migrations: [good, { version: 1, description: "dup", sql: "SELECT 1;" }] }),
    /duplicate migration/,
  );
  assert.throws(
    () =>
      new EpisodesProjectionDb(":memory:", {
        migrations: [
          { version: 2, description: "b", sql: "SELECT 1;" },
          { version: 1, description: "a", sql: "SELECT 1;" },
        ],
      }),
    /strictly ascending/,
  );
  assert.throws(
    () => new EpisodesProjectionDb(":memory:", { migrations: [{ version: 0, description: "z", sql: "SELECT 1;" }] }),
    /positive integer/,
  );
});

test("file databases run in WAL journal mode", () => {
  const db = new EpisodesProjectionDb(tempDb());
  const mode = db.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(mode.journal_mode, "wal");
  db.close();
});

test("schema persists across close and reopen", () => {
  const path = tempDb();
  const first = new EpisodesProjectionDb(path);
  assert.equal(first.schemaVersion, 1);
  first.close();
  const second = new EpisodesProjectionDb(path);
  assert.equal(second.schemaVersion, 1);
  assert.deepEqual(columnsOf(second.db, "episodes"), EPISODES);
  second.close();
});

test("a corrupted database file fails closed", () => {
  const path = tempDb();
  writeFileSync(path, "this is not a sqlite database at all");
  assert.throws(() => new EpisodesProjectionDb(path));
});

// --- isolation evidence (boundary proof) -----------------------------------

test("constructor requires an explicit path (no live default) and writes only where injected", () => {
  assert.ok(EpisodesProjectionDb.length >= 1, "constructor must take a required path argument");
  const path = tempDb();
  const db = new EpisodesProjectionDb(path);
  assert.ok(existsSync(path), "database is created only at the injected temp path");
  db.close();
});

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("schema adapter CODE references no live path or Mnemosyne (comments stripped)", () => {
  const code = stripComments(
    readFileSync(join(process.cwd(), "adapters/projections/sqlite/episodes-projection-db.ts"), "utf8"),
  );
  for (const forbidden of ["delos-memory", "data/transcripts", "data/projections", "data/memory"]) {
    assert.ok(!code.includes(forbidden), `adapter code must not reference "${forbidden}"`);
  }
});
