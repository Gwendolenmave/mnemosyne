import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeReadOnlyFs } from "../adapters/platform/node-filesystem.js";
import { resolveRepoRootByLandmark } from "../adapters/config/platform-root-adapters.js";
import {
  alertsFor, DEFAULT_RETENTION, evaluateRestoreProof, RESTORE_CHECK_IDS,
  selectRetention, type PackageRecord,
} from "../core/services/backup-core.js";
import {
  BACKUP_MANIFEST_SCHEMA, censusDigest, inventoryDigest, packageIdentity,
  REQUIRED_SOURCE_KINDS, validateBackupManifest, type BackupEntry, type ContinuityCensus,
} from "../core/domain/backup-manifest.js";
import {
  assertPurgeExecutable, planForget, planHardPurge, PURGE_REGISTRIES, READ_PATHS,
} from "../core/services/deletion-core.js";
import { BACKUP_JOB, systemdUserTimerUnits, toOnCalendar } from "../adapters/platform/systemd-scheduler.js";

const hash = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const CODE = resolveRepoRootByLandmark(nodeReadOnlyFs, dirname(fileURLToPath(import.meta.url)));

const CENSUS: ContinuityCensus = {
  rowCounts: { "mnemosyne:memory_items": 6, "backlog:backlog_items": 11 },
  chainHeads: { "mnemosyne:memory_events": "6/ev-5", "backlog:receipts": "11" },
  stableIdDigest: "a".repeat(64),
  stableIdCount: 17,
  sourcePointerDigest: "b".repeat(64),
  sourcePointerCount: 17,
  transcriptFiles: 3,
  transcriptBytes: 900,
};

const SCHEMAS = { mnemosyne: 7, decision_backlog: 3 };

function observed(overrides?: Partial<{
  integrity: Record<string, string>;
  schemaVersions: Record<string, number>;
  census: ContinuityCensus;
}>): Parameters<typeof evaluateRestoreProof>[2] {
  return {
    integrity: overrides?.integrity ?? { mnemosyne: "ok", decision_backlog: "ok" },
    schemaVersions: overrides?.schemaVersions ?? SCHEMAS,
    census: overrides?.census ?? CENSUS,
  };
}

// ---------------------------------------------------------------------------
// Restore proof: each check must be individually falsifiable
// ---------------------------------------------------------------------------

test("T05B-P1: the whole proof passes when everything matches", () => {
  const p = evaluateRestoreProof(CENSUS, SCHEMAS, observed());
  assert.equal(p.verdict, "PROVEN");
  assert.equal(p.checks.length, RESTORE_CHECK_IDS.length,
    "every declared check appears in the result");
  assert.deepEqual([...p.checks].map((c) => c.id).sort(), [...RESTORE_CHECK_IDS].sort());
  for (const c of p.checks) {
    assert.notEqual(c.detail, "", `${c.id} must carry a detail even when it passes`);
  }
});

test("T05B-P2: EVERY check can be made to fail on its own", () => {
  // The point of this row: a proof where some check is structurally unable to fail
  // is the exact defect T05A spent ten rounds removing. Each entry below breaks
  // one property and asserts THAT check — and only that check — goes red.
  const cases: Array<[typeof RESTORE_CHECK_IDS[number], () => ReturnType<typeof evaluateRestoreProof>]> = [
    ["database_integrity", () =>
      evaluateRestoreProof(CENSUS, SCHEMAS, observed({ integrity: { mnemosyne: "row 3 missing" } }))],
    ["schema_version", () =>
      evaluateRestoreProof(CENSUS, SCHEMAS, observed({ schemaVersions: { mnemosyne: 6, decision_backlog: 3 } }))],
    ["row_counts", () =>
      evaluateRestoreProof(CENSUS, SCHEMAS, observed({
        census: { ...CENSUS, rowCounts: { ...CENSUS.rowCounts, "mnemosyne:memory_items": 5 } } }))],
    ["event_chain_continuity", () =>
      evaluateRestoreProof(CENSUS, SCHEMAS, observed({
        census: { ...CENSUS, chainHeads: { ...CENSUS.chainHeads, "backlog:receipts": "10" } } }))],
    ["stable_identifiers", () =>
      evaluateRestoreProof(CENSUS, SCHEMAS, observed({
        census: { ...CENSUS, stableIdDigest: "c".repeat(64) } }))],
    ["source_pointer_continuity", () =>
      evaluateRestoreProof(CENSUS, SCHEMAS, observed({
        census: { ...CENSUS, sourcePointerCount: 16 } }))],
    ["transcript_completeness", () =>
      evaluateRestoreProof(CENSUS, SCHEMAS, observed({
        census: { ...CENSUS, transcriptBytes: 899 } }))],
  ];
  assert.equal(cases.length, RESTORE_CHECK_IDS.length,
    "there is a falsifying case for every declared check");
  for (const [id, run] of cases) {
    const p = run();
    assert.equal(p.verdict, "FAILED", `${id} must be able to fail`);
    assert.deepEqual(p.failed, [id], `only ${id} should fail; got ${p.failed.join(",")}`);
  }
});

test("T05B-P3: an EMPTY observation is a failure, not a vacuous pass", () => {
  // The most dangerous hollow proof: nothing was checked, so nothing disagreed.
  const p = evaluateRestoreProof(
    { ...CENSUS, rowCounts: {}, chainHeads: {} },
    {},
    observed({ integrity: {}, schemaVersions: {}, census: { ...CENSUS, rowCounts: {}, chainHeads: {} } }),
  );
  assert.equal(p.verdict, "FAILED");
  for (const id of ["database_integrity", "schema_version", "row_counts", "event_chain_continuity"] as const) {
    assert.ok(p.failed.includes(id), `${id} must fail when nothing was observed`);
    assert.match(p.checks.find((c) => c.id === id)!.detail, /no |not a pass|nothing to compare/,
      `${id} must say WHY an empty set is not a pass`);
  }
});

test("T05B-P4: a database that vanished on restore fails rather than being skipped", () => {
  const p = evaluateRestoreProof(CENSUS, SCHEMAS, observed({ schemaVersions: { mnemosyne: 7 } }));
  assert.equal(p.verdict, "FAILED");
  assert.ok(p.failed.includes("schema_version"));
  assert.match(p.checks.find((c) => c.id === "schema_version")!.detail, /decision_backlog/,
    "the missing database is named");
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

function pkg(id: string, day: string, proven: boolean): PackageRecord {
  return { packageId: id, createdAt: `2026-0${day}T04:15:00.000Z`, proven, bytes: 100 };
}

test("T05B-P5: retention never leaves zero good backups, whatever the arithmetic says", () => {
  const one = [pkg("a", "1-01", true)];
  const d = selectRetention(one, { keepLatest: 0, keepDailyDays: 0, floor: 0 });
  assert.deepEqual(d.prune, [], "keepLatest=0 must not prune the only good backup");
  assert.deepEqual(d.keep, ["a"]);
  assert.match(d.reason["a"]!, /last known good/);
});

test("T05B-P6: unproven packages are never pruned and never counted as good", () => {
  const records = [
    pkg("newest-bad", "1-05", false),
    pkg("good-2", "1-04", true),
    pkg("good-1", "1-03", true),
    pkg("old-good", "1-02", true),
  ];
  const d = selectRetention(records, { keepLatest: 1, keepDailyDays: 1, floor: 1 });
  assert.deepEqual(d.quarantined, ["newest-bad"]);
  assert.equal(d.prune.includes("newest-bad"), false, "a failure record is evidence, not garbage");
  assert.ok(d.keep.includes("good-2"), "the newest PROVEN package is the last known good");
  assert.match(d.reason["newest-bad"]!, /never counted as good/);
});

test("T05B-P7: the daily rule keeps one per day and the floor still binds", () => {
  const records = [
    pkg("d3-b", "1-03", true), pkg("d3-a", "1-03", true),
    pkg("d2-a", "1-02", true), pkg("d1-a", "1-01", true),
  ];
  const d = selectRetention(records, { keepLatest: 1, keepDailyDays: 2, floor: 3 });
  assert.ok(d.keep.includes("d3-b"), "newest overall");
  assert.ok(d.keep.includes("d2-a"), "newest of the previous day");
  assert.ok(d.keep.length >= 3, `the floor of 3 binds last: ${d.keep.join(",")}`);
  assert.equal(new Set(d.keep).size, d.keep.length, "no duplicates in keep");
  for (const id of d.prune) assert.equal(d.keep.includes(id), false, "keep and prune are disjoint");
});

test("T05B-P8: the default policy is a policy, not a deletion schedule", () => {
  assert.ok(DEFAULT_RETENTION.floor >= 2, "at least two good backups are always retained");
  assert.ok(DEFAULT_RETENTION.keepLatest >= 7);
  assert.ok(DEFAULT_RETENTION.keepDailyDays >= 30);
});

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

test("T05B-P9: a proven backup produces NO alert; each failure produces a named one", () => {
  assert.deepEqual(alertsFor({
    backupOk: true, proofVerdict: "PROVEN", proofFailed: [],
    lastProvenAgeHours: 0, maxProvenAgeHours: 26, keyAvailable: true, lastKnownGoodIntact: true,
  }), [], "silence is the success signal — the operator covenant");

  const failed = alertsFor({
    backupOk: true, proofVerdict: "FAILED", proofFailed: ["row_counts"],
    lastProvenAgeHours: 200, maxProvenAgeHours: 26, keyAvailable: true, lastKnownGoodIntact: true,
  });
  assert.deepEqual(failed.map((a) => a.kind), ["restore_proof_failed", "no_recent_proven_backup"]);
  assert.match(failed[0]!.detail, /row_counts/, "the alert names which continuity broke");

  const noKey = alertsFor({
    backupOk: false, proofVerdict: "NOT_RUN", proofFailed: [],
    lastProvenAgeHours: null, maxProvenAgeHours: 26, keyAvailable: false, lastKnownGoodIntact: false,
  });
  assert.deepEqual(noKey.map((a) => a.kind),
    ["key_unavailable", "backup_failed", "no_recent_proven_backup"]);
  // "and your previous backup is gone" is a different emergency and is never
  // collapsed into the first message.
  assert.ok(noKey.every((a) => a.lastKnownGoodIntact === false));
});

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

function entry(over?: Partial<BackupEntry>): BackupEntry {
  return {
    entryPath: "db/mnemosyne.db", kind: "mnemosyne", method: "sqlite_consistent_copy",
    bytes: 10, sha256: "d".repeat(64), logicalSource: "mnemosyne", ...over,
  };
}

function manifestOf(entries: readonly BackupEntry[]): Record<string, unknown> {
  return {
    schema: BACKUP_MANIFEST_SCHEMA, manifestVersion: 1,
    packageId: "delos-backup-20260201T041500Z-abcdefabcdef",
    createdAt: "2026-02-01T04:15:00.000Z", installationId: "synthetic",
    sourceSurfaceId: null, entries, inventoryId: inventoryDigest(entries, hash),
    census: CENSUS, encryption: "aes-256-gcm", keyFingerprint: "e".repeat(64), plaintextBytes: 10,
  };
}

test("T05B-P10: a manifest missing a required source is refused", () => {
  const only = [entry()];
  const r = validateBackupManifest(manifestOf(only), hash);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.refusal : "", "manifest_missing_required_source");
  assert.ok(REQUIRED_SOURCE_KINDS.includes((r.ok === false ? r.detail : "") as never));
});

test("T05B-P11: an absolute logicalSource is refused as a privacy leak", () => {
  const bad = [
    entry(),
    entry({ entryPath: "transcripts/a.jsonl", kind: "transcript", method: "append_only_copy",
      logicalSource: "/srv/mnemosyne-production/data/transcripts/a.jsonl" }),
    entry({ entryPath: "db/backlog.db", kind: "decision_backlog", logicalSource: "decision_backlog" }),
  ];
  const r = validateBackupManifest(manifestOf(bad), hash);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.refusal : "", "manifest_absolute_path_leak");
});

test("T05B-P12: an escaping entry path is refused", () => {
  const bad = [entry({ entryPath: "../../etc/passwd" })];
  const r = validateBackupManifest(manifestOf(bad), hash);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.refusal : "", "manifest_entry_path_escapes_package");
});

test("T05B-P13: a forged entry array fails the inventory identity", () => {
  const good = [
    entry(),
    entry({ entryPath: "transcripts/a.jsonl", kind: "transcript", method: "append_only_copy",
      logicalSource: "transcripts/a.jsonl" }),
    entry({ entryPath: "db/backlog.db", kind: "decision_backlog", logicalSource: "decision_backlog" }),
  ];
  const m = manifestOf(good);
  assert.equal(validateBackupManifest(m, hash).ok, true, "the honest manifest validates");

  // Swap one hash while keeping the recorded inventoryId: the recomputation catches it.
  const forged = { ...m, entries: [{ ...good[0]!, sha256: "0".repeat(64) }, good[1]!, good[2]!] };
  const r = validateBackupManifest(forged, hash);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.refusal : "", "manifest_inventory_identity_mismatch");
});

test("T05B-P14: the package identity binds the inventory to the census", () => {
  const entries = [entry()];
  const a = packageIdentity(entries, CENSUS, hash);
  const b = packageIdentity(entries, { ...CENSUS, stableIdCount: CENSUS.stableIdCount + 1 }, hash);
  assert.notEqual(a, b, "same files, different continuity facts, different package");
  assert.notEqual(censusDigest(CENSUS, hash),
    censusDigest({ ...CENSUS, transcriptBytes: 901 }, hash));
  // Key order in the census objects must not change the digest.
  const reordered: ContinuityCensus = {
    ...CENSUS,
    rowCounts: { "backlog:backlog_items": 11, "mnemosyne:memory_items": 6 },
  };
  assert.equal(censusDigest(CENSUS, hash), censusDigest(reordered, hash),
    "the digest is canonical, not JSON-order dependent");
});

// ---------------------------------------------------------------------------
// Deletion: forget vs hard purge (LM-GATE-01 amendment C)
// ---------------------------------------------------------------------------

test("T05B-P15: a forget suppresses EVERY read path and destroys no bytes", () => {
  const p = planForget("00000000-0000-4000-8000-000000000001", "owner asked");
  assert.equal(p.bytesDestroyed, 0);
  assert.deepEqual([...p.suppressedReadPaths].sort(), [...READ_PATHS].sort(),
    "a forget that misses one read path leaves the memory reachable there");
  assert.ok(p.events.length >= 2, "the forgetting is itself recorded; history only grows");
});

test("T05B-P16: a purge plan that never looked in the backups is INCOMPLETE", () => {
  const partial = planHardPurge("subject-1", {
    mnemosyne_items: [{ locator: "row", occurrences: 1 }],
    mnemosyne_event_log: [], mnemosyne_fts_projection: [], decision_backlog: [],
    decision_receipts: [], episode_projection: [], transcript_files: [],
    quarantine_root: [], receipt_root: [],
    // backup_packages deliberately absent
  });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.uncheckedRegistries, ["backup_packages"],
    "the copy a naive purge misses, which resurrects the data on the next restore");

  const full = planHardPurge("subject-1",
    Object.fromEntries(PURGE_REGISTRIES.map((r) => [r, []])));
  assert.equal(full.complete, true);
  assert.deepEqual(full.uncheckedRegistries, []);
  assert.equal(full.emptyRegistries.length, PURGE_REGISTRIES.length,
    "absent is recorded distinctly from unchecked");
});

test("T05B-P17: the purge guard refuses owner-real data under this programme", () => {
  const plan = planHardPurge("subject-1", Object.fromEntries(PURGE_REGISTRIES.map((r) => [r, []])));
  const now = "2026-02-01T04:15:00.000Z";
  const auth = {
    ownerActor: "owner" as const, issuedAt: "2026-02-01T04:14:30.000Z",
    subjectId: "subject-1", confirmationPhrase: "purge subject-1",
  };

  // Synthetic: permitted, which is how the path gets proven at all.
  const synthetic = assertPurgeExecutable({
    authorization: auth, expectedPhrase: "purge subject-1", nowIso: now, plan,
    treeDataClass: "synthetic",
  });
  assert.equal(synthetic.ok, true, `${JSON.stringify(synthetic)}`);

  // Owner-real: refused, by name, with no way for this programme to override it.
  const real = assertPurgeExecutable({
    authorization: auth, expectedPhrase: "purge subject-1", nowIso: now, plan,
    treeDataClass: "owner_real",
  });
  assert.equal(real.ok, false);
  assert.equal(real.ok === false ? real.refusal : "",
    "real_owner_data_not_authorized_by_this_programme");
  assert.match(real.ok === false ? real.detail : "", /separate bounded work order/);
});

test("T05B-P18: every authorisation defect is refused by NAME", () => {
  const plan = planHardPurge("s", Object.fromEntries(PURGE_REGISTRIES.map((r) => [r, []])));
  const now = "2026-02-01T04:15:00.000Z";
  const base = {
    ownerActor: "owner" as const, issuedAt: "2026-02-01T04:14:30.000Z",
    subjectId: "s", confirmationPhrase: "yes",
  };
  const call = (over: Record<string, unknown>): ReturnType<typeof assertPurgeExecutable> =>
    assertPurgeExecutable({
      authorization: { ...base, ...over } as typeof base, expectedPhrase: "yes",
      nowIso: now, plan, treeDataClass: "synthetic",
    });

  assert.equal(assertPurgeExecutable({
    authorization: null, expectedPhrase: "yes", nowIso: now, plan, treeDataClass: "synthetic",
  }).ok, false);
  for (const [over, expected] of [
    [{ ownerActor: "companion" }, "wrong_actor"],
    [{ subjectId: "*" }, "wildcard_scope_refused"],
    [{ subjectId: "au-*" }, "wildcard_scope_refused"],
    [{ confirmationPhrase: "no" }, "confirmation_phrase_mismatch"],
    [{ issuedAt: "2026-02-01T03:00:00.000Z" }, "authorization_stale"],
  ] as const) {
    const r = call(over as Record<string, unknown>);
    assert.equal(r.ok, false, `${JSON.stringify(over)} must be refused`);
    assert.equal(r.ok === false ? r.refusal : "", expected);
  }

  const incomplete = assertPurgeExecutable({
    authorization: base, expectedPhrase: "yes", nowIso: now,
    plan: planHardPurge("s", {}), treeDataClass: "synthetic",
  });
  assert.equal(incomplete.ok === false ? incomplete.refusal : "", "plan_incomplete");
});

// ---------------------------------------------------------------------------
// Scheduling (LM-GATE-01 amendment A)
// ---------------------------------------------------------------------------

test("T05B-P19: the rendered timer catches up a missed run and bounds its runtime", () => {
  const u = systemdUserTimerUnits(BACKUP_JOB, {
    workingDirectory: "/opt/delos", execStart: "/usr/bin/env node build/x.js run",
  });
  assert.equal(u.timerName, "delos-backup.timer");
  assert.match(u.timerUnit, /OnCalendar=\*-\*-\* 04:15:00/);
  // A laptop that is asleep at 04:15 must not silently skip every night.
  assert.match(u.timerUnit, /Persistent=true/);
  assert.match(u.serviceUnit, /Restart=no/);

  // The timeout must be expressed with the directive that actually applies to
  // Type=oneshot. The first version of this unit used RuntimeMaxSec, and systemd
  // logged "RuntimeMaxSec= has no effect in combination with Type=oneshot" on the
  // very first real run: a bound that read correctly and bounded nothing.
  assert.match(u.serviceUnit, /^Type=oneshot$/m);
  assert.match(u.serviceUnit, /^TimeoutStartSec=1800$/m,
    "a hung backup must actually be killed, not merely described as bounded");
  assert.equal(/RuntimeMaxSec/.test(u.serviceUnit), false,
    "RuntimeMaxSec is inert for oneshot and must not be reintroduced as decoration");
  assert.equal(toOnCalendar("hourly:20"), "*-*-* *:20:00");
  assert.throws(() => toOnCalendar("whenever"), /unsupported schedule/);
});

test("T05B-P20: core declares the schedule; the systemd word appears only in the adapter", () => {
  // LM-GATE-01 amendment A as an executable boundary: if a later change moves a
  // unit name into core, this row goes red.
  //
  // The repo root is located by LANDMARK, using the T05A adapter, rather than by
  // counting `..` from this file. Counting was wrong four separate times in T04,
  // including inside a fixture written to prove the tree was clean, and it is
  // wrong here too the moment the test runs from `build/` instead of source.
  if (!CODE.ok) return;
  for (const rel of ["core/ports/backup-ports.ts", "core/services/backup-core.ts",
    "core/domain/backup-manifest.ts"]) {
    const text: string = readFileSync(join(CODE.root, rel), "utf8");
    // Comments are stripped, so this is about CODE naming a scheduler, not prose
    // that explains why core must not.
    const stripped: string = text.replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n").map((l: string) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
    assert.equal(/systemctl|OnCalendar|\.timer\b|\.service\b/.test(stripped), false,
      `${rel} must not name a scheduler implementation`);
  }
});
