/**
 * T05D — "how far along is it", answered without showing anything private.
 *
 * The live D0 slice already queues, decides and activates. What it has no way to
 * say is what Owner would actually ask: is the historical recovery moving, how fast,
 * and when will it be done. Without that, the honest answer to "is it working?" is
 * a database query, which fails the operator covenant.
 *
 * Two constraints shape everything here:
 *
 *   PRIVACY. A progress report is the kind of thing that ends up pasted into a
 *   chat, a receipt or a cloud file. So this module is structurally incapable of
 *   emitting content: it takes COUNTS and TIMESTAMPS, never bodies, titles,
 *   pointers or identities, and `formatProgress` is asserted against a content
 *   sentinel in the tests.
 *
 *   HONESTY ABOUT THE ESTIMATE. A completion estimate from a rate measured over a
 *   few minutes is a guess dressed as a fact. The estimate is therefore typed:
 *   it either has enough evidence or it says it does not, and there is no code path
 *   that produces a confident-looking number from three data points.
 */

/** Terminal states, restated here so this module needs no adapter import. */
export const PROGRESS_TERMINAL_STATES: readonly string[] = [
  "declined", "duplicate", "policy_activated", "quarantined", "failed_terminal",
] as const;

export const PROGRESS_CLAIMABLE_STATES: readonly string[] = [
  "deferred", "processing", "failed_retryable",
] as const;

/**
 * PARKED: durable, not lost, and not going anywhere on its own.
 *
 * `deferred_oversize` is a source too large for the summariser. `claimNext` does
 * not select it, and nothing settles it, so it is neither claimable nor terminal —
 * a third category that has to exist, because folding it into either one lies.
 *
 * Counted as claimable, a parked item would sit in the ETA forever and make the
 * estimate wrong. Counted as terminal, it would report as decided when nobody
 * decided it. Left out of both, it would show up as an unaccounted receipt, i.e.
 * as a LOSS — which is the loudest possible wrong answer.
 *
 * This category was added because T05D-L8 caught its absence: the D0 lane
 * introduced the state, the live suite went red, and the progress arithmetic would
 * otherwise have reported real parked items as missing data.
 */
export const PROGRESS_PARKED_STATES: readonly string[] = ["deferred_oversize"] as const;

export interface BacklogSnapshot {
  /** state → count, for one origin */
  readonly byState: Readonly<Record<string, number>>;
  /** distinct identities that ever entered the queue for this origin */
  readonly receipts: number;
}

export interface ProgressInput {
  readonly live: BacklogSnapshot;
  readonly backfill: BacklogSnapshot;
  /**
   * Terminal transitions per UTC hour bucket, newest first, as
   * `{ hour: "2026-08-02T15", settled: 41 }`. Rate is measured from these rather
   * than from a wall-clock delta, so a restart does not reset the measurement.
   */
  readonly hourlySettled: readonly { readonly hour: string; readonly settled: number }[];
  readonly nowIso: string;
  /** the configured per-hour provider budget, if any */
  readonly hourlyBudget: number | null;
}

export type EstimateConfidence =
  /** at least three complete hours of evidence, and the queue is shrinking */
  | "measured"
  /** some evidence, but too little to project honestly */
  | "insufficient_evidence"
  /** the queue is not shrinking at all */
  | "stalled"
  /** nothing left to do */
  | "complete";

export interface Progress {
  readonly liveRemaining: number;
  readonly liveSettled: number;
  readonly liveParked: number;
  readonly backfillRemaining: number;
  readonly backfillSettled: number;
  readonly backfillParked: number;
  readonly backfillTotal: number;
  /** 0..1, over the BACKFILL only; live turns are not a finite denominator */
  readonly backfillFraction: number;
  /** settled per hour, from complete hour buckets only */
  readonly ratePerHour: number | null;
  readonly hoursOfEvidence: number;
  readonly confidence: EstimateConfidence;
  /** ISO instant, only when confidence is "measured" */
  readonly estimatedCompletionIso: string | null;
  /** every identity in exactly one durable state, per origin */
  readonly arithmeticCloses: boolean;
  readonly unaccounted: number;
}

function sumOf(byState: Readonly<Record<string, number>>, states: readonly string[]): number {
  return states.reduce((n, s) => n + (byState[s] ?? 0), 0);
}

/**
 * Compute progress.
 *
 * The rate excludes the CURRENT hour bucket, which is incomplete by definition —
 * including it makes the rate dip every time the report runs early in an hour, and
 * a rate that changes because you looked at it is not a measurement.
 */
export function computeProgress(input: ProgressInput): Progress {
  const liveRemaining = sumOf(input.live.byState, PROGRESS_CLAIMABLE_STATES);
  const liveSettled = sumOf(input.live.byState, PROGRESS_TERMINAL_STATES);
  const liveParked = sumOf(input.live.byState, PROGRESS_PARKED_STATES);
  const backfillRemaining = sumOf(input.backfill.byState, PROGRESS_CLAIMABLE_STATES);
  const backfillSettled = sumOf(input.backfill.byState, PROGRESS_TERMINAL_STATES);
  const backfillParked = sumOf(input.backfill.byState, PROGRESS_PARKED_STATES);
  // Parked items belong in the denominator — they entered the queue — but not in
  // the drainable remainder, because the measured rate will never consume them.
  const backfillTotal = backfillRemaining + backfillSettled + backfillParked;

  const accounted = liveRemaining + liveSettled + liveParked
    + backfillRemaining + backfillSettled + backfillParked;
  const receipts = input.live.receipts + input.backfill.receipts;

  const currentHour = input.nowIso.slice(0, 13);
  const complete = input.hourlySettled.filter((h) => h.hour !== currentHour);
  const hoursOfEvidence = complete.length;
  const ratePerHour = hoursOfEvidence === 0
    ? null
    : complete.reduce((n, h) => n + h.settled, 0) / hoursOfEvidence;

  let confidence: EstimateConfidence;
  let estimatedCompletionIso: string | null = null;
  if (backfillRemaining === 0) {
    confidence = "complete";
  } else if (ratePerHour === null || ratePerHour <= 0) {
    confidence = "stalled";
  } else if (hoursOfEvidence < 3) {
    // Three complete hours is the minimum this module will project from. Below
    // that the number would be arithmetic, not evidence.
    confidence = "insufficient_evidence";
  } else {
    confidence = "measured";
    const hours = backfillRemaining / ratePerHour;
    estimatedCompletionIso =
      new Date(Date.parse(input.nowIso) + hours * 3_600_000).toISOString();
  }

  return {
    liveRemaining, liveSettled, liveParked,
    backfillRemaining, backfillSettled, backfillParked, backfillTotal,
    backfillFraction: backfillTotal === 0 ? 1 : backfillSettled / backfillTotal,
    ratePerHour, hoursOfEvidence, confidence, estimatedCompletionIso,
    arithmeticCloses: accounted === receipts,
    unaccounted: receipts - accounted,
  };
}

/**
 * The operator-facing line.
 *
 * Counts, percentages, rates and one instant. No identity, pointer, title or body
 * can reach this string, because none of them is in `Progress` to begin with —
 * which is a stronger guarantee than remembering to redact.
 */
export function formatProgress(p: Progress): string {
  const pct = (p.backfillFraction * 100).toFixed(1);
  const lines: string[] = [];
  lines.push(`historical recovery  ${p.backfillSettled}/${p.backfillTotal} (${pct}%), `
    + `${p.backfillRemaining} remaining`);
  lines.push(`live turns           ${p.liveSettled} decided, ${p.liveRemaining} in the queue`);
  const parked = p.liveParked + p.backfillParked;
  if (parked > 0) {
    // Named separately and never folded into either bucket: a parked item is
    // durable and undecided, and it will not move without a change upstream.
    lines.push(`parked               ${parked} source(s) too large to summarise — `
      + "durable, undecided, and not draining at any rate");
  }
  if (p.ratePerHour !== null) {
    lines.push(`rate                 ${p.ratePerHour.toFixed(1)}/hour `
      + `over ${p.hoursOfEvidence} complete hour(s)`);
  } else {
    lines.push("rate                 no complete hour of evidence yet");
  }
  switch (p.confidence) {
    case "complete":
      lines.push("estimate             historical recovery is finished");
      break;
    case "measured":
      lines.push(`estimate             ${p.estimatedCompletionIso} at the measured rate`);
      break;
    case "insufficient_evidence":
      lines.push(`estimate             withheld: ${p.hoursOfEvidence} complete hour(s) of `
        + "evidence is not enough to project from");
      break;
    case "stalled":
      lines.push("estimate             the queue is NOT draining — nothing settled in the "
        + "measured window");
      break;
  }
  if (!p.arithmeticCloses) {
    lines.push(`INTEGRITY            ${p.unaccounted} identit(ies) have a receipt but no `
      + "durable state — this is a loss, not a backlog");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The distinctness invariants §4.4 requires
// ---------------------------------------------------------------------------

/** Evidence basis: how the system came to believe something. */
export const EVIDENCE_BASES: readonly string[] = [
  "explicit", "observed", "inferred", "imported",
] as const;

/** Approval state: who, if anyone, agreed to it. */
export const APPROVAL_STATES: readonly string[] = [
  "candidate", "confirmed", "policy_activated", "declined", "quarantined",
] as const;

/** Lifecycle state: whether it is currently part of the world. */
export const LIFECYCLE_STATES: readonly string[] = [
  "active", "superseded", "expired", "revoked",
] as const;

/**
 * The three axes are INDEPENDENT, and collapsing any pair is a real bug with a
 * real consequence:
 *
 *   basis × approval    "observed" is not "unconfirmed". A policy-activated
 *                       observed card is active; conflating them would either
 *                       block it or promote it to confirmed, and confirmed carries
 *                       Owner's name.
 *   approval × lifecycle A revoked card was still confirmed once. Overwriting the
 *                       approval state on revocation destroys the record of who
 *                       agreed to what.
 *   declined × quarantined  A declined item was judged not worth keeping; a
 *                       quarantined one was refused on content grounds. Neither
 *                       may become active memory, and merging them loses the
 *                       reason — which is the only thing that tells you whether
 *                       a rule needs changing.
 */
export function axesAreIndependent(): boolean {
  const overlap = (a: readonly string[], b: readonly string[]): string[] =>
    a.filter((x) => b.includes(x));
  return overlap(EVIDENCE_BASES, APPROVAL_STATES).length === 0
    && overlap(EVIDENCE_BASES, LIFECYCLE_STATES).length === 0
    // `declined` and `quarantined` are approval outcomes, never lifecycle values:
    // an item can be declined AND its record active-in-history.
    && overlap(APPROVAL_STATES, LIFECYCLE_STATES).length === 0;
}

// ---------------------------------------------------------------------------
// The provider-call invariant
// ---------------------------------------------------------------------------

export interface CallRecord {
  readonly identity: string;
  readonly reservedAt: string;
  readonly settledAt: string | null;
  readonly outcome: string | null;
}

export interface TransitionRecord {
  readonly identity: string;
  readonly at: string;
  readonly fromState: string | null;
  readonly toState: string;
}

export type CallVerdict =
  /** one call, one decision: the ordinary case */
  | "single_call"
  /** more than one call, each following an attempt that committed nothing */
  | "explained_redial"
  /** a call was made after a card had already been committed: a real duplicate */
  | "duplicate_after_commit"
  /** more calls than non-committing attempts can account for */
  | "unexplained_extra_calls";

export interface CallAudit {
  readonly identity: string;
  readonly calls: number;
  readonly settled: number;
  readonly verdict: CallVerdict;
  readonly detail: string;
}

/**
 * Audit provider calls against the receipt chain.
 *
 * "Without duplicate provider calls" cannot mean "at most one call per identity":
 * the crash-recovery contract REQUIRES a re-dial when an attempt produced a
 * decision the sink then refused, because nothing was committed and the item must
 * still be decided. What it does mean is:
 *
 *   1. no call may be reserved after a card was committed for that identity, and
 *   2. the number of settled calls may not exceed the number of attempts that
 *      demonstrably committed nothing, plus one.
 *
 * Rule 1 is the one that costs money and creates duplicate cards; rule 2 catches a
 * retry loop that has stopped being accounted for. Stating both is the point —
 * "at most one call" would have flagged eleven correct re-dials as defects.
 */
export function auditProviderCalls(
  calls: readonly CallRecord[],
  transitions: readonly TransitionRecord[],
): readonly CallAudit[] {
  const byIdentity = new Map<string, CallRecord[]>();
  for (const c of calls) {
    const list = byIdentity.get(c.identity) ?? [];
    list.push(c);
    byIdentity.set(c.identity, list);
  }
  const out: CallAudit[] = [];
  for (const [identity, list] of [...byIdentity.entries()].sort()) {
    const sorted = [...list].sort((a, b) => (a.reservedAt < b.reservedAt ? -1 : 1));
    const settled = sorted.filter((c) => c.settledAt !== null);
    const chain = transitions.filter((t) => t.identity === identity)
      .sort((a, b) => (a.at < b.at ? -1 : 1));

    const commit = chain.find((t) => t.toState === "policy_activated" || t.toState === "duplicate");
    const afterCommit = commit === undefined
      ? [] : sorted.filter((c) => c.reservedAt > commit.at);
    if (afterCommit.length > 0) {
      out.push({
        identity, calls: sorted.length, settled: settled.length,
        verdict: "duplicate_after_commit",
        detail: `${afterCommit.length} call(s) reserved after the card was committed at ${commit!.at}`,
      });
      continue;
    }
    if (sorted.length <= 1) {
      out.push({ identity, calls: sorted.length, settled: settled.length,
        verdict: "single_call", detail: "one call, one decision" });
      continue;
    }
    // An attempt that committed nothing: it left the item retryable rather than
    // terminal, so the next call is the same decision being made again, not a
    // second decision.
    const nonCommitting = chain.filter((t) => t.toState === "failed_retryable").length;
    if (settled.length <= nonCommitting + 1) {
      out.push({
        identity, calls: sorted.length, settled: settled.length,
        verdict: "explained_redial",
        detail: `${settled.length} settled call(s) after ${nonCommitting} non-committing attempt(s)`,
      });
    } else {
      out.push({
        identity, calls: sorted.length, settled: settled.length,
        verdict: "unexplained_extra_calls",
        detail: `${settled.length} settled call(s) but only ${nonCommitting} non-committing attempt(s)`,
      });
    }
  }
  return out;
}

/** Which approval states may ever be READ back into a context window. */
export const RETRIEVABLE_APPROVAL_STATES: readonly string[] = ["confirmed", "policy_activated"] as const;

/** Which approval states must NEVER be retrievable, whatever else is true. */
export const NEVER_RETRIEVABLE_APPROVAL_STATES: readonly string[] = [
  "candidate", "declined", "quarantined",
] as const;
