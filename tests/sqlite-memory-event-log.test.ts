import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MNEMOSYNE_MIGRATIONS,
  MemorySchemaTooNewError,
  SqliteMemoryEventLog,
} from "../adapters/memory/sqlite/sqlite-memory-event-log.js";
import { memoryEventLogContract, env, created, expectAppended } from "./memory-log-contract.js";

/**
 * M2-1 storage tests: the transplanted port contract runs verbatim against
 * the SQLite adapter, plus file persistence, migration ledger + rollback,
 * newer-schema guard, WAL, and controlled backup semantics (Companion
 * acceptance #4: refuse overwrite, auto-validate integrity + schema).
 */

// The full behavioral yardstick, unchanged, against SQLite (in-memory DB).
memoryEventLogContract("sqlite(:memory:)", () => new SqliteMemoryEventLog(":memory:"));

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mnemosyne-")), "delos-memory.db");
}

test("sqlite: events persist across close and reopen", async () => {
  const path = tempDb();
  const first = new SqliteMemoryEventLog(path);
  const envelope = env(created(randomUUID()));
  await expectAppended(first, [envelope]);
  first.close();
  const second = new SqliteMemoryEventLog(path);
  assert.deepEqual(await second.readAll(), [envelope]);
  second.close();
});

test("sqlite: migration ledger records version, checksum, and description", () => {
  const log = new SqliteMemoryEventLog(":memory:");
  const rows = log.db
    .prepare("SELECT version, description, checksum FROM migration_ledger ORDER BY version")
    .all() as Array<{ version: number; description: string; checksum: string }>;
  assert.equal(rows.length, MNEMOSYNE_MIGRATIONS.length);
  assert.equal(rows[0]!.version, 1);
  assert.equal(rows[0]!.checksum.length, 64);
  // v2 = the three-paths provenance column migration.
  assert.equal(log.schemaVersion, 2);
  log.close();
});

test("sqlite: a failing migration rolls back atomically and leaves the database recoverable", () => {
  const path = tempDb();
  const bad = [
    { version: 1, description: "good part", sql: "CREATE TABLE ok_table (id TEXT);" },
    { version: 2, description: "broken", sql: "CREATE TABLE broken (id TEXT); THIS IS NOT SQL;" },
  ];
  assert.throws(() => new SqliteMemoryEventLog(path, { migrations: bad }));
  // Recovery: reopening with only the good migration succeeds; the broken
  // migration left no ledger row and no partial tables.
  const recovered = new SqliteMemoryEventLog(path, { migrations: [bad[0]!] });
  assert.equal(recovered.schemaVersion, 1);
  const brokenTable = recovered.db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'broken'")
    .all();
  assert.equal(brokenTable.length, 0);
  recovered.close();
});

test("sqlite: a database newer than this build disables memory with a human-language error", () => {
  const path = tempDb();
  const log = new SqliteMemoryEventLog(path);
  log.db
    .prepare(
      "INSERT INTO migration_ledger (version, description, applied_at, checksum) VALUES (999, 'future', 'now', 'x')",
    )
    .run();
  log.close();
  assert.throws(
    () => new SqliteMemoryEventLog(path),
    (error: unknown) =>
      error instanceof MemorySchemaTooNewError && /memory stays off/.test(error.message),
  );
});

test("sqlite: file databases run in WAL journal mode", () => {
  const log = new SqliteMemoryEventLog(tempDb());
  const mode = log.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(mode.journal_mode, "wal");
  log.close();
});

test("sqlite backup: refuses to overwrite an existing file", async () => {
  const log = new SqliteMemoryEventLog(tempDb());
  const dest = tempDb();
  writeFileSync(dest, "already here");
  assert.throws(() => log.backupTo(dest), /refusing to overwrite/);
  log.close();
});

test("sqlite backup: produces a validated, restorable snapshot", async () => {
  const path = tempDb();
  const log = new SqliteMemoryEventLog(path);
  const envelopes = [env(created(randomUUID())), env(created(randomUUID()))];
  await expectAppended(log, envelopes);
  const dest = join(mkdtempSync(join(tmpdir(), "mnemosyne-bak-")), "backup.db");
  const report = log.backupTo(dest);
  assert.equal(report.integrity, "ok");
  assert.equal(report.schemaVersion, log.schemaVersion);
  log.close();
  // Restore = open the backup file as the live database.
  const restored = new SqliteMemoryEventLog(dest);
  assert.deepEqual(await restored.readAll(), envelopes);
  restored.close();
});

test("sqlite: corrupted database file fails closed with a human-language error", () => {
  const dir = mkdtempSync(join(tmpdir(), "mnemosyne-corrupt-"));
  const path = join(dir, "delos-memory.db");
  writeFileSync(path, "this is not a sqlite database at all");
  assert.throws(() => new SqliteMemoryEventLog(path));
});
