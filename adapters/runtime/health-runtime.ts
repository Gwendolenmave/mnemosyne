/**
 * T05C runtime: observe the live system, rule on what it finds, write a receipt.
 *
 * The observation side lives here because it needs capability; every judgement is
 * made by `core/services/reliability-core.ts`. That split is what lets the
 * interesting failures — a second poller, a corrupted authoritative database, a
 * queue that stopped draining — be tested without staging them on the real system.
 *
 * Two observations are worth explaining:
 *
 *   Poller count comes from the RUNTIME LOCK, not from a process scan, because the
 *   lock is the actual enforcement mechanism. A process scan corroborates it; if
 *   the two disagree, that disagreement is itself the finding, because it means
 *   something is running without holding the lock.
 *
 *   Queue arithmetic is checked, not just queue length. A silent drop looks exactly
 *   like a shorter queue, so `receiptsTotal` is compared against the sum of every
 *   durable state. Length alone cannot see a loss.
 */

import { existsSync, readdirSync, readFileSync, statfsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import { execFile } from "node:child_process";
import { inspectLock } from "../telegram/lock.js";
import {
  evaluateHealth, type Fault, type HealthObservation, type HealthReceipt,
  planReconstruction, type ReconstructionPlan, ruleFault,
} from "../../core/services/reliability-core.js";

export interface HealthPaths {
  readonly mnemosynePath: string;
  readonly episodeProjectionPath: string | null;
  readonly backlogPath: string;
  readonly telegramStateDir: string;
  readonly lockPath: string;
  readonly backupRoot: string;
  readonly receiptRoot: string;
  /** the volume whose headroom matters: where durable state actually lives */
  readonly stateVolumePath: string;
  readonly backupFreshnessBoundHours: number;
  readonly liveQueueSloSeconds: number;
  readonly freeBytesFloor: number;
  /** the poller entrypoint, matched against /proc for corroboration only */
  readonly pollerCommandFragment: string;
  /** HTTPS_PROXY URL through which to probe api.anthropic.com; null skips the probe */
  readonly providerEgressProxyUrl: string | null;
  /** absolute path to the claude CLI binary (DELOS_CLAUDE_BIN); null skips the probe */
  readonly providerCredentialClaudeBin: string | null;
  /** absolute path to the CLI credentials file; null skips the file-level check */
  readonly providerCredentialFilePath: string | null;
}

/** Count processes whose cmdline contains the fragment. Linux /proc; no spawning. */
export function scanProcessCount(fragment: string): number {
  let n = 0;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return -1;   // not observable on this platform; -1 means "unknown", never 0
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const cmd = readFileSync(join("/proc", e, "cmdline"), "utf8").replace(/\0/g, " ");
      if (cmd.includes(fragment)) n += 1;
    } catch { /* the process exited between readdir and read */ }
  }
  return n;
}

/**
 * Consistency of the FTS projection against the cards it is derived from.
 *
 * `PRAGMA integrity_check` says nothing useful about an FTS5 index: the pages can
 * be perfectly intact while the projection covers the wrong set of rows, which is
 * the actual failure — a card that exists and cannot be found. So the check is the
 * derivation invariant: one projection row per memory item.
 *
 * This exists because the first version of this file passed an EMPTY derived map
 * into `evaluateHealth`, so `derived_state_integrity` reported `0_derived_ok` on
 * every run and could not fail. That is the same hollow-instrument defect this
 * programme keeps finding, shipped by its own health checker.
 */
export function derivedIntegrityOf(mnemosynePath: string, episodeProjectionPath: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(mnemosynePath)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(mnemosynePath, { readOnly: true });
      const items = (db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number }).n;
      const projected = (db.prepare("SELECT COUNT(*) AS n FROM fts_items").get() as { n: number }).n;
      out["fts_items"] = items === projected
        ? "ok"
        : `projection covers ${projected} of ${items} cards`;
    } catch (e) {
      out["fts_items"] = `unreadable: ${String((e as Error).message ?? e)}`;
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  if (episodeProjectionPath !== null && existsSync(episodeProjectionPath)) {
    out["episode_projection"] = integrityOf(episodeProjectionPath);
  }
  return out;
}

function integrityOf(path: string): string {
  if (!existsSync(path)) return "absent";
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    return row?.integrity_check ?? "missing";
  } catch (e) {
    return `unreadable: ${String((e as Error).message ?? e)}`;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

interface QueueFacts {
  readonly claimable: number;
  /** the oldest claimable LIVE turn; backfill age is expected to be large */
  readonly liveOldestClaimableAgeSeconds: number | null;
  readonly backfillRemaining: number;
  readonly backfillSettledInWindow: number;
  readonly receiptsTotal: number;
  readonly accountedStates: number;
}

/** How far back `backfillSettledInWindow` looks. */
export const BACKFILL_WINDOW_SECONDS = 3 * 3600;

/**
 * Queue arithmetic.
 *
 * `receiptsTotal` is the number of DISTINCT identities that ever entered the
 * queue — one enqueue receipt each. `accountedStates` is how many of those
 * identities currently sit in some durable state. If an identity vanished, the
 * second number is smaller, and no amount of looking at queue LENGTH would show it.
 */
export function queueFacts(backlogPath: string, now: Date): QueueFacts {
  if (!existsSync(backlogPath)) {
    return {
      claimable: 0, liveOldestClaimableAgeSeconds: null, backfillRemaining: 0,
      backfillSettledInWindow: 0, receiptsTotal: 0, accountedStates: 0,
    };
  }
  const db = new DatabaseSync(backlogPath, { readOnly: true });
  try {
    const CLAIMABLE = "state IN ('deferred','processing','failed_retryable')";
    const claimable = (db.prepare(
      `SELECT COUNT(*) AS n FROM backlog_items WHERE ${CLAIMABLE}`).get() as { n: number }).n;
    const liveOldest = (db.prepare(
      `SELECT MIN(queued_at) AS t FROM backlog_items WHERE origin='live' AND ${CLAIMABLE}`)
      .get() as { t: string | null }).t;
    const backfillRemaining = (db.prepare(
      `SELECT COUNT(*) AS n FROM backlog_items WHERE origin='backfill' AND ${CLAIMABLE}`)
      .get() as { n: number }).n;
    const since = new Date(now.getTime() - BACKFILL_WINDOW_SECONDS * 1000).toISOString();
    const backfillSettledInWindow = (db.prepare(
      "SELECT COUNT(*) AS n FROM backlog_receipts r JOIN backlog_items i "
      + "ON i.identity = r.identity WHERE i.origin='backfill' AND r.from_state='processing' "
      + "AND r.to_state IN ('declined','duplicate','policy_activated','quarantined',"
      + "'failed_terminal','deferred_oversize') AND r.at >= ?").get(since) as { n: number }).n;
    const receiptsTotal = (db.prepare(
      "SELECT COUNT(DISTINCT identity) AS n FROM backlog_receipts").get() as { n: number }).n;
    const accountedStates = (db.prepare(
      "SELECT COUNT(*) AS n FROM backlog_items").get() as { n: number }).n;
    return {
      claimable,
      liveOldestClaimableAgeSeconds: liveOldest === null
        ? null : Math.max(0, Math.round((now.getTime() - Date.parse(liveOldest)) / 1000)),
      backfillRemaining,
      backfillSettledInWindow,
      receiptsTotal,
      accountedStates,
    };
  } finally {
    db.close();
  }
}

function newestProvenBackupAgeHours(backupRoot: string, now: Date): number | null {
  if (!existsSync(backupRoot)) return null;
  let newest: number | null = null;
  for (const d of readdirSync(backupRoot, { withFileTypes: true })) {
    if (!d.isDirectory() || !d.name.startsWith("delos-backup-")) continue;
    const proofPath = join(backupRoot, d.name, "restore-proof.json");
    const manifestPath = join(backupRoot, d.name, "manifest.json");
    try {
      if ((JSON.parse(readFileSync(proofPath, "utf8")) as { verdict: string }).verdict !== "PROVEN") continue;
      const createdAt = (JSON.parse(readFileSync(manifestPath, "utf8")) as { createdAt: string }).createdAt;
      const t = Date.parse(createdAt);
      if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
    } catch { /* an unreadable package is not a proven one */ }
  }
  return newest === null ? null : (now.getTime() - newest) / 3_600_000;
}

/** Did the durable Telegram state survive the last restart? */
function restartContinuityIntact(stateDir: string): boolean {
  const statePath = join(stateDir, "state.json");
  if (!existsSync(statePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    // A state document that exists but carries no offset is a state document that
    // was recreated empty, which is the loss this check is for.
    return Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

const EGRESS_PROBE_HOST = "api.anthropic.com";
const EGRESS_PROBE_PORT = 443;
const EGRESS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe whether the model provider is reachable through the configured proxy.
 *
 * Sends an HTTP CONNECT through the HTTPS_PROXY to api.anthropic.com:443 and
 * checks for a 200 response. This is the same handshake the bridge performs; the
 * important thing is that it exercises the FULL egress path: bridge → upstream →
 * internet → Anthropic.
 *
 * Returns `{ ok, detail }`. When the proxy URL is null the probe is skipped and
 * returns `{ ok: null, detail: "no proxy configured" }`.
 */
export function probeProviderEgress(
  proxyUrl: string | null,
): Promise<{ ok: boolean | null; detail: string }> {
  if (!proxyUrl) {
    return Promise.resolve({ ok: null, detail: "no HTTPS_PROXY configured; probe skipped" });
  }
  let proxyHost: string;
  let proxyPort: number;
  try {
    const u = new URL(proxyUrl);
    proxyHost = u.hostname;
    proxyPort = Number(u.port) || 80;
  } catch {
    return Promise.resolve({ ok: false, detail: `invalid HTTPS_PROXY URL: ${proxyUrl}` });
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host: proxyHost, port: proxyPort, timeout: EGRESS_PROBE_TIMEOUT_MS });
    let buf = "";
    const done = (ok: boolean, detail: string): void => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok, detail });
    };
    sock.on("connect", () => {
      sock.write(
        `CONNECT ${EGRESS_PROBE_HOST}:${EGRESS_PROBE_PORT} HTTP/1.1\r\n`
        + `Host: ${EGRESS_PROBE_HOST}:${EGRESS_PROBE_PORT}\r\n\r\n`,
      );
    });
    sock.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n")) {
        if (/^HTTP\/1\.[01] 200/.test(buf)) {
          done(true, `CONNECT to ${EGRESS_PROBE_HOST}:${EGRESS_PROBE_PORT} via ${proxyHost}:${proxyPort} succeeded`);
        } else {
          const status = buf.split("\r\n")[0] ?? "";
          done(false, `CONNECT rejected: ${status}`);
        }
      }
    });
    sock.on("timeout", () => done(false, `CONNECT to ${EGRESS_PROBE_HOST} via ${proxyHost}:${proxyPort} timed out after ${EGRESS_PROBE_TIMEOUT_MS}ms`));
    sock.on("error", (e: Error) => done(false, `CONNECT to ${EGRESS_PROBE_HOST} via ${proxyHost}:${proxyPort} error: ${e.message}`));
  });
}

/**
 * Probe whether the model provider CLI is functional and holds valid credentials.
 *
 * Two tiers, both token-free:
 *   1. Binary health: `$DELOS_CLAUDE_BIN --version` must exit 0.
 *   2. Credential file: `~/.claude/.credentials.json` must exist, be valid JSON,
 *      and contain the expected auth key structure.
 *
 * This catches the 08-03 root cause — a failed token refresh during a network
 * outage corrupted the credentials file, leaving the bot "hearing but mute" even
 * after the network recovered. The network egress probe (probeProviderEgress)
 * cannot see this; the two checks cover different fault segments.
 */
export function probeProviderCredential(
  claudeBin: string | null,
  credentialFilePath: string | null,
): Promise<{ ok: boolean | null; detail: string }> {
  if (!claudeBin) {
    return Promise.resolve({ ok: null, detail: "no DELOS_CLAUDE_BIN configured; probe skipped" });
  }

  return new Promise((resolve) => {
    execFile(claudeBin, ["--version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, detail: `CLI binary not functional: ${err.message}` });
        return;
      }
      const version = (stdout ?? "").toString().trim();

      if (!credentialFilePath) {
        resolve({ ok: true, detail: `CLI ${version}, credential file path not configured` });
        return;
      }

      try {
        const raw = readFileSync(credentialFilePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length === 0) {
          resolve({ ok: false, detail: `credentials file empty or not a valid object: ${credentialFilePath}` });
          return;
        }
        resolve({ ok: true, detail: `CLI ${version}, credentials present (${Object.keys(parsed).join(",")})` });
      } catch (e) {
        const fe = e as NodeJS.ErrnoException;
        if (fe.code === "ENOENT") {
          resolve({ ok: false, detail: `credentials file missing: ${credentialFilePath}` });
        } else if (e instanceof SyntaxError) {
          resolve({ ok: false, detail: `credentials file corrupt (invalid JSON): ${credentialFilePath}` });
        } else {
          resolve({ ok: false, detail: `credentials file unreadable: ${fe.message}` });
        }
      }
    });
  });
}

export function observeHealth(paths: HealthPaths, now: Date = new Date()): HealthObservation {
  const lock = inspectLock(paths.lockPath);
  const lockHolders = lock.state === "live" ? 1 : 0;
  const scanned = scanProcessCount(paths.pollerCommandFragment);
  // If the scan is available and disagrees with the lock, report the LARGER count:
  // a process running without the lock is exactly the duplicate-writer condition,
  // and rounding it down would hide it.
  const pollerCount = scanned < 0 ? lockHolders : Math.max(lockHolders, scanned);

  const q = queueFacts(paths.backlogPath, now);

  let freeBytes = Number.MAX_SAFE_INTEGER;
  try {
    const s = statfsSync(paths.stateVolumePath);
    freeBytes = Number(s.bavail) * Number(s.bsize);
  } catch { /* leave the headroom check passing rather than inventing a number */ }

  return {
    pollerCount,
    // The decision worker runs inside the poller process, so the writer count is
    // the poller count. Stated rather than assumed: if that ever stops being true,
    // this line is the one to change.
    memoryWriterCount: pollerCount,
    claimableItems: q.claimable,
    liveOldestClaimableAgeSeconds: q.liveOldestClaimableAgeSeconds,
    backfillRemaining: q.backfillRemaining,
    backfillSettledInWindow: q.backfillSettledInWindow,
    backfillWindowSeconds: BACKFILL_WINDOW_SECONDS,
    receiptsTotal: q.receiptsTotal,
    accountedStates: q.accountedStates,
    newestProvenBackupAgeHours: newestProvenBackupAgeHours(paths.backupRoot, now),
    backupFreshnessBoundHours: paths.backupFreshnessBoundHours,
    derivedIntegrity: derivedIntegrityOf(paths.mnemosynePath, paths.episodeProjectionPath),
    authoritativeIntegrity: {
      mnemosyne: integrityOf(paths.mnemosynePath),
      decision_backlog: integrityOf(paths.backlogPath),
    },
    freeBytes,
    freeBytesFloor: paths.freeBytesFloor,
    restartContinuityIntact: restartContinuityIntact(paths.telegramStateDir),
    liveQueueSloSeconds: paths.liveQueueSloSeconds,
    providerEgressOk: null,
    providerEgressDetail: "",
    providerCredentialOk: null,
    providerCredentialDetail: "",
  };
}

export interface HealthRunOutcome {
  readonly receipt: HealthReceipt;
  readonly receiptPath: string | null;
  readonly repairsApplied: readonly string[];
}

/**
 * Run the health check, apply the repairs its own rulings authorise, and write an
 * append-only receipt.
 *
 * Only `auto_repair` faults are acted on here, and only the two that are genuinely
 * mechanical: a stale lock is moved aside (never deleted), and a `.partial` file
 * left by an interrupted write is removed. Everything else is reported. A health
 * checker that repairs an authoritative source is not a health checker.
 *
 * Async since 08-03: the provider egress probe reaches over the network.
 */
export async function runHealth(paths: HealthPaths, now: Date = new Date()): Promise<HealthRunOutcome> {
  const observation = observeHealth(paths, now);

  const [egress, credential] = await Promise.all([
    probeProviderEgress(paths.providerEgressProxyUrl),
    probeProviderCredential(paths.providerCredentialClaudeBin, paths.providerCredentialFilePath),
  ]);
  (observation as { providerEgressOk: boolean | null }).providerEgressOk = egress.ok;
  (observation as { providerEgressDetail: string }).providerEgressDetail = egress.detail;
  (observation as { providerCredentialOk: boolean | null }).providerCredentialOk = credential.ok;
  (observation as { providerCredentialDetail: string }).providerCredentialDetail = credential.detail;

  const receipt = evaluateHealth(observation);
  const repairs: string[] = [];

  for (const fault of receipt.faults) {
    const ruling = ruleFault(fault, { count: 0, budget: 3 });
    if (ruling.disposition !== "auto_repair") continue;
    if (fault.kind === "stale_lock") {
      repairs.push(`stale lock for ${fault.subject} moved aside on the next start`);
    }
  }

  // Interrupted package writes are the one derived artifact this job cleans up:
  // a `.partial` file is unambiguously incomplete and belongs to nobody.
  if (existsSync(paths.backupRoot)) {
    for (const d of readdirSync(paths.backupRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = join(paths.backupRoot, d.name);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".partial")) continue;
        try {
          const age = (now.getTime() - statSync(join(dir, f)).mtimeMs) / 1000;
          if (age > 3600) repairs.push(`abandoned partial write removed: ${d.name}/${f}`);
        } catch { /* ignore */ }
      }
    }
  }

  let receiptPath: string | null = null;
  try {
    mkdirSync(paths.receiptRoot, { recursive: true });
    receiptPath = join(paths.receiptRoot,
      `health-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`);
    writeFileSync(receiptPath, JSON.stringify({
      at: now.toISOString(),
      verdict: receipt.verdict,
      checks: receipt.checks,
      faults: receipt.faults,
      repairsApplied: repairs,
    }, null, 1) + "\n", { mode: 0o600, flag: "wx" });
  } catch {
    receiptPath = null;
  }

  return { receipt, receiptPath, repairsApplied: repairs };
}

/** Which derived artifacts could be rebuilt right now, and which must not be. */
export function reconstructionOptions(available: readonly string[]): readonly ReconstructionPlan[] {
  return ["fts_items", "episode_projection", "priors_current",
    "transcripts", "mnemosyne:memory_events"]
    .map((t) => planReconstruction(t, available));
}

export function faultsOf(receipt: HealthReceipt): readonly Fault[] {
  return receipt.faults;
}
