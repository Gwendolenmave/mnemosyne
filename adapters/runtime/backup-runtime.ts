/**
 * T05B runtime: take a backup, then PROVE it by restoring into isolation.
 *
 * The order matters and is not negotiable: a package becomes "the last known
 * good backup" only after it has been unpacked into a throwaway directory and the
 * restored copy has reproduced the live system's continuity facts. Until then it
 * is a file with a manifest. This is the single thing the memory-landscape audit
 * found missing in every one of the twenty-six systems it surveyed.
 *
 * Everything that can fail returns a typed value. Nothing here throws to signal a
 * normal outcome, because the caller is a scheduler that must decide whether to
 * alert, and "an exception reached the timer" is not a decision.
 */

import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  BACKUP_MANIFEST_SCHEMA, type BackupEntry, type BackupManifest, type BackupSourceKind,
  type CaptureMethod, type ContinuityCensus, inventoryDigest, packageIdentity,
  validateBackupManifest,
} from "../../core/domain/backup-manifest.js";
import {
  alertsFor, type BackupAlert, DEFAULT_RETENTION, evaluateRestoreProof,
  type PackageRecord, type RestoreProof, type RetentionDecision, type RetentionPolicy,
  selectRetention,
} from "../../core/services/backup-core.js";
import {
  createNodeArchivePort, ENCRYPTION_LABEL, nodeCensusPort, nodeSnapshotPort,
} from "../platform/node-backup-io.js";
import type { CensusInputs } from "../../core/ports/backup-ports.js";

const hash = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Where everything lives. Declared, never inferred from `process.cwd()`. */
export interface BackupPaths {
  readonly mnemosynePath: string;
  readonly backlogPath: string;
  readonly currentSituationPath: string;
  readonly episodeProjectionPath: string | null;
  readonly transcriptsDir: string;
  readonly telegramStateDir: string;
  /** T05A declared this root as `reserved`; T05B is what reserves it FOR */
  readonly backupRoot: string;
  /** work area for staging and isolated restores; derived, disposable */
  readonly workRoot: string;
  /** the local key; 0600, never in the repo, never in a manifest */
  readonly keyPath: string;
  readonly installationId: string;
}

export interface BackupOutcome {
  readonly ok: boolean;
  readonly packageId: string | null;
  readonly packagePath: string | null;
  readonly manifest: BackupManifest | null;
  readonly proof: RestoreProof | null;
  readonly alerts: readonly BackupAlert[];
  readonly detail: string;
  readonly packageBytes: number;
  readonly elapsedMs: number;
}

interface StagedSource {
  readonly entryPath: string;
  readonly kind: BackupSourceKind;
  readonly method: CaptureMethod;
  readonly logicalSource: string;
}

function censusInputsFor(p: BackupPaths): CensusInputs {
  return {
    mnemosynePath: p.mnemosynePath,
    backlogPath: p.backlogPath,
    currentSituationPath: p.currentSituationPath,
    episodeProjectionPath: p.episodeProjectionPath,
    transcriptsDir: p.transcriptsDir,
  };
}

function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Capture, package, and prove — in that order, in one call, because a backup that
 * is taken by one job and verified by another that nobody scheduled is a backup
 * that is never verified.
 */
export function runBackup(
  paths: BackupPaths,
  options?: { readonly now?: () => Date; readonly keepStaging?: boolean; readonly maxProvenAgeHours?: number },
): BackupOutcome {
  const now = options?.now ?? ((): Date => new Date());
  const started = Date.now();
  const archive = createNodeArchivePort(paths.keyPath);

  const fingerprint = archive.keyFingerprint();
  if (!fingerprint.ok) {
    return {
      ok: false, packageId: null, packagePath: null, manifest: null, proof: null,
      alerts: alertsFor({
        backupOk: false, proofVerdict: "NOT_RUN", proofFailed: [],
        lastProvenAgeHours: lastProvenAgeHours(paths, now()),
        maxProvenAgeHours: options?.maxProvenAgeHours ?? 26,
        keyAvailable: false, lastKnownGoodIntact: true,
      }),
      detail: `key unavailable: ${fingerprint.failure} ${fingerprint.detail}`,
      packageBytes: 0, elapsedMs: Date.now() - started,
    };
  }

  mkdirSync(paths.backupRoot, { recursive: true });
  mkdirSync(paths.workRoot, { recursive: true });
  const staging = mkdtempSync(join(paths.workRoot, "backup-staging-"));

  const fail = (detail: string): BackupOutcome => {
    if (options?.keepStaging !== true) rmSync(staging, { recursive: true, force: true });
    return {
      ok: false, packageId: null, packagePath: null, manifest: null, proof: null,
      alerts: alertsFor({
        backupOk: false, proofVerdict: "NOT_RUN", proofFailed: [],
        lastProvenAgeHours: lastProvenAgeHours(paths, now()),
        maxProvenAgeHours: options?.maxProvenAgeHours ?? 26,
        keyAvailable: true, lastKnownGoodIntact: true,
      }),
      detail, packageBytes: 0, elapsedMs: Date.now() - started,
    };
  };

  try {
    // 1. Census FIRST, from the live system, so the facts to be proven are the
    //    facts as they were at capture time.
    const live = nodeCensusPort.derive(censusInputsFor(paths));

    // 2. Capture each source with its declared method.
    const staged: StagedSource[] = [];
    const dbs: Array<[BackupSourceKind, string, string]> = [
      ["mnemosyne", paths.mnemosynePath, "db/mnemosyne.db"],
      ["decision_backlog", paths.backlogPath, "db/decision-backlog.db"],
      ["current_situation", paths.currentSituationPath, "db/current-situation.db"],
    ];
    if (paths.episodeProjectionPath !== null) {
      dbs.push(["episode_inputs", paths.episodeProjectionPath, "db/episode-projection.db"]);
    }
    for (const [kind, src, entryPath] of dbs) {
      if (!existsSync(src)) continue;
      const r = nodeSnapshotPort.sqliteConsistentCopy(src, join(staging, entryPath));
      if (!r.ok) return fail(`${kind}: ${r.failure} ${r.detail}`);
      staged.push({ entryPath, kind, method: "sqlite_consistent_copy", logicalSource: kind });
    }

    for (const name of nodeSnapshotPort.listDirectoryFiles(paths.transcriptsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const src = join(paths.transcriptsDir, name);
      const observed = statSync(src).size;
      const entryPath = `transcripts/${name}`;
      const r = nodeSnapshotPort.fileCopy(src, join(staging, entryPath), {
        expectAtLeastBytes: observed,
      });
      if (!r.ok) return fail(`transcript ${name}: ${r.failure} ${r.detail}`);
      staged.push({
        entryPath, kind: "transcript", method: "append_only_copy",
        logicalSource: `transcripts/${name}`,
      });
    }

    for (const name of nodeSnapshotPort.listDirectoryFiles(paths.telegramStateDir)) {
      // Durable runtime state only. Logs and rotated copies are derived noise and
      // restoring them proves nothing.
      if (!(name === "state.json" || name === "audit.jsonl" || name === "companion-pass.json"
        || name === "governance-ui.json")) continue;
      const entryPath = `telegram/${name}`;
      const r = nodeSnapshotPort.fileCopy(join(paths.telegramStateDir, name), join(staging, entryPath));
      if (!r.ok) return fail(`telegram ${name}: ${r.failure} ${r.detail}`);
      staged.push({
        entryPath, kind: "telegram_state",
        method: name.endsWith(".jsonl") ? "append_only_copy" : "document_copy",
        logicalSource: `telegram/${name}`,
      });
    }

    // 3. Pack and encrypt.
    const packed = archive.pack(
      staging, staged.map((s) => s.entryPath), join(staging, "_package.tmp"));
    if (!packed.ok) return fail(`pack: ${packed.failure} ${packed.detail}`);

    const byPath = new Map(packed.value.entries.map((e) => [e.entryPath, e]));
    const entries: BackupEntry[] = staged.map((s) => {
      const p = byPath.get(s.entryPath)!;
      return {
        entryPath: s.entryPath, kind: s.kind, method: s.method,
        bytes: p.bytes, sha256: p.sha256, logicalSource: s.logicalSource,
      };
    });

    const identity = packageIdentity(entries, live.census, hash);
    const createdAt = now().toISOString();
    const packageId = `delos-backup-${utcStamp(now())}-${identity.slice(0, 12)}`;
    const manifest: BackupManifest = {
      schema: BACKUP_MANIFEST_SCHEMA,
      manifestVersion: 1,
      packageId,
      createdAt,
      installationId: paths.installationId,
      sourceSurfaceId: null,
      entries,
      inventoryId: inventoryDigest(entries, hash),
      census: live.census,
      encryption: ENCRYPTION_LABEL,
      keyFingerprint: fingerprint.value,
      plaintextBytes: packed.value.plaintextBytes,
    };

    const dir = join(paths.backupRoot, packageId);
    mkdirSync(dir, { recursive: true });
    const packagePath = join(dir, "package.dlsbk");
    // The manifest is written in CLEAR beside the package on purpose: it carries
    // only identities, counts and digests, and an operator must be able to read
    // what a package claims WITHOUT the key. The private content is inside the
    // encrypted container.
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n", { mode: 0o600 });
    renameSync(join(staging, "_package.tmp"), packagePath);

    // 4. PROVE it: unpack into isolation and re-derive the census with the same code.
    const proof = proveRestore(packagePath, manifest, paths, live.schemaVersions);
    writeFileSync(join(dir, "restore-proof.json"),
      JSON.stringify(proof, null, 1) + "\n", { mode: 0o600 });

    const packageBytes = statSync(packagePath).size;
    const alerts = alertsFor({
      backupOk: true,
      proofVerdict: proof.verdict,
      proofFailed: proof.failed,
      lastProvenAgeHours: proof.verdict === "PROVEN" ? 0 : lastProvenAgeHours(paths, now()),
      maxProvenAgeHours: options?.maxProvenAgeHours ?? 26,
      keyAvailable: true,
      lastKnownGoodIntact: true,
    });

    if (options?.keepStaging !== true) rmSync(staging, { recursive: true, force: true });
    return {
      ok: proof.verdict === "PROVEN",
      packageId, packagePath, manifest, proof, alerts,
      detail: proof.verdict === "PROVEN"
        ? `proven: ${proof.checks.length} continuity checks`
        : `restore proof FAILED: ${proof.failed.join(", ")}`,
      packageBytes,
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    return fail(`unexpected: ${String((e as Error).message ?? e)}`);
  }
}

/**
 * Unpack into a throwaway directory and re-derive the census with the SAME
 * implementation used on the live side. Nothing about the live system is touched.
 */
export function proveRestore(
  packagePath: string,
  manifest: BackupManifest,
  paths: BackupPaths,
  capturedSchemaVersions: Readonly<Record<string, number>>,
): RestoreProof {
  const archive = createNodeArchivePort(paths.keyPath);
  const isolated = mkdtempSync(join(tmpdir(), "delos-restore-proof-"));
  try {
    const unpacked = archive.unpack(packagePath, isolated);
    if (!unpacked.ok) {
      return {
        checks: [{
          id: "database_integrity", ok: false,
          detail: `unpack failed: ${unpacked.failure} ${unpacked.detail}`,
        }],
        verdict: "FAILED",
        failed: ["database_integrity"],
      };
    }
    const observed = nodeCensusPort.derive({
      mnemosynePath: maybe(isolated, "db/mnemosyne.db"),
      backlogPath: maybe(isolated, "db/decision-backlog.db"),
      currentSituationPath: maybe(isolated, "db/current-situation.db"),
      episodeProjectionPath: maybe(isolated, "db/episode-projection.db"),
      transcriptsDir: join(isolated, "transcripts"),
    });
    return evaluateRestoreProof(manifest.census, capturedSchemaVersions, {
      integrity: observed.integrity,
      schemaVersions: observed.schemaVersions,
      census: observed.census,
    });
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

function maybe(root: string, rel: string): string | null {
  const p = join(root, rel);
  return existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// Inventory and retention
// ---------------------------------------------------------------------------

export interface StoredPackage extends PackageRecord {
  readonly dir: string;
  readonly manifest: BackupManifest | null;
  readonly manifestRefusal: string | null;
}

export function listPackages(paths: BackupPaths): readonly StoredPackage[] {
  if (!existsSync(paths.backupRoot)) return [];
  const out: StoredPackage[] = [];
  for (const name of nodeListDirs(paths.backupRoot)) {
    const dir = join(paths.backupRoot, name);
    const manifestPath = join(dir, "manifest.json");
    const proofPath = join(dir, "restore-proof.json");
    const pkgPath = join(dir, "package.dlsbk");
    let manifest: BackupManifest | null = null;
    let refusal: string | null = null;
    try {
      const check = validateBackupManifest(JSON.parse(readFileSync(manifestPath, "utf8")), hash);
      if (check.ok) manifest = check.manifest;
      else refusal = `${check.refusal}: ${check.detail}`;
    } catch (e) {
      refusal = `unreadable: ${String((e as Error).message ?? e)}`;
    }
    let proven = false;
    try {
      proven = (JSON.parse(readFileSync(proofPath, "utf8")) as RestoreProof).verdict === "PROVEN";
    } catch { proven = false; }
    out.push({
      packageId: manifest?.packageId ?? name,
      createdAt: manifest?.createdAt ?? "",
      // A package whose manifest does not validate is NOT proven, whatever a
      // proof file beside it happens to say.
      proven: proven && manifest !== null,
      bytes: existsSync(pkgPath) ? statSync(pkgPath).size : 0,
      dir, manifest, manifestRefusal: refusal,
    });
  }
  return out;
}

function nodeListDirs(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("delos-backup-"))
    .map((d) => d.name)
    .sort();
}

export function lastProvenAgeHours(paths: BackupPaths, now: Date): number | null {
  const proven = listPackages(paths).filter((p) => p.proven && p.createdAt !== "");
  if (proven.length === 0) return null;
  const newest = proven.map((p) => Date.parse(p.createdAt)).sort((a, b) => b - a)[0]!;
  return (now.getTime() - newest) / 3_600_000;
}

export interface PruneOutcome {
  readonly decision: RetentionDecision;
  readonly removed: readonly string[];
  readonly bytesReclaimed: number;
}

/**
 * Apply retention. The core decides; this only carries it out, and it re-reads
 * the decision's own `keep` set before removing anything so a bug in the caller
 * cannot turn a keep into a prune.
 */
export function pruneBackups(
  paths: BackupPaths,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  options?: { readonly dryRun?: boolean },
): PruneOutcome {
  const stored = listPackages(paths);
  const decision = selectRetention(stored, policy);
  const keep = new Set(decision.keep);
  const quarantined = new Set(decision.quarantined);
  const removed: string[] = [];
  let bytes = 0;
  for (const id of decision.prune) {
    if (keep.has(id) || quarantined.has(id)) continue;  // belt and braces
    const p = stored.find((s) => s.packageId === id);
    if (p === undefined) continue;
    bytes += p.bytes;
    if (options?.dryRun !== true) rmSync(p.dir, { recursive: true, force: true });
    removed.push(id);
  }
  return { decision, removed, bytesReclaimed: bytes };
}

/** A one-line operator summary. Exception-only: silence means it worked. */
export function summarise(outcome: BackupOutcome): string {
  if (outcome.alerts.length === 0) return "";
  return outcome.alerts.map((a) => `[${a.kind}] ${a.detail}`
    + (a.lastKnownGoodIntact ? "" : " — AND the last known good backup is gone")).join("\n");
}

export function packageDisplayName(p: StoredPackage): string {
  return `${basename(p.dir)} ${p.proven ? "PROVEN" : "UNPROVEN"} ${p.bytes} B`;
}
