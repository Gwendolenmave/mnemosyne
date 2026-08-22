import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_STATES, auditProviderCalls, axesAreIndependent, type CallRecord, computeProgress,
  EVIDENCE_BASES, formatProgress, LIFECYCLE_STATES, NEVER_RETRIEVABLE_APPROVAL_STATES,
  PROGRESS_CLAIMABLE_STATES, PROGRESS_PARKED_STATES, PROGRESS_TERMINAL_STATES,
  RETRIEVABLE_APPROVAL_STATES, type ProgressInput, type TransitionRecord,
} from "../core/services/backlog-progress.js";
import { readProgressInput } from "../adapters/runtime/cli/backlog-status-main.js";
import { BACKLOG_STATES, TERMINAL_STATES } from "../adapters/automation/decision-backlog.js";
import { isEligible, trustRank, type MemoryItemView } from "../core/services/anamnesis.js";

/**
 * T05D — the automatic write/govern/retrieve loop, as invariants.
 *
 * The live D0 slice is the first delivery of this tranche and is not re-implemented
 * here. What these rows add is the part that was missing: a truthful answer to
 * "how far along is it", and executable statements of the distinctions §4.4
 * requires the loop to preserve. Every row runs against synthetic data or against
 * the pure decision functions; none of them reads Owner's live memory.
 */

const CREATED: string[] = [];
process.on("exit", () => {
  for (const d of CREATED) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});
function dir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  CREATED.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Progress and the honesty of the estimate
// ---------------------------------------------------------------------------

function input(over?: Partial<ProgressInput>): ProgressInput {
  return {
    live: { byState: { deferred: 2, declined: 18, policy_activated: 5, quarantined: 10 }, receipts: 35 },
    backfill: { byState: { deferred: 847, declined: 22, quarantined: 1, processing: 1 }, receipts: 871 },
    hourlySettled: [
      { hour: "2026-08-02T15", settled: 41 },
      { hour: "2026-08-02T14", settled: 40 },
      { hour: "2026-08-02T13", settled: 44 },
      { hour: "2026-08-02T12", settled: 42 },
    ],
    nowIso: "2026-08-02T15:30:00.000Z",
    hourlyBudget: null,
    ...over,
  };
}

test("T05D-L1: progress is computed from the queue's own counters and closes arithmetically", () => {
  const p = computeProgress(input());
  assert.equal(p.backfillRemaining, 848, "deferred + processing");
  assert.equal(p.backfillSettled, 23);
  assert.equal(p.backfillTotal, 871);
  assert.equal(p.liveRemaining, 2);
  assert.equal(p.liveSettled, 33);
  assert.equal(p.arithmeticCloses, true);
  assert.equal(p.unaccounted, 0);
});

test("T05D-L2: the CURRENT hour is excluded from the rate", () => {
  // A rate that dips because the report ran at :05 is not a measurement. The
  // current bucket is incomplete by definition, so it never contributes.
  const p = computeProgress(input());
  assert.equal(p.hoursOfEvidence, 3, "15 is the current hour and is excluded");
  assert.equal(p.ratePerHour, (40 + 44 + 42) / 3);

  // Add a nearly-empty current hour: the rate must not move.
  const withPartial = computeProgress(input({
    hourlySettled: [{ hour: "2026-08-02T15", settled: 1 }, ...input().hourlySettled.slice(1)],
  }));
  assert.equal(withPartial.ratePerHour, p.ratePerHour,
    "the incomplete bucket cannot change the measured rate");
});

test("T05D-L3: an estimate is WITHHELD rather than guessed from too little evidence", () => {
  const thin = computeProgress(input({
    hourlySettled: [
      { hour: "2026-08-02T15", settled: 41 },
      { hour: "2026-08-02T14", settled: 40 },
      { hour: "2026-08-02T13", settled: 44 },
    ],
  }));
  assert.equal(thin.hoursOfEvidence, 2);
  assert.equal(thin.confidence, "insufficient_evidence");
  assert.equal(thin.estimatedCompletionIso, null,
    "there is no code path that projects from two hours");
  assert.match(formatProgress(thin), /withheld/);

  const enough = computeProgress(input());
  assert.equal(enough.confidence, "measured");
  assert.ok(enough.estimatedCompletionIso !== null);
  // 848 remaining at 42/hour ≈ 20.2 hours.
  const hours = (Date.parse(enough.estimatedCompletionIso!) - Date.parse(input().nowIso)) / 3_600_000;
  assert.ok(hours > 19 && hours < 21, `estimate ${hours}h should be ~20h`);
});

test("T05D-L4: a stalled queue is NAMED as stalled, not reported as slow", () => {
  const stalled = computeProgress(input({ hourlySettled: [] }));
  assert.equal(stalled.confidence, "stalled");
  assert.equal(stalled.ratePerHour, null);
  assert.match(formatProgress(stalled), /NOT draining/);

  const zero = computeProgress(input({
    hourlySettled: [
      { hour: "2026-08-02T14", settled: 0 },
      { hour: "2026-08-02T13", settled: 0 },
      { hour: "2026-08-02T12", settled: 0 },
    ],
  }));
  assert.equal(zero.confidence, "stalled", "three hours of nothing is stalled, not measured");

  const done = computeProgress(input({
    backfill: { byState: { declined: 871 }, receipts: 871 },
  }));
  assert.equal(done.confidence, "complete");
  assert.equal(done.backfillFraction, 1);
});

test("T05D-L5: a receipt with no durable state is reported as a LOSS, not as backlog", () => {
  const lossy = computeProgress(input({
    backfill: { byState: { deferred: 840, declined: 22 }, receipts: 871 },
  }));
  assert.equal(lossy.arithmeticCloses, false);
  assert.equal(lossy.unaccounted, 9);
  assert.match(formatProgress(lossy), /this is a loss, not a backlog/);
});

test("T05D-L6: the progress report is structurally incapable of leaking content", () => {
  // The strong version of the guarantee: the Progress type carries no identity,
  // pointer, title or body, so there is nothing to redact. This row proves it by
  // putting a sentinel everywhere a leak could come from and checking the output.
  const SENTINEL = "SYNTHETIC-PRIVATE-CONTENT-DO-NOT-PRINT";
  const p = computeProgress(input({
    // state NAMES are the only strings that reach the computation at all
    backfill: { byState: { [SENTINEL]: 5, deferred: 10, declined: 1 }, receipts: 16 },
  }));
  const text = formatProgress(p);
  assert.equal(text.includes(SENTINEL), false,
    "an unknown state name is counted in neither bucket and never printed");
  // …and because it matched no known state, it shows up as unaccounted rather than
  // being silently folded into a total. Failing loudly beats a tidy wrong number.
  assert.equal(p.arithmeticCloses, false);
  assert.equal(p.unaccounted, 5);
  assert.match(text, /INTEGRITY/);
});

// ---------------------------------------------------------------------------
// The distinctions §4.4 requires the loop to preserve
// ---------------------------------------------------------------------------

test("T05D-L7: evidence basis, approval state and lifecycle state stay independent", () => {
  assert.equal(axesAreIndependent(), true);
  assert.deepEqual([...EVIDENCE_BASES], ["explicit", "observed", "inferred", "imported"]);
  for (const a of APPROVAL_STATES) {
    assert.equal(EVIDENCE_BASES.includes(a), false, `${a} is not an evidence basis`);
    assert.equal(LIFECYCLE_STATES.includes(a), false, `${a} is not a lifecycle state`);
  }
  // The specific collapse that would matter most: "observed" must not imply
  // "unconfirmed", because a policy-activated observed card is active.
  assert.equal(EVIDENCE_BASES.includes("candidate"), false);
  assert.equal(APPROVAL_STATES.includes("observed"), false);
});

test("T05D-L8: the backlog states partition exactly into claimable / parked / terminal", () => {
  // This row earned its keep: the D0 lane added `deferred_oversize` and the live
  // suite went red here. Without the parked category the progress arithmetic would
  // have counted real parked items as unaccounted receipts — reporting a LOSS,
  // which is the loudest possible wrong answer.
  for (const s of BACKLOG_STATES) {
    const inSets = [
      PROGRESS_CLAIMABLE_STATES.includes(s),
      PROGRESS_PARKED_STATES.includes(s),
      PROGRESS_TERMINAL_STATES.includes(s),
    ].filter(Boolean).length;
    assert.equal(inSets, 1,
      `${s} must be in exactly one of claimable/parked/terminal, not ${inSets}`);
  }
  // …and nothing may be classified that the adapter does not declare.
  for (const s of [...PROGRESS_CLAIMABLE_STATES, ...PROGRESS_PARKED_STATES,
    ...PROGRESS_TERMINAL_STATES]) {
    assert.ok((BACKLOG_STATES as readonly string[]).includes(s),
      `${s} is classified but the adapter does not declare it`);
  }
  // The progress module's terminal list must agree with the adapter's own.
  assert.deepEqual([...PROGRESS_TERMINAL_STATES].sort(), [...TERMINAL_STATES].sort(),
    "a divergence here would make the progress arithmetic silently wrong");
});

test("T05D-L8b: a parked item is neither drained nor reported as lost", () => {
  const p = computeProgress(input({
    backfill: {
      byState: { deferred: 100, deferred_oversize: 7, declined: 20 },
      receipts: 127,
    },
  }));
  assert.equal(p.backfillParked, 7);
  assert.equal(p.backfillRemaining, 100, "parked items are not in the drainable remainder");
  assert.equal(p.backfillSettled, 20, "…and they are not decided either");
  assert.equal(p.backfillTotal, 127, "but they ARE in the denominator");
  assert.equal(p.arithmeticCloses, true, "and they must not read as a loss");
  const text = formatProgress(p);
  assert.match(text, /parked +7 source\(s\) too large/);
  assert.equal(/INTEGRITY/.test(text), false, "a parked item is not an integrity problem");

  // The ETA must be computed from the drainable remainder only, or parked items
  // would stretch the estimate forever.
  assert.equal(p.confidence, "measured");
  const hours = (Date.parse(p.estimatedCompletionIso!) - Date.parse(input().nowIso)) / 3_600_000;
  assert.ok(hours > 2.2 && hours < 2.6, `${hours}h should be 100/42 ≈ 2.4h, not 107/42`);
});

test("T05D-L9: declined and quarantined never become retrievable memory", () => {
  for (const s of NEVER_RETRIEVABLE_APPROVAL_STATES) {
    assert.equal(RETRIEVABLE_APPROVAL_STATES.includes(s), false, `${s} must not be retrievable`);
  }
  const base: MemoryItemView = {
    id: "m-1", title: "synthetic", body: "synthetic body", scope: "relationship",
    au_id: null, sensitivity: "normal", importance: 2, approval_state: "confirmed",
    lifecycle_state: "active", confirmed_by: "owner", retrieval: "enabled",
    source_basis: "explicit", tags_text: "", created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z", expires_at: null,
  } as MemoryItemView;
  const scene = { mode: "ordinary", auId: null, intimacyActive: false } as never;
  const now = "2026-02-01T00:00:00.000Z";

  assert.equal(isEligible(base, scene, now).ok, true, "a confirmed active card is eligible");
  for (const state of NEVER_RETRIEVABLE_APPROVAL_STATES) {
    const v = isEligible({ ...base, approval_state: state }, scene, now);
    assert.equal(v.ok, false, `${state} must be refused by the eligibility gate`);
  }
  // policy_activated IS retrievable — that is the whole point of D0 — and it must
  // NOT claim a confirmation.
  const activated = isEligible(
    { ...base, approval_state: "policy_activated", confirmed_by: null }, scene, now);
  assert.equal(activated.ok, true);
  assert.ok(trustRank({ ...base, approval_state: "confirmed" } as MemoryItemView)
    > trustRank({ ...base, approval_state: "policy_activated", source_basis: "explicit" } as MemoryItemView),
    "an individually confirmed card outranks a policy-activated one");
  assert.ok(trustRank({ ...base, approval_state: "policy_activated", source_basis: "explicit" } as MemoryItemView)
    > trustRank({ ...base, approval_state: "policy_activated", source_basis: "observed" } as MemoryItemView),
    "explicit outranks observed within policy activation");
});

test("T05D-L10: the eligibility gates fail closed on AU, sensitivity, expiry and lifecycle", () => {
  const base: MemoryItemView = {
    id: "m-1", title: "synthetic", body: "synthetic body", scope: "relationship",
    au_id: null, sensitivity: "normal", importance: 2, approval_state: "policy_activated",
    lifecycle_state: "active", confirmed_by: null, retrieval: "enabled",
    source_basis: "explicit", tags_text: "", created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z", expires_at: null,
  } as MemoryItemView;
  const ordinary = { mode: "ordinary", auId: null, intimacyActive: false } as never;
  const now = "2026-02-01T00:00:00.000Z";

  const cases: Array<[string, Partial<MemoryItemView>, RegExp]> = [
    ["expired", { expires_at: "2026-01-31T00:00:00.000Z" }, /expired/],
    ["superseded", { lifecycle_state: "superseded" }, /superseded/],
    ["revoked", { lifecycle_state: "revoked" }, /lifecycle revoked/],
    ["retrieval off", { retrieval: "disabled" }, /retrieval disabled/],
    ["intimate outside intimacy", { sensitivity: "intimate" }, /intimate|retrieval disabled/],
    ["AU card in an ordinary scene", { scope: "au", au_id: "au-x" }, /AU isolation/],
    ["session scoped", { scope: "session" }, /session-scoped/],
  ];
  for (const [label, over, reason] of cases) {
    const v = isEligible({ ...base, ...over } as MemoryItemView, ordinary, now);
    assert.equal(v.ok, false, `${label} must be refused`);
    assert.match(v.reason, reason, `${label}: ${v.reason}`);
  }
  // And the positive control, so the gate is not simply refusing everything.
  assert.equal(isEligible(base, ordinary, now).ok, true);
});

// ---------------------------------------------------------------------------
// The provider-call invariant
// ---------------------------------------------------------------------------

test("T05D-L10b: a re-dial after a non-committing attempt is not a duplicate call", () => {
  // This distinction is load-bearing and was found by auditing the LIVE ledger:
  // eleven identities had two or three settled calls, and every one followed a
  // `malformed_decision → failed_retryable` attempt that committed nothing. A rule
  // of "at most one call per identity" would have reported eleven correct
  // re-dials as defects, which is worse than no rule.
  const calls: CallRecord[] = [
    { identity: "a", reservedAt: "2026-08-02T11:55:21Z", settledAt: "2026-08-02T11:55:44Z", outcome: "ok" },
    { identity: "a", reservedAt: "2026-08-02T12:55:45Z", settledAt: "2026-08-02T12:55:57Z", outcome: "ok" },
  ];
  const transitions: TransitionRecord[] = [
    { identity: "a", at: "2026-08-02T11:48:24Z", fromState: null, toState: "deferred" },
    { identity: "a", at: "2026-08-02T11:55:21Z", fromState: "deferred", toState: "processing" },
    { identity: "a", at: "2026-08-02T11:55:44Z", fromState: "processing", toState: "failed_retryable" },
    { identity: "a", at: "2026-08-02T12:55:45Z", fromState: "failed_retryable", toState: "processing" },
    { identity: "a", at: "2026-08-02T12:55:57Z", fromState: "processing", toState: "declined" },
  ];
  const audit = auditProviderCalls(calls, transitions);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.verdict, "explained_redial");
  assert.match(audit[0]!.detail, /after 1 non-committing attempt/);
});

test("T05D-L10c: a call AFTER a committed card is a duplicate, and is named as one", () => {
  const transitions: TransitionRecord[] = [
    { identity: "b", at: "2026-08-02T10:00:00Z", fromState: null, toState: "deferred" },
    { identity: "b", at: "2026-08-02T10:05:00Z", fromState: "deferred", toState: "processing" },
    { identity: "b", at: "2026-08-02T10:06:00Z", fromState: "processing", toState: "policy_activated" },
  ];
  const clean = auditProviderCalls(
    [{ identity: "b", reservedAt: "2026-08-02T10:05:00Z", settledAt: "2026-08-02T10:06:00Z", outcome: "ok" }],
    transitions);
  assert.equal(clean[0]!.verdict, "single_call");

  const duplicated = auditProviderCalls([
    { identity: "b", reservedAt: "2026-08-02T10:05:00Z", settledAt: "2026-08-02T10:06:00Z", outcome: "ok" },
    // The one that must never happen: the card exists and we dialled again.
    { identity: "b", reservedAt: "2026-08-02T10:07:00Z", settledAt: "2026-08-02T10:08:00Z", outcome: "ok" },
  ], transitions);
  assert.equal(duplicated[0]!.verdict, "duplicate_after_commit");
  assert.match(duplicated[0]!.detail, /after the card was committed/);

  // More settled calls than non-committing attempts can account for.
  const runaway = auditProviderCalls([
    { identity: "c", reservedAt: "2026-08-02T10:00:00Z", settledAt: "2026-08-02T10:01:00Z", outcome: "ok" },
    { identity: "c", reservedAt: "2026-08-02T10:02:00Z", settledAt: "2026-08-02T10:03:00Z", outcome: "ok" },
    { identity: "c", reservedAt: "2026-08-02T10:04:00Z", settledAt: "2026-08-02T10:05:00Z", outcome: "ok" },
  ], [
    { identity: "c", at: "2026-08-02T09:00:00Z", fromState: null, toState: "deferred" },
    { identity: "c", at: "2026-08-02T10:01:00Z", fromState: "processing", toState: "failed_retryable" },
  ]);
  assert.equal(runaway[0]!.verdict, "unexplained_extra_calls");
  assert.match(runaway[0]!.detail, /only 1 non-committing attempt/);
});

// ---------------------------------------------------------------------------
// Reading a real (synthetic) queue end to end
// ---------------------------------------------------------------------------

test("T05D-L11: the status reader turns a real queue into progress, read-only", () => {
  const d = dir("t05d-status-");
  const path = join(d, "backlog.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE backlog_items (identity TEXT PRIMARY KEY, origin TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE backlog_receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL,
      at TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, detail TEXT);
  `);
  const item = db.prepare("INSERT INTO backlog_items VALUES (?,?,?)");
  const rec = db.prepare("INSERT INTO backlog_receipts (identity,at,from_state,to_state,detail) VALUES (?,?,?,?,?)");
  for (let i = 0; i < 10; i += 1) {
    const id = `b-${i}`;
    item.run(id, "backfill", i < 4 ? "declined" : "deferred");
    rec.run(id, "2026-08-02T12:00:00.000Z", null, "deferred", "enqueued");
    if (i < 4) {
      rec.run(id, `2026-08-02T1${2 + i}:30:00.000Z`, "processing", "declined", null);
    }
  }
  item.run("l-1", "live", "policy_activated");
  rec.run("l-1", "2026-08-02T15:00:00.000Z", null, "deferred", "enqueued:live");
  rec.run("l-1", "2026-08-02T15:01:00.000Z", "processing", "policy_activated", null);
  db.close();

  const got = readProgressInput(path, "2026-08-02T16:10:00.000Z", null);
  assert.equal(got.backfill.receipts, 10);
  assert.equal(got.live.receipts, 1);
  assert.equal(got.backfill.byState["deferred"], 6);
  assert.equal(got.backfill.byState["declined"], 4);
  assert.ok(got.hourlySettled.length >= 4, "terminal transitions are bucketed by hour");

  const p = computeProgress(got);
  assert.equal(p.arithmeticCloses, true);
  assert.equal(p.backfillRemaining, 6);
  assert.equal(p.backfillSettled, 4);
  assert.equal(p.liveSettled, 1);
  const text = formatProgress(p);
  assert.match(text, /historical recovery {2}4\/10/);
  assert.equal(/b-\d|l-1/.test(text), false, "no identity reaches the report");
});
