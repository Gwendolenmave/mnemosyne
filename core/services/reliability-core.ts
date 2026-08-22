/**
 * T05C — unattended reliability, as pure decisions.
 *
 * The whole tranche turns on one distinction, and getting it wrong in either
 * direction is a failure:
 *
 *   REPAIRABLE   an ordinary, recoverable fault. The system fixes it and says
 *                nothing. A disk that filled, a derived cache that got corrupted,
 *                a provider that timed out, a stale lock from a killed process.
 *                These must not wake Owner up.
 *
 *   FAIL CLOSED  a fault where continuing could destroy truth. Suspected mutation
 *                of an authoritative source, a containment breach, or a recovery
 *                whose destructive step is ambiguous. These stop the affected path
 *                and PRESERVE the last known good system, even at the cost of
 *                running degraded.
 *
 * Nothing here touches the filesystem, spawns anything or reads a clock it was not
 * given. The adapters observe; this decides; the receipt records both.
 */

// ---------------------------------------------------------------------------
// Fault taxonomy
// ---------------------------------------------------------------------------

export type FaultKind =
  /** the volume holding durable state is full */
  | "disk_full"
  /** the durable state tree is mounted read-only, or lost write permission */
  | "read_only_filesystem"
  /** a DERIVED artifact (cache, index, projection) failed its integrity check */
  | "corrupt_derived_state"
  /** an AUTHORITATIVE source failed its integrity check */
  | "corrupt_authoritative_state"
  /** a write was interrupted: a `.partial` file, a torn record, a short tail */
  | "partial_write"
  /** the model provider is unreachable, timing out, or rate-limited */
  | "provider_outage"
  /** a lock file exists whose holder is gone */
  | "stale_lock"
  /** more than one live poller or writer was observed */
  | "duplicate_writer"
  /** the queue stopped draining while items remain claimable */
  | "queue_stalled"
  /** the newest proven backup is older than the freshness bound */
  | "backup_stale"
  /** an authoritative source changed in a way nothing authorised */
  | "unexplained_truth_mutation"
  /** a containment boundary (root, path, capability) was crossed */
  | "containment_breach";

export const FAULT_KINDS: readonly FaultKind[] = [
  "disk_full", "read_only_filesystem", "corrupt_derived_state",
  "corrupt_authoritative_state", "partial_write", "provider_outage", "stale_lock",
  "duplicate_writer", "queue_stalled", "backup_stale",
  "unexplained_truth_mutation", "containment_breach",
] as const;

export type FaultDisposition =
  /** repair automatically, record it, stay silent */
  | "auto_repair"
  /** retry with bounded backoff; not a fault until the budget is exhausted */
  | "retry_bounded"
  /** stop the affected path, keep the rest running, tell the operator */
  | "fail_closed_degraded"
  /** stop the affected path and refuse to proceed at all until a human decides */
  | "fail_closed_halt";

/**
 * The disposition table, as DATA.
 *
 * Written as an exhaustive record rather than a switch so that adding a fault kind
 * without deciding its disposition is a compile error. The last four rows are the
 * ones that must never quietly become `auto_repair`: an automatic "repair" of an
 * authoritative source is indistinguishable from data destruction, and the T05A
 * rounds established that a derived repair which acquires content authority is how
 * every one of those incidents began.
 */
export const DISPOSITION: Readonly<Record<FaultKind, FaultDisposition>> = {
  disk_full: "auto_repair",
  read_only_filesystem: "fail_closed_degraded",
  corrupt_derived_state: "auto_repair",
  partial_write: "auto_repair",
  stale_lock: "auto_repair",
  provider_outage: "retry_bounded",
  queue_stalled: "retry_bounded",
  backup_stale: "fail_closed_degraded",
  duplicate_writer: "fail_closed_halt",
  corrupt_authoritative_state: "fail_closed_halt",
  unexplained_truth_mutation: "fail_closed_halt",
  containment_breach: "fail_closed_halt",
};

/** A fault kind whose disposition may NEVER be automatic. Asserted in tests. */
export const NEVER_AUTO_REPAIR: readonly FaultKind[] = [
  "corrupt_authoritative_state", "unexplained_truth_mutation",
  "containment_breach", "duplicate_writer", "read_only_filesystem",
] as const;

export interface Fault {
  readonly kind: FaultKind;
  /** what was observed, in machine terms; never private content */
  readonly detail: string;
  /** the logical subject: a root name, a database name, a job id */
  readonly subject: string;
}

export interface FaultRuling {
  readonly fault: Fault;
  readonly disposition: FaultDisposition;
  /** whether the operator must be told; auto_repair and in-budget retries are silent */
  readonly notifyOperator: boolean;
  /** what the system will do, named so a receipt can be read without the code */
  readonly action: string;
}

export function ruleFault(fault: Fault, attempt: { readonly count: number; readonly budget: number }): FaultRuling {
  const disposition = DISPOSITION[fault.kind];
  if (disposition === "retry_bounded") {
    const exhausted = attempt.count >= attempt.budget;
    return {
      fault,
      disposition: exhausted ? "fail_closed_degraded" : "retry_bounded",
      notifyOperator: exhausted,
      action: exhausted
        ? `retry budget ${attempt.budget} exhausted; ${fault.subject} isolated, the rest keeps running`
        : `retry ${attempt.count + 1}/${attempt.budget} with backoff`,
    };
  }
  return {
    fault,
    disposition,
    notifyOperator: disposition !== "auto_repair",
    action: disposition === "auto_repair"
      ? `repair ${fault.subject} automatically and record it`
      : disposition === "fail_closed_degraded"
        ? `isolate ${fault.subject}; preserve the last known good system`
        : `HALT the ${fault.subject} path; a human decides before anything else touches it`,
  };
}

/** Exponential backoff with a ceiling. Deterministic: the caller supplies the jitter. */
export function backoffMs(attempt: number, jitter01: number): number {
  const base = Math.min(30 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  // Jitter spreads a fleet; with one host it mostly avoids a retry landing on the
  // same second as the scheduled job every time.
  return Math.round(base * (0.75 + 0.5 * Math.min(1, Math.max(0, jitter01))));
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthCheckId =
  | "single_poller"
  | "single_memory_writer"
  /** LIVE turns must be decided promptly: this is the latency that Owner feels */
  | "live_queue_latency"
  /** the historical backfill must be MOVING; its age is expected to be large */
  | "backfill_progressing"
  | "no_silent_drops"
  | "backup_freshness"
  | "derived_state_integrity"
  | "authoritative_integrity"
  | "disk_headroom"
  | "restart_continuity"
  /** the egress path to the model provider (api.anthropic.com) is reachable */
  | "provider_egress"
  /** the CLI binary is functional and holds valid credentials */
  | "provider_credential";

export const HEALTH_CHECK_IDS: readonly HealthCheckId[] = [
  "single_poller", "single_memory_writer", "live_queue_latency", "backfill_progressing",
  "no_silent_drops", "backup_freshness", "derived_state_integrity",
  "authoritative_integrity", "disk_headroom", "restart_continuity", "provider_egress",
  "provider_credential",
] as const;

/** Adding a check id without listing it above is a compile error. */
const _HEALTH_EXHAUSTIVE: Record<HealthCheckId, true> = {
  single_poller: true, single_memory_writer: true, live_queue_latency: true,
  backfill_progressing: true, no_silent_drops: true, backup_freshness: true,
  derived_state_integrity: true, authoritative_integrity: true, disk_headroom: true,
  restart_continuity: true, provider_egress: true, provider_credential: true,
};
void _HEALTH_EXHAUSTIVE;

export interface HealthObservation {
  readonly pollerCount: number;
  readonly memoryWriterCount: number;
  /** items claimable right now, across both origins */
  readonly claimableItems: number;
  /**
   * How long the oldest claimable LIVE turn has waited. This is the number that
   * matters to Owner: a turn she just had should become memory within the hour.
   */
  readonly liveOldestClaimableAgeSeconds: number | null;
  /** claimable backfill items, and whether any settled in the measured window */
  readonly backfillRemaining: number;
  readonly backfillSettledInWindow: number;
  /**
   * How far back the settled-in-window count looks. The backfill is measured by
   * MOVEMENT, not by the age of its oldest item: an 871-item historical recovery
   * draining correctly over two days always has an oldest item many hours old, so
   * an age-based SLO would alert continuously for the entire expected duration.
   * An alarm that is always on is an alarm Owner mutes, and then the real one is
   * invisible too.
   */
  readonly backfillWindowSeconds: number;
  /**
   * Arithmetic completeness of the durable queue: every receipt must be in exactly
   * one durable state. `receiptsTotal` vs the sum of terminal + in-flight states.
   */
  readonly receiptsTotal: number;
  readonly accountedStates: number;
  readonly newestProvenBackupAgeHours: number | null;
  readonly backupFreshnessBoundHours: number;
  /** logical name → `PRAGMA integrity_check` result, for DERIVED artifacts */
  readonly derivedIntegrity: Readonly<Record<string, string>>;
  /** logical name → integrity result, for AUTHORITATIVE sources */
  readonly authoritativeIntegrity: Readonly<Record<string, string>>;
  readonly freeBytes: number;
  readonly freeBytesFloor: number;
  /** whether the durable offset/pass state survived the last restart */
  readonly restartContinuityIntact: boolean;
  /** the SLO for a LIVE turn to be decided */
  readonly liveQueueSloSeconds: number;
  /**
   * Whether the egress path to the model provider (api.anthropic.com:443) is
   * reachable through the configured HTTPS_PROXY. `null` means the probe was not
   * run (e.g. no proxy configured and direct connectivity wasn't tested).
   *
   * The 08-03 incident: Telegram was reachable but Anthropic was not for 4.5 hours.
   * The bot could hear messages but every reply attempt timed out. Neither the bridge
   * health check nor this job detected it because both only probed Telegram.
   */
  readonly providerEgressOk: boolean | null;
  /** when providerEgressOk is false, a one-line explanation of what failed */
  readonly providerEgressDetail: string;
  /**
   * Whether the model provider CLI binary is functional and holds valid credentials.
   * `null` means the probe was not run (no DELOS_CLAUDE_BIN configured).
   *
   * The 08-03 incident root cause: credentials at ~/.claude/.credentials.json were
   * corrupted by a failed token refresh during the network outage (mtime 19:39).
   * After the network recovered at 20:16, the bot still couldn't respond because
   * every CLI invocation exited with "Not logged in · Please run /login".
   * The network egress probe (provider_egress) was green throughout — this check
   * covers the credential segment that the network check cannot see.
   */
  readonly providerCredentialOk: boolean | null;
  readonly providerCredentialDetail: string;
}

export interface HealthCheck {
  readonly id: HealthCheckId;
  readonly ok: boolean;
  readonly detail: string;
  /** the fault this check raises when it fails; null when the check passes */
  readonly fault: Fault | null;
}

export interface HealthReceipt {
  readonly checks: readonly HealthCheck[];
  readonly verdict: "HEALTHY" | "DEGRADED" | "HALT";
  readonly faults: readonly Fault[];
  /** the one-line operator message, or "" when nothing needs saying */
  readonly operatorLine: string;
}

/**
 * Evaluate health. Every check names the fault it raises, so the receipt is
 * actionable rather than a list of booleans, and so `ruleFault` decides the
 * response in exactly one place.
 *
 * The `queue_draining` check is deliberately not "the queue is empty": an empty
 * queue and a queue that is moving are both healthy, and a queue that is FULL but
 * stalled is the failure. `no_silent_drops` is separate and stricter: it checks the
 * arithmetic, because a drop looks exactly like a smaller queue.
 */
export function evaluateHealth(o: HealthObservation): HealthReceipt {
  const checks: HealthCheck[] = [];
  const add = (
    id: HealthCheckId, ok: boolean, detail: string, fault: Fault | null,
  ): void => { checks.push({ id, ok, detail, fault: ok ? null : fault }); };

  add("single_poller", o.pollerCount === 1,
    `${o.pollerCount} poller(s)`,
    { kind: o.pollerCount > 1 ? "duplicate_writer" : "queue_stalled",
      detail: `pollerCount=${o.pollerCount}`, subject: "telegram_poller" });

  add("single_memory_writer", o.memoryWriterCount <= 1,
    `${o.memoryWriterCount} memory writer(s)`,
    { kind: "duplicate_writer", detail: `memoryWriterCount=${o.memoryWriterCount}`,
      subject: "memory_writer" });

  const liveLate = o.liveOldestClaimableAgeSeconds !== null
    && o.liveOldestClaimableAgeSeconds > o.liveQueueSloSeconds;
  add("live_queue_latency", !liveLate,
    o.liveOldestClaimableAgeSeconds === null
      ? "no live turn is waiting"
      : `oldest live turn ${o.liveOldestClaimableAgeSeconds}s `
        + `(SLO ${o.liveQueueSloSeconds}s)`,
    { kind: "queue_stalled",
      detail: `live_oldest=${String(o.liveOldestClaimableAgeSeconds)}s`,
      subject: "live_decision_queue" });

  // Progress, not age. Work remaining with nothing settled in the window is a
  // stall; work remaining that is moving is a backlog doing its job.
  const backfillStalled = o.backfillRemaining > 0 && o.backfillSettledInWindow === 0;
  add("backfill_progressing", !backfillStalled,
    o.backfillRemaining === 0
      ? "historical recovery is complete"
      : `${o.backfillRemaining} remaining, ${o.backfillSettledInWindow} settled in the `
        + `last ${Math.round(o.backfillWindowSeconds / 3600)}h`,
    { kind: "queue_stalled",
      detail: `remaining=${o.backfillRemaining} settled_in_window=0`,
      subject: "historical_recovery" });

  add("no_silent_drops", o.receiptsTotal === o.accountedStates,
    `${o.accountedStates}/${o.receiptsTotal} receipts accounted`,
    { kind: "unexplained_truth_mutation",
      detail: `receipts=${o.receiptsTotal} accounted=${o.accountedStates}`,
      subject: "decision_backlog" });

  const backupOk = o.newestProvenBackupAgeHours !== null
    && o.newestProvenBackupAgeHours <= o.backupFreshnessBoundHours;
  add("backup_freshness", backupOk,
    o.newestProvenBackupAgeHours === null
      ? "no proven backup"
      : `newest proven backup ${Math.floor(o.newestProvenBackupAgeHours)}h old (bound ${o.backupFreshnessBoundHours}h)`,
    { kind: "backup_stale",
      detail: o.newestProvenBackupAgeHours === null
        ? "none" : `${Math.floor(o.newestProvenBackupAgeHours)}h`,
      subject: "backup" });

  const badDerived = Object.entries(o.derivedIntegrity).filter(([, v]) => v !== "ok");
  add("derived_state_integrity", badDerived.length === 0,
    badDerived.length === 0
      ? `${Object.keys(o.derivedIntegrity).length}_derived_ok`
      : badDerived.map(([k, v]) => `${k}=${v}`).join(", "),
    { kind: "corrupt_derived_state", detail: badDerived.map(([k]) => k).join(","),
      subject: badDerived.map(([k]) => k).join(",") || "derived" });

  const badAuth = Object.entries(o.authoritativeIntegrity).filter(([, v]) => v !== "ok");
  const noAuth = Object.keys(o.authoritativeIntegrity).length === 0;
  add("authoritative_integrity", !noAuth && badAuth.length === 0,
    noAuth
      ? "no authoritative source was checked — an empty set is not a pass"
      : badAuth.length === 0
        ? `${Object.keys(o.authoritativeIntegrity).length}_authoritative_ok`
        : badAuth.map(([k, v]) => `${k}=${v}`).join(", "),
    { kind: "corrupt_authoritative_state",
      detail: noAuth ? "nothing_checked" : badAuth.map(([k]) => k).join(","),
      subject: badAuth.map(([k]) => k).join(",") || "authoritative" });

  add("disk_headroom", o.freeBytes >= o.freeBytesFloor,
    `${o.freeBytes} B free (floor ${o.freeBytesFloor} B)`,
    { kind: "disk_full", detail: `${o.freeBytes}B`, subject: "state_volume" });

  add("restart_continuity", o.restartContinuityIntact,
    o.restartContinuityIntact ? "durable state survived the last restart" : "durable state was lost",
    { kind: "partial_write", detail: "restart lost durable state", subject: "telegram_state" });

  const egressOk = o.providerEgressOk !== false;
  add("provider_egress", egressOk,
    o.providerEgressOk === null
      ? "provider egress probe not run"
      : o.providerEgressOk
        ? "api.anthropic.com reachable via egress proxy"
        : `provider egress FAIL: ${o.providerEgressDetail}`,
    { kind: "provider_outage",
      detail: o.providerEgressDetail || "api.anthropic.com unreachable via HTTPS_PROXY",
      subject: "provider_egress" });

  const credOk = o.providerCredentialOk !== false;
  add("provider_credential", credOk,
    o.providerCredentialOk === null
      ? "provider credential probe not run"
      : o.providerCredentialOk
        ? "CLI binary functional with valid credentials"
        : `provider credential FAIL: ${o.providerCredentialDetail}`,
    { kind: "provider_outage",
      detail: o.providerCredentialDetail || "CLI binary missing or credentials invalid",
      subject: "provider_credential" });

  const faults = checks.filter((c) => !c.ok && c.fault !== null).map((c) => c.fault!);

  /**
   * The health check is a periodic OBSERVER, not the retry loop.
   *
   * `ruleFault` is right for the worker: a provider timeout inside budget is a
   * retry, not an incident. It is wrong here, and the first version of this
   * function got it wrong in a way that mattered: it called `ruleFault` with a
   * hardcoded `count: 0`, so every `retry_bounded` fault looked in-budget forever.
   * The live run then printed `FAIL queue_draining` — the oldest claimable item
   * past its SLO — directly above `verdict HEALTHY`, and nothing would ever have
   * escalated it.
   *
   * By the time this observer sees a retryable condition, the machinery whose job
   * was to retry it has ALREADY failed to keep up. So a retryable fault observed
   * here is at least DEGRADED. Only `auto_repair` stays silent.
   */
  const rulings = faults.map((f) => {
    const base = ruleFault(f, { count: 0, budget: 3 });
    if (base.disposition !== "retry_bounded") return base;
    return {
      ...base,
      disposition: "fail_closed_degraded" as FaultDisposition,
      notifyOperator: true,
      action: `${f.subject} is behind its own retry machinery; isolated, the rest keeps running`,
    };
  });
  const verdict = rulings.some((r) => r.disposition === "fail_closed_halt")
    ? "HALT"
    : rulings.some((r) => r.disposition === "fail_closed_degraded") ? "DEGRADED" : "HEALTHY";

  // Exception-only: an auto-repairable fault is recorded in the receipt and NOT
  // put in front of the operator. A HEALTHY verdict with repairs behind it is the
  // normal, silent case this whole tranche exists to produce.
  const speak = rulings.filter((r) => r.notifyOperator);
  const operatorLine = speak.length === 0 ? ""
    : speak.map((r) => `[${r.fault.kind}] ${r.fault.subject}: ${r.fault.detail} → ${r.action}`).join("\n");

  return { checks, verdict, faults, operatorLine };
}

// ---------------------------------------------------------------------------
// Derived-state reconstruction
// ---------------------------------------------------------------------------

/**
 * What may be rebuilt from what.
 *
 * The rule that makes reconstruction safe: a derived artifact is rebuilt ONLY from
 * authoritative inputs, and the rebuild is idempotent — running it twice produces
 * the same bytes. Anything that would need to invent a value it cannot derive is
 * not a reconstruction, and the plan below refuses rather than guessing.
 */
export interface ReconstructionPlan {
  readonly target: string;
  readonly derivedFrom: readonly string[];
  readonly safe: boolean;
  readonly refusal: string | null;
}

export const DERIVED_ARTIFACTS: Readonly<Record<string, readonly string[]>> = {
  fts_items: ["mnemosyne:memory_items", "mnemosyne:memory_tags"],
  episode_projection: ["transcripts", "mnemosyne:memory_events"],
  priors_current: ["mnemosyne:memory_events"],
};

/** Authoritative sources: never reconstructed, only restored from a backup. */
export const AUTHORITATIVE_SOURCES: readonly string[] = [
  "transcripts", "mnemosyne:memory_events", "backlog:backlog_items",
  "backlog:backlog_receipts",
] as const;

export function planReconstruction(target: string, availableInputs: readonly string[]): ReconstructionPlan {
  if (AUTHORITATIVE_SOURCES.includes(target)) {
    return {
      target, derivedFrom: [], safe: false,
      refusal: "authoritative source: restore it from a proven backup, never rebuild it. "
        + "A rebuild would fabricate the truth it is supposed to preserve.",
    };
  }
  const inputs = DERIVED_ARTIFACTS[target];
  if (inputs === undefined) {
    return { target, derivedFrom: [], safe: false, refusal: "unknown artifact: not declared derivable" };
  }
  const missing = inputs.filter((i) => !availableInputs.includes(i));
  if (missing.length > 0) {
    return {
      target, derivedFrom: inputs, safe: false,
      refusal: `missing authoritative input(s): ${missing.join(", ")}`,
    };
  }
  return { target, derivedFrom: inputs, safe: true, refusal: null };
}
