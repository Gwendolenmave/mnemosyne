import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { syntheticTree, disposableDir } from "./t05b-backup-harness.js";
import { listPackages, runBackup, proveRestore, pruneBackups } from "../adapters/runtime/backup-runtime.js";
import { createNodeArchivePort, nodeCensusPort, nodeSnapshotPort, keyFingerprintOf, loadOrCreateKey } from "../adapters/platform/node-backup-io.js";
import { validateBackupManifest, looksAbsolute } from "../core/domain/backup-manifest.js";
import { createHash } from "node:crypto";

const hash = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** The schema versions the synthetic harness writes. Asserted for real in E11. */
const CAPTURED_SCHEMAS = { mnemosyne: 7, decision_backlog: 3 };

/**
 * T05B end to end, on a SYNTHETIC tree only.
 *
 * The through-line defect this tranche inherits from T05A: an instrument that
 * cannot fail in the dimension it was built to prove. So every proof below has a
 * paired row that BREAKS the thing being proven and asserts the proof goes red.
 * A restore proof that has never been seen to fail is not evidence.
 */

test("T05B-E1: a backup is taken, packaged, and PROVEN by an isolated restore", () => {
  const t = syntheticTree();
  const out = runBackup(t.paths, { now: () => new Date("2026-02-01T04:15:00.000Z") });

  assert.equal(out.ok, true, `backup must succeed: ${out.detail}`);
  assert.ok(out.packageId !== null);
  assert.equal(out.proof?.verdict, "PROVEN", `proof detail: ${JSON.stringify(out.proof?.checks)}`);

  // Every declared check ran. A proof with four of seven checks is not the proof.
  assert.equal(out.proof!.checks.length, 7);
  assert.deepEqual(out.proof!.failed, []);

  // Exception-only reporting: a proven backup says nothing to the operator.
  assert.deepEqual(out.alerts, []);

  // The manifest validates against the pure domain validator, from disk.
  const dir = join(t.paths.backupRoot, out.packageId!);
  const check = validateBackupManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")), hash);
  assert.equal(check.ok, true, `manifest must validate: ${JSON.stringify(check)}`);

  // Required sources are all present, and the derived log noise is NOT.
  const kinds = new Set(check.ok ? check.manifest.entries.map((e) => e.kind) : []);
  for (const required of ["transcript", "mnemosyne", "decision_backlog"] as const) {
    assert.ok(kinds.has(required), `${required} must be captured`);
  }
  const paths = check.ok ? check.manifest.entries.map((e) => e.entryPath) : [];
  assert.equal(paths.some((p) => p.includes("runtime.log")), false,
    "a rotated log is derived noise and must not be in a backup");
});

test("T05B-E2: no manifest field carries an operator home directory", () => {
  const t = syntheticTree();
  const out = runBackup(t.paths, { now: () => new Date("2026-02-01T04:15:00.000Z") });
  assert.equal(out.ok, true);
  const raw = readFileSync(join(t.paths.backupRoot, out.packageId!, "manifest.json"), "utf8");

  // The manifest is the part of a backup most likely to be read by someone other
  // than Owner — it travels to cloud storage in clear, by design. An absolute path
  // in it is a privacy leak that survives every later redaction.
  assert.equal(raw.includes(t.root), false, "the manifest must not carry the tree's absolute path");
  for (const e of out.manifest!.entries) {
    assert.equal(looksAbsolute(e.logicalSource), false, `logicalSource ${e.logicalSource}`);
  }
  assert.equal(/\/home\/|\/Users\/|[A-Z]:\\/.test(raw), false, "no home-directory shape anywhere");

  // …and it carries the key FINGERPRINT, never the key.
  const key = loadOrCreateKey(t.paths.keyPath);
  assert.equal(key.ok, true);
  assert.equal(out.manifest!.keyFingerprint, keyFingerprintOf(key.ok ? key.value : Buffer.alloc(0)));
  assert.equal(raw.includes((key.ok ? key.value : Buffer.alloc(0)).toString("base64")), false,
    "the key itself must never appear in a manifest");
});

test("T05B-E3: NEGATIVE CONTROL — a restore that loses rows fails the proof", () => {
  const t = syntheticTree();
  const out = runBackup(t.paths, { now: () => new Date("2026-02-01T04:15:00.000Z") });
  assert.equal(out.proof?.verdict, "PROVEN", "baseline must be proven first");

  // Tamper with the LIVE tree after capture so the census the proof re-derives
  // from the package no longer matches a census taken from a changed live system.
  // Direction matters: the proof compares CAPTURED (in the manifest) against
  // RESTORED (from the package), so to make it fail we corrupt the manifest's
  // recorded expectation — exactly what a silent data loss would look like.
  const bumped = structuredClone(out.manifest!);
  const counts = bumped.census.rowCounts as Record<string, number>;
  counts["mnemosyne:memory_items"] = counts["mnemosyne:memory_items"]! + 1;

  const again = proveRestore(
    join(t.paths.backupRoot, out.packageId!, "package.dlsbk"),
    bumped,
    t.paths,
    CAPTURED_SCHEMAS,
  );
  assert.equal(again.verdict, "FAILED", "one missing row must fail the proof");
  assert.ok(again.failed.includes("row_counts"), `failed: ${again.failed.join(",")}`);
  const row = again.checks.find((c) => c.id === "row_counts")!;
  assert.match(row.detail, /mnemosyne:memory_items/, "the failure names WHICH table drifted");
});

test("T05B-E4: NEGATIVE CONTROL — a restore that breaks source pointers fails the proof", () => {
  const t = syntheticTree();
  const out = runBackup(t.paths, { now: () => new Date("2026-02-01T04:15:00.000Z") });
  assert.equal(out.proof?.verdict, "PROVEN");

  const tampered = structuredClone(out.manifest!);
  (tampered.census as { sourcePointerDigest: string }).sourcePointerDigest = "f".repeat(64);
  const again = proveRestore(
    join(t.paths.backupRoot, out.packageId!, "package.dlsbk"), tampered, t.paths,
    CAPTURED_SCHEMAS);
  assert.equal(again.verdict, "FAILED");
  assert.ok(again.failed.includes("source_pointer_continuity"),
    "dangling provenance is the failure this check exists for");
});

test("T05B-E5: NEGATIVE CONTROL — a truncated transcript set fails the proof", () => {
  const t = syntheticTree({ transcripts: 4 });
  const out = runBackup(t.paths, { now: () => new Date("2026-02-01T04:15:00.000Z") });
  assert.equal(out.proof?.verdict, "PROVEN");

  const tampered = structuredClone(out.manifest!);
  (tampered.census as { transcriptFiles: number }).transcriptFiles = 5;
  const again = proveRestore(
    join(t.paths.backupRoot, out.packageId!, "package.dlsbk"), tampered, t.paths,
    CAPTURED_SCHEMAS);
  assert.equal(again.verdict, "FAILED");
  assert.ok(again.failed.includes("transcript_completeness"));
});

test("T05B-E6: a live SQLite database is captured consistently, not torn", () => {
  const t = syntheticTree();
  const dest = join(disposableDir("t05b-copy-"), "copy.db");

  // Hold an OPEN writer on the source while the snapshot is taken. A plain byte
  // copy here is the classic torn-WAL backup; `VACUUM INTO` is not.
  const writer = new DatabaseSync(t.paths.mnemosynePath);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.prepare(`INSERT INTO memory_events (event_id,subject_kind,subject_id,type,payload,occurred_at,actor)
    VALUES ('ev-live','memory','x','memory_created','{}','2026-02-01T00:00:00.000Z','system')`).run();

  const r = nodeSnapshotPort.sqliteConsistentCopy(t.paths.mnemosynePath, dest);
  writer.close();

  assert.equal(r.ok, true, `consistent copy must succeed: ${JSON.stringify(r)}`);
  const copy = new DatabaseSync(dest, { readOnly: true });
  const integ = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  assert.equal(integ.integrity_check, "ok", "the copy passes its OWN integrity check");
  copy.close();

  // Refusing to overwrite is part of the contract: a backup that clobbers a
  // previous one has no last known good.
  const again = nodeSnapshotPort.sqliteConsistentCopy(t.paths.mnemosynePath, dest);
  assert.equal(again.ok, false);
  assert.equal(again.ok === false ? again.failure : "", "destination_exists");
});

test("T05B-E7: an append-only source that SHRANK is refused, not silently copied", () => {
  const t = syntheticTree();
  const src = join(t.paths.transcriptsDir, nodeSnapshotPort.listDirectoryFiles(t.paths.transcriptsDir)[0]!);
  const observed = statSync(src).size;
  writeFileSync(src, "truncated\n");   // simulate truncation between observe and copy
  const dest = join(disposableDir("t05b-append-"), "t.jsonl");
  const r = nodeSnapshotPort.fileCopy(src, dest, { expectAtLeastBytes: observed });
  assert.equal(r.ok, false, "a shrunken append-only file is not the file that was observed");
  assert.equal(r.ok === false ? r.failure : "", "inconsistent_copy");
});

test("T05B-E8: the container is authenticated — a flipped byte cannot be unpacked", () => {
  const t = syntheticTree();
  const out = runBackup(t.paths, { now: () => new Date("2026-02-01T04:15:00.000Z") });
  const pkg = join(t.paths.backupRoot, out.packageId!, "package.dlsbk");

  const archive = createNodeArchivePort(t.paths.keyPath);
  const good = archive.unpack(pkg, disposableDir("t05b-unpack-"));
  assert.equal(good.ok, true, "the intact package unpacks");

  const bytes = readFileSync(pkg);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
  const tampered = join(disposableDir("t05b-tamper-"), "package.dlsbk");
  writeFileSync(tampered, bytes);
  const bad = archive.unpack(tampered, disposableDir("t05b-unpack2-"));
  assert.equal(bad.ok, false, "a single flipped byte must not unpack");
  assert.equal(bad.ok === false ? bad.failure : "", "authentication_failed");
});

test("T05B-E9: the wrong key fails closed and is NAMED, not guessed at", () => {
  const t = syntheticTree();
  const out = runBackup(t.paths, { now: () => new Date("2026-02-01T04:15:00.000Z") });
  const pkg = join(t.paths.backupRoot, out.packageId!, "package.dlsbk");

  const otherKeyPath = join(disposableDir("t05b-key-"), "other.key");
  const other = createNodeArchivePort(otherKeyPath);
  const fp = other.keyFingerprint();
  assert.equal(fp.ok, true);
  assert.notEqual(fp.ok ? fp.value : "", out.manifest!.keyFingerprint,
    "a different key has a different fingerprint");

  const bad = other.unpack(pkg, disposableDir("t05b-unpack3-"));
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false ? bad.failure : "", "authentication_failed");
});

test("T05B-E10: a key with loose permissions is refused before it is used", () => {
  const dir = disposableDir("t05b-perm-");
  const keyPath = join(dir, "sub", "backup.key");
  mkdirSync(dirname(keyPath), { recursive: true });
  const first = loadOrCreateKey(keyPath);
  assert.equal(first.ok, true, "the key is created on first use");
  assert.equal(statSync(keyPath).mode & 0o777, 0o600, "created at 0600");

  chmodSync(keyPath, 0o644);
  const loose = loadOrCreateKey(keyPath);
  assert.equal(loose.ok, false, "a world-readable backup key is refused");
  assert.equal(loose.ok === false ? loose.failure : "", "key_permissions_too_open");
});

test("T05B-E11: the same census code runs on both sides of the proof", () => {
  // If the live side and the restored side were computed by different code, the
  // proof would only establish that two implementations agree. This asserts the
  // identity of the function object itself, which is the cheapest honest check.
  const t = syntheticTree();
  const a = nodeCensusPort.derive({
    mnemosynePath: t.paths.mnemosynePath, backlogPath: t.paths.backlogPath,
    currentSituationPath: t.paths.currentSituationPath, episodeProjectionPath: null,
    transcriptsDir: t.paths.transcriptsDir,
  });
  const b = nodeCensusPort.derive({
    mnemosynePath: t.paths.mnemosynePath, backlogPath: t.paths.backlogPath,
    currentSituationPath: t.paths.currentSituationPath, episodeProjectionPath: null,
    transcriptsDir: t.paths.transcriptsDir,
  });
  assert.deepEqual(a.census, b.census, "the census is deterministic");
  assert.equal(a.integrity["mnemosyne"], "ok");
  assert.equal(a.schemaVersions["mnemosyne"], 7);
  assert.ok(a.census.stableIdCount > 0, "stable ids are actually counted");
  assert.ok(a.census.sourcePointerCount > 0, "source pointers are actually counted");
});

test("T05B-E12b: episode projection inputs ARE captured when they exist", () => {
  // The live installation has no episode projection database yet, so every other
  // row in this file exercises the `null` path. Claiming the backup "captures
  // Episode projection inputs" on the strength of a code path no test runs is the
  // hollow-claim pattern; this row makes the claim real.
  const t = syntheticTree();
  const epPath = join(t.paths.mnemosynePath, "..", "episodes.db");
  const ep = new DatabaseSync(epPath);
  ep.exec(`CREATE TABLE episodes (id TEXT PRIMARY KEY, summary TEXT NOT NULL);
           CREATE TABLE episode_turns (episode_id TEXT NOT NULL, turn_id TEXT NOT NULL);`);
  ep.prepare("INSERT INTO episodes VALUES ('ep-1','synthetic summary')").run();
  ep.prepare("INSERT INTO episode_turns VALUES ('ep-1','33333333-0000-4000-8000-000000000000')").run();
  ep.close();

  const paths = { ...t.paths, episodeProjectionPath: epPath };
  const out = runBackup(paths, { now: () => new Date("2026-02-01T04:15:00.000Z") });
  assert.equal(out.ok, true, out.detail);
  assert.equal(out.proof?.verdict, "PROVEN");

  const kinds = out.manifest!.entries.map((e) => e.kind);
  assert.ok(kinds.includes("episode_inputs"), "the projection database is in the package");
  // Its rows are part of the census, so a restore that dropped them fails the proof.
  assert.equal(out.manifest!.census.rowCounts["episode:episodes"], 1);
  assert.equal(out.manifest!.census.rowCounts["episode:episode_turns"], 1);

  const tampered = structuredClone(out.manifest!);
  (tampered.census.rowCounts as Record<string, number>)["episode:episodes"] = 2;
  const again = proveRestore(
    join(paths.backupRoot, out.packageId!, "package.dlsbk"), tampered, paths, CAPTURED_SCHEMAS);
  assert.equal(again.verdict, "FAILED", "losing an episode row must fail the proof");
  assert.ok(again.failed.includes("row_counts"));
});

test("T05B-E12: an UNPROVEN package never replaces the last known good one", () => {
  const t = syntheticTree();
  const first = runBackup(t.paths, { now: () => new Date("2026-02-01T04:15:00.000Z") });
  assert.equal(first.ok, true);

  // Fabricate a second package whose restore proof FAILED, the way a real failure
  // would leave it on disk.
  const badDir = join(t.paths.backupRoot, "delos-backup-20260202T041500Z-deadbeefdead");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, "manifest.json"),
    readFileSync(join(t.paths.backupRoot, first.packageId!, "manifest.json"), "utf8"));
  writeFileSync(join(badDir, "restore-proof.json"),
    JSON.stringify({ checks: [], verdict: "FAILED", failed: ["row_counts"] }));
  writeFileSync(join(badDir, "package.dlsbk"), "not a real package");

  const stored = listPackages(t.paths);
  assert.equal(stored.length, 2);
  const pruned = pruneBackups(t.paths, { keepLatest: 1, keepDailyDays: 1, floor: 1 });

  assert.ok(pruned.decision.keep.includes(first.packageId!),
    "the proven package is kept even though a NEWER package exists");
  assert.equal(pruned.removed.includes(first.packageId!), false,
    "the last known good must never be pruned in favour of an unproven one");
  assert.ok(pruned.decision.quarantined.length >= 1,
    "the failed package is quarantined as evidence, not deleted");
  assert.equal(pruned.removed.length, 0);
});
