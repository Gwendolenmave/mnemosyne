import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNodeArchivePort } from "../adapters/platform/node-backup-io.js";
import { disposableDir } from "./t05b-backup-harness.js";

test("archive packing is not wedged by stale partial files from an interrupted attempt", () => {
  const root = disposableDir("backup-partial-retry-");
  const staging = join(root, "staging");
  const output = join(root, "backup", "package.dlsbk");
  const keyPath = join(root, "keys", "backup.key");
  mkdirSync(staging, { recursive: true });
  mkdirSync(join(root, "backup"), { recursive: true });
  writeFileSync(join(staging, "payload.txt"), "synthetic backup payload\n");

  // Older implementations used the fixed `${destination}.partial` name. A
  // process crash could leave that file behind and every retry would fail its
  // exclusive create before doing useful work. Orphaned unique partials from a
  // newer crashed process must likewise be harmless to a fresh attempt.
  writeFileSync(output + ".partial", "stale legacy partial\n");
  writeFileSync(output + ".partial-123-deadbeef", "stale unique partial\n");

  const archive = createNodeArchivePort(keyPath);
  const packed = archive.pack(staging, ["payload.txt"], output);
  assert.equal(packed.ok, true, packed.ok ? "" : packed.detail);

  const restored = join(root, "restored");
  const unpacked = archive.unpack(output, restored);
  assert.equal(unpacked.ok, true, unpacked.ok ? "" : unpacked.detail);
  assert.equal(readFileSync(join(restored, "payload.txt"), "utf8"), "synthetic backup payload\n");

  // The retry must not need to delete unrelated leftovers in order to succeed.
  assert.equal(readFileSync(output + ".partial", "utf8"), "stale legacy partial\n");
  assert.equal(readFileSync(output + ".partial-123-deadbeef", "utf8"), "stale unique partial\n");
});
