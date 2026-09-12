import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNodeArchivePort, nodeSnapshotPort } from "../adapters/platform/node-backup-io.js";
import { disposableDir } from "./t05b-backup-harness.js";

test("SQLite snapshots ignore stale partial files and publish only after integrity validation", () => {
  const root = disposableDir("sqlite-snapshot-boundary-");
  const source = join(root, "source.db");
  const destination = join(root, "backup", "snapshot.db");
  mkdirSync(join(root, "backup"), { recursive: true });

  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO sample (value) VALUES (?)").run("synthetic");
  db.close();

  // Old fixed-name partials, or unique partials left by a crashed process, are
  // incomplete attempts and must not make a clean retry look like a completed
  // destination.
  writeFileSync(destination + ".partial", "stale legacy partial\n");
  writeFileSync(destination + ".partial-999-deadbeef", "stale unique partial\n");

  const copied = nodeSnapshotPort.sqliteConsistentCopy(source, destination);
  assert.equal(copied.ok, true, JSON.stringify(copied));

  const restored = new DatabaseSync(destination, { readOnly: true });
  const row = restored.prepare("SELECT value FROM sample WHERE id = 1").get() as { value: string };
  assert.equal(row.value, "synthetic");
  const integrity = restored.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  assert.equal(integrity.integrity_check, "ok");
  restored.close();

  assert.equal(readFileSync(destination + ".partial", "utf8"), "stale legacy partial\n");
  assert.equal(readFileSync(destination + ".partial-999-deadbeef", "utf8"), "stale unique partial\n");
});

test("archive restore refuses a pre-existing symlink that would escape the destination root", () => {
  const root = disposableDir("restore-symlink-boundary-");
  const staging = join(root, "staging");
  const packagePath = join(root, "package.dlsbk");
  const keyPath = join(root, "key", "backup.key");
  const destination = join(root, "restore");
  const outside = join(root, "outside");

  mkdirSync(join(staging, "nested"), { recursive: true });
  mkdirSync(destination, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(staging, "nested", "payload.txt"), "synthetic restore payload\n");

  const archive = createNodeArchivePort(keyPath);
  const packed = archive.pack(staging, ["nested/payload.txt"], packagePath);
  assert.equal(packed.ok, true, packed.ok ? "" : packed.detail);

  symlinkSync(outside, join(destination, "nested"), "dir");
  const unpacked = archive.unpack(packagePath, destination);
  assert.equal(unpacked.ok, false, "restore must fail closed instead of following a symlink");
  assert.equal(unpacked.ok === false ? unpacked.failure : "", "entry_path_escapes_package");
  assert.equal(existsSync(join(outside, "payload.txt")), false, "no payload byte may be written outside the restore root");
});

test("archive restore refuses an already-existing final path instead of clobbering it", () => {
  const root = disposableDir("restore-no-clobber-");
  const staging = join(root, "staging");
  const packagePath = join(root, "package.dlsbk");
  const keyPath = join(root, "key", "backup.key");
  const destination = join(root, "restore");

  mkdirSync(staging, { recursive: true });
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(staging, "payload.txt"), "new payload\n");
  writeFileSync(join(destination, "payload.txt"), "existing payload\n");

  const archive = createNodeArchivePort(keyPath);
  const packed = archive.pack(staging, ["payload.txt"], packagePath);
  assert.equal(packed.ok, true, packed.ok ? "" : packed.detail);

  const unpacked = archive.unpack(packagePath, destination);
  assert.equal(unpacked.ok, false);
  assert.equal(unpacked.ok === false ? unpacked.failure : "", "destination_exists");
  assert.equal(readFileSync(join(destination, "payload.txt"), "utf8"), "existing payload\n");
});
