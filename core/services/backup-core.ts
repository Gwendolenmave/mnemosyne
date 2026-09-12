/**
 * T05B — the restore proof and the retention rule, as pure decisions.
 *
 * Two things live here and nothing else:
 *
 *   1. `evaluateRestoreProof` — given the census recorded at snapshot time and the
 *      census re-derived from a RESTORED copy in isolation, decide whether the
 *      restore actually reproduced the system. Every check is named, so a failure
 *      says which continuity broke rather than "restore failed".
 *
 *   2. `selectRetention` — given the packages on disk and a policy, decide which
 *      to keep and which to prune. The rule that makes this safe: only PROVEN
 *      packages are eligible to be kept-as-good, and the last known good package
 *      is never pruned, whatever the policy arithmetic says.
 *
 * Both are pure so the interesting failures can be tested without staging a
 * disaster, and so the adapter cannot quietly reinterpret them.
 *
 * The audit lesson this encodes: across 26 open-source memory systems, zero
 * verified their own restores, and two lost data in a migration path that had
 * "worked" every time it was never checked. A proof that only ever passes is the
 * same defect T05A spent ten rounds removing — so every check below has a
 * corresponding negative control in `tests/t05b-restore-proof.test.ts`.
 */

import type { ContinuityCensus } from "../domain/backup-manifest.js";

/** One named continuity property, and whether the restored copy reproduced it. */
export interface ProofCheck {
  readonly id: RestoreCheckId;
  readonly ok: boolean;
  /** stable, non-empty for pass and fail alike */
  readonly detail: string;
}

export type RestoreCheckId =
  /** every database in the restored copy answers `PRAGMA integrity_check` = ok */
  | "database_integrity"
  /** the restored schema version equals the captured one */
  | "schema_version"
  /** per-table row counts match exactly */
  | "row_counts"
  /** each append-only chain ends where it ended at capture */
  | "event_chain_continuity"
  /** the stable-identifier census is bit-identical */
  | "stable_identifiers"
  /** every source pointer that resolved at capture still resolves */
  | "source_pointer_continuity"
  /** the append-only transcript set is complete, by file count and total bytes */
  | "transcript_completeness";

export const RESTORE_CHECK_IDS: readonly RestoreCheckId[] = [
  "database_integrity", "schema_version", "row_counts", "event_chain_continuity",
  "stable_identifiers", "source_pointer_continuity", "transcript_completeness",
] as const;

/** Compile-time exhaustiveness: a new check id must be added to the list above. */
const _CHECK_IDS_EXHAUSTIVE: Record<RestoreCheckId, true> = {
  database_integrity: true, schema_version: true, row_counts: true,
  event_chain_continuity: true, stable_identifiers: true,
  source_pointer_continuity: true, transcript_completeness: true,
};
void _CHECK_IDS_EXHAUSTIVE;

/** Facts the isolated restore harness observes and cannot fake by construction. */
export interface RestoreObservations {
  /** `PRAGMA integrity_check` result per restored database, keyed by logical name */
  readonly integrity: Readonly<Record<string, string>>;
  /** schema version per restored database, keyed by logical name */
  readonly schemaVersions: Readonly<Record<string, number>>;
  /** the census re-derived from the RESTORED copy */
  readonly census: ContinuityCensus;
}

export interface RestoreProof {
  readonly checks: readonly ProofCheck[];
  readonly verdict: "PROVEN" | "FAILED";
  /** the ids that failed, for a one-line operator message */
  readonly failed: readonly RestoreCheckId[];
}

function diffKeys(
  captured: Readonly<Record<string, number | string>>,
  restored: Readonly<Record<string, number | string>>,
): string[] {
  const keys = new Set([...Object.keys(captured), ...Object.keys(restored)]);
  const bad: string[] = [];
  for (const k of [...keys].sort()) {
    if (captured[k] !== restored[k]) {
      bad.push(`${k}: captured=${String(captured[k])} restored=${String(restored[k])}`);
    }
  }
  return bad;
}

/**
 * The proof. `capturedSchemaVersions` comes from the snapshot; a database present
 * in one side and absent from the other is a failure, not a skipped check —
 * silently skipping the check for a database that failed to restore is precisely
 * how a hollow proof passes.
 */
export function evaluateRestoreProof(
  captured: ContinuityCensus,
  capturedSchemaVersions: Readonly<Record<string, number>>,
  observed: RestoreObservations,
): RestoreProof {
  const checks: ProofCheck[] = [];

  const notOk = Object.entries(observed.integrity)
    .filter(([, v]) => v !== "ok")
    .map(([k, v]) => `${k}=${v}`);
  const noDatabases = Object.keys(observed.integrity).length === 0;
  checks.push({
    id: "database_integrity",
    ok: !noDatabases && notOk.length === 0,
    detail: noDatabases
      ? "no database was checked — an empty integrity set is not a pass"
      : notOk.length === 0
        ? `${Object.keys(observed.integrity).length}_databases_ok`
        : `not_ok: ${notOk.join(", ")}`,
  });

  const schemaBad = diffKeys(capturedSchemaVersions, observed.schemaVersions);
  checks.push({
    id: "schema_version",
    ok: schemaBad.length === 0 && Object.keys(capturedSchemaVersions).length > 0,
    detail: Object.keys(capturedSchemaVersions).length === 0
      ? "no schema version was captured — nothing to compare"
      : schemaBad.length === 0
        ? `${Object.keys(capturedSchemaVersions).length}_schemas_match`
        : schemaBad.join("; "),
  });

  const rowBad = diffKeys(captured.rowCounts, observed.census.rowCounts);
  checks.push({
    id: "row_counts",
    ok: rowBad.length === 0 && Object.keys(captured.rowCounts).length > 0,
    detail: Object.keys(captured.rowCounts).length === 0
      ? "no row count was captured — nothing to compare"
      : rowBad.length === 0
        ? `${Object.keys(captured.rowCounts).length}_tables_match`
        : rowBad.join("; "),
  });

  const chainBad = diffKeys(captured.chainHeads, observed.census.chainHeads);
  checks.push({
    id: "event_chain_continuity",
    ok: chainBad.length === 0 && Object.keys(captured.chainHeads).length > 0,
    detail: Object.keys(captured.chainHeads).length === 0
      ? "no chain head was captured — nothing to compare"
      : chainBad.length === 0
        ? `${Object.keys(captured.chainHeads).length}_chains_intact`
        : chainBad.join("; "),
  });

  const idsMatch = captured.stableIdDigest === observed.census.stableIdDigest
    && captured.stableIdCount === observed.census.stableIdCount;
  checks.push({
    id: "stable_identifiers",
    ok: idsMatch,
    detail: idsMatch
      ? `${captured.stableIdCount}_ids_identical`
      : `captured ${captured.stableIdCount}/${captured.stableIdDigest.slice(0, 12)} `
        + `restored ${observed.census.stableIdCount}/${observed.census.stableIdDigest.slice(0, 12)}`,
  });

  const pointersMatch = captured.sourcePointerDigest === observed.census.sourcePointerDigest
    && captured.sourcePointerCount === observed.census.sourcePointerCount;
  checks.push({
    id: "source_pointer_continuity",
    ok: pointersMatch,
    detail: pointersMatch
      ? `${captured.sourcePointerCount}_pointers_intact`
      : `captured ${captured.sourcePointerCount}/${captured.sourcePointerDigest.slice(0, 12)} `
        + `restored ${observed.census.sourcePointerCount}/${observed.census.sourcePointerDigest.slice(0, 12)}`,
  });

  const transcriptsMatch = captured.transcriptFiles === observed.census.transcriptFiles
    && captured.transcriptBytes === observed.census.transcriptBytes;
  checks.push({
    id: "transcript_completeness",
    ok: transcriptsMatch,
    detail: transcriptsMatch
      ? `${captured.transcriptFiles}_files_${captured.transcriptBytes}_bytes`
      : `captured ${captured.transcriptFiles}f/${captured.transcriptBytes}B `
        + `restored ${observed.census.transcriptFiles}f/${observed.census.transcriptBytes}B`,
  });

  const failed = checks.filter((c) => !c.ok).map((c) => c.id);
  return { checks, verdict: failed.length === 0 ? "PROVEN" : "FAILED", failed };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  /** keep at least this many proven packages, newest first */
  readonly keepLatest: number;
  /** keep the newest proven package from each of the last N distinct UTC days */
  readonly keepDailyDays: number;
  /** never prune below this many proven packages, whatever the arithmetic says */
  readonly floor: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  keepLatest: 7,
  keepDailyDays: 30,
  floor: 2,
};

export interface PackageRecord {
  readonly packageId: string;
  /** ISO-8601 UTC */
  readonly createdAt: string;
  /** a package whose restore proof PASSED in isolation */
  readonly proven: boolean;
  readonly bytes: number;
}

export interface RetentionDecision {
  readonly keep: readonly string[];
  readonly prune: readonly string[];
  /** unproven packages, retained as evidence and never counted as good */
  readonly quarantined: readonly string[];
  readonly reason: Readonly<Record<string, string>>;
}

/**
 * Select what to keep.
 *
 * The three rules that make this safe, in the order they bind:
 *
 *   1. An UNPROVEN package is never pruned and never counted. It is evidence of a
 *      failure and the operator needs it; deleting it would erase the only trace
 *      of a backup that did not work.
 *   2. The newest PROVEN package is always kept, unconditionally. `keepLatest: 0`
 *      cannot produce a system with no good backup.
 *   3. Only after 1 and 2 does the arithmetic run, and it still stops at `floor`.
 *
 * A retention policy that can leave zero good backups is not a policy, it is a
 * deletion schedule.
 */
export function selectRetention(
  packages: readonly PackageRecord[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
): RetentionDecision {
  const reason: Record<string, string> = {};
  const quarantined = packages.filter((p) => !p.proven).map((p) => p.packageId);
  for (const q of quarantined) {
    reason[q] = "unproven: retained as failure evidence, never counted as good";
  }

  const proven = packages.filter((p) => p.proven)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const keep = new Set<string>();

  if (proven.length > 0) {
    keep.add(proven[0]!.packageId);
    reason[proven[0]!.packageId] = "last known good: never pruned";
  }

  for (const p of proven.slice(0, Math.max(0, policy.keepLatest))) {
    if (!keep.has(p.packageId)) {
      keep.add(p.packageId);
      reason[p.packageId] = `within keepLatest=${policy.keepLatest}`;
    }
  }

  const daysSeen = new Set<string>();
  for (const p of proven) {
    const day = p.createdAt.slice(0, 10);
    if (daysSeen.has(day)) continue;
    daysSeen.add(day);
    if (daysSeen.size > policy.keepDailyDays) break;
    if (!keep.has(p.packageId)) {
      keep.add(p.packageId);
      reason[p.packageId] = `newest proven package of ${day}`;
    }
  }

  // The floor binds last: walk newest-first adding until the floor is met.
  for (const p of proven) {
    if (keep.size >= policy.floor) break;
    if (!keep.has(p.packageId)) {
      keep.add(p.packageId);
      reason[p.packageId] = `retention floor=${policy.floor}`;
    }
  }

  const prune = proven.filter((p) => !keep.has(p.packageId)).map((p) => p.packageId);
  for (const p of prune) reason[p] = "superseded by newer proven packages";

  return { keep: [...keep], prune, quarantined, reason };
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

export type BackupAlertKind =
  | "backup_failed"
  | "restore_proof_failed"
  | "no_recent_proven_backup"
  | "key_unavailable";

export interface BackupAlert {
  readonly kind: BackupAlertKind;
  readonly detail: string;
  /**
   * Whether the last known good package is still intact. An alert that also had
   * to report "and your previous backup is gone" is a different emergency, so the
   * two are never collapsed into one message.
   */
  readonly lastKnownGoodIntact: boolean;
}

/**
 * Exception-only reporting (master programme SS4.3). A successful, proven backup
 * produces NO alert — the operator covenant is that Owner hears from this system
 * when something is wrong, not every night at 04:00.
 */
export function alertsFor(input: {
  readonly backupOk: boolean;
  readonly proofVerdict: "PROVEN" | "FAILED" | "NOT_RUN";
  readonly proofFailed: readonly RestoreCheckId[];
  readonly lastProvenAgeHours: number | null;
  readonly maxProvenAgeHours: number;
  readonly keyAvailable: boolean;
  readonly lastKnownGoodIntact: boolean;
}): readonly BackupAlert[] {
  const out: BackupAlert[] = [];
  const intact = input.lastKnownGoodIntact;
  if (!input.keyAvailable) {
    out.push({ kind: "key_unavailable", detail: "the backup key could not be read", lastKnownGoodIntact: intact });
  }
  if (!input.backupOk) {
    out.push({ kind: "backup_failed", detail: "the snapshot did not complete", lastKnownGoodIntact: intact });
  }
  if (input.proofVerdict === "FAILED") {
    out.push({
      kind: "restore_proof_failed",
      detail: `restore proof failed: ${input.proofFailed.join(", ")}`,
      lastKnownGoodIntact: intact,
    });
  }
  if (input.lastProvenAgeHours === null) {
    out.push({
      kind: "no_recent_proven_backup",
      detail: "no proven backup exists yet",
      lastKnownGoodIntact: intact,
    });
  } else if (input.lastProvenAgeHours > input.maxProvenAgeHours) {
    out.push({
      kind: "no_recent_proven_backup",
      detail: `newest proven backup is ${Math.floor(input.lastProvenAgeHours)}h old `
        + `(limit ${input.maxProvenAgeHours}h)`,
      lastKnownGoodIntact: intact,
    });
  }
  return out;
}
