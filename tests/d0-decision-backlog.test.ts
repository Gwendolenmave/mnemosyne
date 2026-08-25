/**
 * D0 §7 adversarial fixtures 1–9 and 17–20: durable no-drop backlog,
 * crash-point resume, idempotency, budget deferral, provider failure
 * classes, fail-closed integrity, recovery-manifest arithmetic, and the
 * live-database refusal guard. SYNTHETIC content only.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import {
  backlogIdentity,
  DecisionBacklog,
} from "../adapters/automation/decision-backlog.js";
import {
  DecisionWorker,
  migrateLegacyQueue,
  raiseOnlySensitivity,
  type DecisionWorkerOptions,
} from "../adapters/automation/decision-worker.js";
import { emptyCompanionPassState, turnContentHash } from "../adapters/automation/companion-proposals.js";
import { GovernedCompanionProposalSink } from "../core/services/companion-proposal-sink.js";
import { MnemosyneGovernanceService } from "../core/services/mnemosyne-governance.js";
import type { TurnSnapshot } from "../adapters/transcripts/local/transcript-query.js";
import type { ModelResult } from "../core/ports/model-provider.js";
import {
  assertNotLiveDataPath,
  backlogTerminalChecker,
  buildRecoveryManifest,
  enqueueRecoverable,
  manifestArithmeticHolds,
  promotionAuthorityFlag,
} from "../scripts/d0-recovery.js";

const POLICY_ID = "synthetic-owner-policy-v1";
const TEST_POLICY = {
  policyId: POLICY_ID,
  authority: "owner_global_policy" as const,
  effectiveFrom: "2099-01-01T00:00:00+08:00",
  manualPerCardApprovalRequired: false,
  ownerCanViewEditRevoke: true,
  authorityRef: "sha256:" + "d".repeat(64),
};

function uuidLike(prefix: string, i: number): string {
  return `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;
}

function syntheticSnapshot(i: number): TurnSnapshot {
  return {
    conversationId: "bbbb2222-0000-4000-8000-000000000001",
    turnId: uuidLike("aaaa1111", i),
    userMessageId: uuidLike("cccc3333", i),
    userText: `synthetic user fact ${i}`,
    assistantText: `synthetic assistant response ${i}`,
    variantSha256: "v".repeat(64),
    selectedMemoryIds: [],
    ...{},
  };
}

interface Rig {
  worker: DecisionWorker;
  backlog: DecisionBacklog;
  service: MnemosyneGovernanceService;
  handle: ReturnType<typeof openMnemosyne>;
  snapshots: Map<string, TurnSnapshot>;
  results: ModelResult[];
  calls: number[];
  audit: Array<Record<string, unknown>>;
  rebuild: (overrides?: Partial<DecisionWorkerOptions>) => DecisionWorker;
}

async function buildRig(
  label: string,
  options?: {
    backlogPath?: string;
    budget?: Partial<import("../adapters/automation/decision-worker.js").DecisionWorkerBudget>;
    sinkWrap?: (
      sink: GovernedCompanionProposalSink,
    ) => Pick<GovernedCompanionProposalSink, "proposeActivated" | "proposePending" | "reviseOwnPending" | "activateOwnPending">;
  },
): Promise<Rig> {
  const dbPath = join(mkdtempSync(join(tmpdir(), `d0-${label}-`)), "delos-memory.db");
  const handle = openMnemosyne(dbPath);
  const audit: Array<Record<string, unknown>> = [];
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: (l) => ({ path: `${dbPath}.gov-backup-${l}` }),
    audit: (event) => audit.push(event),
  });
  const registered = await service.ensureOwnerPolicy(TEST_POLICY);
  assert.notEqual(registered.status, "refused");
  const backlog = new DecisionBacklog(options?.backlogPath ?? ":memory:");
  const snapshots = new Map<string, TurnSnapshot>();
  const results: ModelResult[] = [];
  const calls: number[] = [];
  const realSink = new GovernedCompanionProposalSink(service);
  const sink = options?.sinkWrap !== undefined ? options.sinkWrap(realSink) : realSink;
  const build = (overrides?: Partial<DecisionWorkerOptions>): DecisionWorker =>
    new DecisionWorker({
      backlog,
      sink: sink as GovernedCompanionProposalSink,
      provider: {
        generate: async () => {
          calls.push(1);
          return (
            results.shift() ?? {
              ok: true,
              text: '{"decision":"decline","note":"synthetic no"}',
              servedModel: "synthetic-model",
            }
          );
        },
      },
      persona: { staticPrefix: "SYNTHETIC-PERSONA-CORE", sha256: "p".repeat(64) },
      snapshotByTurn: (turnId) => snapshots.get(turnId) ?? null,
      frozenVerifier: {
        cardSha: (memoryId, anchorEventId) => handle.store.historicalCardSha(memoryId, anchorEventId),
        priorKnown: (key, version) => handle.store.priorVersionKnown(key, version),
      },
      cardSensitivity: (memoryId) => service.getCard(memoryId)?.sensitivity ?? null,
      cardActive: (memoryId) => service.getCard(memoryId)?.lifecycle_state === "active",
      existingCardForTurn: (turnId) => {
        const card = service.findBySourceTurn(turnId);
        return card === undefined ? undefined : { id: card.id };
      },
      policyId: POLICY_ID,
      policy: () => {
        const current = service.ownerPolicy(POLICY_ID);
        return current === null
          ? null
          : {
              policyId: current.policyId,
              manualPerCardApprovalRequired: current.manualPerCardApprovalRequired,
            };
      },
      mode: "full",
      audit: (event) => audit.push(event),
      ...(options?.budget !== undefined ? { budget: options.budget } : {}),
      ...(overrides ?? {}),
    });
  const worker = build();
  return { worker, backlog, service, handle, snapshots, results, calls, audit, rebuild: build };
}

function enqueue(rig: Rig, snap: TurnSnapshot): { identity: string; enqueued: boolean } {
  rig.snapshots.set(snap.turnId, snap);
  const result = rig.worker.enqueueTurn(snap, "live", {
    selectedRefs: [],
    priorVersions: {},
    sourceTime: null,
  });
  assert.ok(result !== null);
  return result;
}

const EXPLICIT_CARD = (body: string): string =>
  JSON.stringify({
    decision: "propose",
    card: {
      body,
      title: "synthetic card",
      scope: "relationship",
      sensitivity: "normal",
      basis: "explicit",
      // correction B: every body assertion carries verifiable evidence;
      // this excerpt is a substring of every syntheticSnapshot user text.
      claims: [
        {
          claim_text: body,
          basis: "explicit",
          evidence_side: "user",
      evidence_excerpt: "synthetic user fact ",
        },
      ],
    },
  });

// ---- §7.1: five pending + a sixth completed turn --------------------------

test("D0 §7.1: five pending proposals plus a sixth turn — durably deferred, never shifted away", async () => {
  const rig = await buildRig("five-plus-one", { budget: { maxPerHour: 0 } });
  // Five active pending Companion candidates (the presentation tray is full).
  for (let i = 0; i < 5; i += 1) {
    const proposed = await rig.service.propose({
      body: `synthetic 待归档第${i}张`,
      scope: "relationship",
      sensitivity: "normal",
      importance: 2,
      evidence: { kind: "manual" },
      proposedBy: "companion",
      executionActor: "system",
      provenance: { authored_by: "companion", proposed_by: "companion" },
    });
    assert.equal(proposed.status, "ok");
  }
  assert.equal(rig.service.listPending().length, 5);
  // The sixth completed turn: durable receipt exists BEFORE any drain.
  const sixth = enqueue(rig, syntheticSnapshot(6));
  assert.equal(sixth.enqueued, true);
  const row = rig.backlog.get(sixth.identity)!;
  assert.equal(row.state, "deferred");
  // Zero-budget ticks (stand-in for any capacity limit) never consume it.
  await rig.worker.tick();
  await rig.worker.tick();
  assert.equal(rig.backlog.get(sixth.identity)?.state, "deferred");
  assert.equal(rig.calls.length, 0);
  // The receipt survives with pointers and hashes intact.
  assert.equal(row.content_sha256, turnContentHash("synthetic user fact 6", "synthetic assistant response 6"));
  rig.handle.log.close();
});

// ---- §7.2: one thousand turns under a permanently full tray ---------------

test("D0 §7.2: 1000 turns reconcile to durable states with zero missing identities", async () => {
  const rig = await buildRig("thousand", { budget: { maxPerHour: 2000, maxPerDay: 2000 } });
  const identities: string[] = [];
  for (let i = 0; i < 1000; i += 1) {
    identities.push(enqueue(rig, syntheticSnapshot(i)).identity);
  }
  assert.equal(rig.backlog.counters().source_receipts_total, 1000);
  // Drain fully (default provider result: decline).
  for (let i = 0; i < 1000; i += 1) {
    await rig.worker.tick();
  }
  const counters = rig.backlog.counters();
  assert.equal(counters.deferred_total, 0);
  assert.equal(counters.processing_total, 0);
  assert.equal(counters.declined_total, 1000);
  // Arithmetic: every identity reached exactly one durable terminal state.
  for (const identity of identities) {
    assert.equal(rig.backlog.get(identity)?.state, "declined");
  }
  const total =
    counters.declined_total +
    counters.duplicate_total +
    counters.policy_activated_total +
    counters.quarantined_total +
    counters.retryable_failed_total +
    counters.terminal_failed_total +
    counters.deferred_total +
    counters.oversize_deferred_total +
    counters.processing_total;
  assert.equal(total, counters.source_receipts_total);
  rig.handle.log.close();
});

// ---- §7.3/7.4/7.5: crash points -------------------------------------------

test("D0 §7.3: crash after enqueue, before provider call — resume decides exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "d0-crash-a-"));
  const backlogPath = join(dir, "backlog.db");
  const rig = await buildRig("crash-a", { backlogPath });
  const item = enqueue(rig, syntheticSnapshot(1));
  // "Crash": drop everything, reopen the same durable file.
  rig.backlog.close();
  const reopened = new DecisionBacklog(backlogPath);
  assert.equal(reopened.get(item.identity)?.state, "deferred", "the receipt survived the crash");
  const rig2 = await buildRig("crash-a2", { backlogPath: ":memory:" });
  // Reuse reopened backlog with a fresh worker on the same snapshots.
  rig2.snapshots.set(syntheticSnapshot(1).turnId, syntheticSnapshot(1));
  const worker2 = rig2.rebuild({ backlog: reopened });
  reopened.recoverProcessing();
  await worker2.tick();
  assert.equal(reopened.get(item.identity)?.state, "declined");
  assert.equal(rig2.calls.length, 1, "exactly one provider decision");
  reopened.close();
  rig.handle.log.close();
  rig2.handle.log.close();
});

test("D0 §7.4: crash after provider decision, before card commit — no duplicate card on resume", async () => {
  let explode = true;
  const rig = await buildRig("crash-b", {
    sinkWrap: (real) => ({
      proposePending: (input) => real.proposePending(input),
      reviseOwnPending: (id, body) => real.reviseOwnPending(id, body),
      activateOwnPending: (id, a, e) => real.activateOwnPending(id, a, e),
      proposeActivated: (input) => {
        if (explode) {
          explode = false;
          throw new Error("synthetic crash between decision and card commit");
        }
        return real.proposeActivated(input);
      },
    }),
  });
  const item = enqueue(rig, syntheticSnapshot(2));
  rig.results.push(
    { ok: true, text: EXPLICIT_CARD("synthetic 第一次决定的卡"), servedModel: "synthetic-model" },
    { ok: true, text: EXPLICIT_CARD("synthetic 第二次决定的卡"), servedModel: "synthetic-model" },
  );
  await rig.worker.tick(); // crashes inside the sink → failed_retryable
  assert.equal(rig.backlog.get(item.identity)?.state, "failed_retryable");
  assert.equal(rig.service.listPending().length, 0, "no card was committed");
  // Resume: the retry is claimable immediately in this fixture.
  const row = rig.backlog.get(item.identity)!;
  assert.ok(row.next_attempt_at !== null);
  // Force the retry due now by rebuilding a worker with a late clock.
  const late = new Date(Date.parse(row.next_attempt_at!) + 1000);
  const worker2 = rig.rebuild({ now: () => late });
  await worker2.tick();
  assert.equal(rig.backlog.get(item.identity)?.state, "policy_activated");
  const cards = rig.service.searchConfirmed("第二次决定", 10);
  assert.equal(cards.length, 1, "exactly one card exists after resume");
  rig.handle.log.close();
});

test("D0 §7.5: crash after card commit, before completion receipt — resume closes as duplicate without re-dialing", async () => {
  let crashAfterCommit = true;
  const rig = await buildRig("crash-c", {
    sinkWrap: (real) => ({
      proposePending: (input) => real.proposePending(input),
      reviseOwnPending: (id, body) => real.reviseOwnPending(id, body),
      activateOwnPending: (id, a, e) => real.activateOwnPending(id, a, e),
      proposeActivated: async (input) => {
        const outcome = await real.proposeActivated(input);
        if (crashAfterCommit) {
          crashAfterCommit = false;
          throw new Error("synthetic crash after card commit, before receipt");
        }
        return outcome;
      },
    }),
  });
  const item = enqueue(rig, syntheticSnapshot(3));
  rig.results.push({
    ok: true,
    text: EXPLICIT_CARD("synthetic 已提交但没拿到回执的卡"),
    servedModel: "synthetic-model",
  });
  await rig.worker.tick(); // card committed, then "crash"
  assert.equal(rig.backlog.get(item.identity)?.state, "failed_retryable");
  assert.equal(rig.service.searchConfirmed("已提交但没拿到回执", 10).length, 1, "the card IS committed");
  const callsBefore = rig.calls.length;
  const row = rig.backlog.get(item.identity)!;
  const late = new Date(Date.parse(row.next_attempt_at!) + 1000);
  const worker2 = rig.rebuild({ now: () => late });
  await worker2.tick();
  const final = rig.backlog.get(item.identity)!;
  assert.equal(final.state, "duplicate", "resume reconciles to the committed card");
  assert.ok(final.memory_id !== null);
  assert.equal(rig.calls.length, callsBefore, "zero repeated provider calls for the committed decision");
  assert.equal(rig.service.searchConfirmed("已提交但没拿到回执", 10).length, 1, "still exactly one card");
  rig.handle.log.close();
});

// ---- §7.6: idempotency ----------------------------------------------------

test("D0 §7.6: repeated enqueue and repeated replay are idempotent", async () => {
  const rig = await buildRig("idem");
  const snap = syntheticSnapshot(4);
  const a = enqueue(rig, snap);
  const b = enqueue(rig, snap);
  const c = enqueue(rig, snap);
  assert.deepEqual([a.enqueued, b.enqueued, c.enqueued], [true, false, false]);
  assert.equal(rig.backlog.counters().source_receipts_total, 1);
  await rig.worker.tick(); // declines
  const after = rig.backlog.counters();
  await rig.worker.tick();
  await rig.worker.tick();
  assert.deepEqual(rig.backlog.counters(), after, "terminal decisions never reprocess");
  assert.equal(rig.calls.length, 1);
  rig.handle.log.close();
});

// ---- §7.7: exhaustion defers ---------------------------------------------

test("D0 §7.7: hourly and daily exhaustion defer rather than drop", async () => {
  const rig = await buildRig("budget", { budget: { maxPerHour: 1, maxPerDay: 1 } });
  const one = enqueue(rig, syntheticSnapshot(5));
  const two = enqueue(rig, syntheticSnapshot(6));
  await rig.worker.tick();
  await rig.worker.tick();
  await rig.worker.tick();
  assert.equal(rig.calls.length, 1, "only the budgeted call was made");
  assert.equal(rig.backlog.get(one.identity)?.state, "declined");
  assert.equal(rig.backlog.get(two.identity)?.state, "deferred", "deferred, not dropped");
  rig.handle.log.close();
});

// ---- §7.8: provider failure classes --------------------------------------

test("D0 §7.8: transient provider failures retry with backoff; exhaustion is typed terminal", async () => {
  const rig = await buildRig("provider-fail", {
    budget: { maxPerHour: 100, maxPerDay: 100, maxAttempts: 2, breakerAfterFailures: 99 },
  });
  const item = enqueue(rig, syntheticSnapshot(7));
  rig.results.push({ ok: false, errorKind: "timeout", detail: "synthetic timeout" });
  await rig.worker.tick();
  const afterFirst = rig.backlog.get(item.identity)!;
  assert.equal(afterFirst.state, "failed_retryable");
  assert.ok(afterFirst.next_attempt_at !== null, "backoff recorded");
  // Second attempt (due later) fails again → attempts exhausted → terminal.
  rig.results.push({ ok: false, errorKind: "timeout", detail: "synthetic timeout" });
  const late = new Date(Date.parse(afterFirst.next_attempt_at!) + 1000);
  const worker2 = rig.rebuild({ now: () => late });
  await worker2.tick();
  const final = rig.backlog.get(item.identity)!;
  assert.equal(final.state, "failed_terminal");
  assert.ok(final.detail!.startsWith("exhausted_retries:"), "typed terminal reason");
  rig.handle.log.close();
});

test("D0 §7.8b: three consecutive provider failures open the worker breaker", async () => {
  const rig = await buildRig("breaker", {
    budget: { maxPerHour: 100, maxPerDay: 100, maxAttempts: 99, breakerAfterFailures: 3 },
  });
  for (let i = 0; i < 3; i += 1) {
    const item = enqueue(rig, syntheticSnapshot(20 + i));
    rig.results.push({ ok: false, errorKind: "timeout", detail: "synthetic" });
    // Make retryable items non-claimable so each tick claims a fresh item.
    await rig.worker.tick();
    assert.equal(rig.backlog.get(item.identity)?.state, "failed_retryable");
  }
  assert.ok(rig.backlog.getMeta("worker_breaker_until") !== null);
  const fresh = enqueue(rig, syntheticSnapshot(30));
  const before = rig.calls.length;
  await rig.worker.tick();
  assert.equal(rig.calls.length, before, "breaker open: no call starts");
  assert.equal(rig.backlog.get(fresh.identity)?.state, "deferred");
  rig.handle.log.close();
});

// ---- §7.9: fail-closed integrity ------------------------------------------

test("D0 §7.9: missing transcript turn and content-hash mismatch fail closed (typed)", async () => {
  const rig = await buildRig("integrity");
  // Missing source: enqueue with a snapshot, then remove it.
  const missing = enqueue(rig, syntheticSnapshot(8));
  rig.snapshots.delete(syntheticSnapshot(8).turnId);
  await rig.worker.tick();
  const missingRow = rig.backlog.get(missing.identity)!;
  assert.equal(missingRow.state, "failed_terminal");
  assert.equal(missingRow.detail, "missing_source");
  // Hash mismatch: the archive text changed after enqueue.
  const snap = syntheticSnapshot(9);
  const mismatched = enqueue(rig, snap);
  rig.snapshots.set(snap.turnId, { ...snap, userText: "synthetic 被改动过的话" });
  await rig.worker.tick();
  const mismatchRow = rig.backlog.get(mismatched.identity)!;
  assert.equal(mismatchRow.state, "failed_terminal");
  assert.equal(mismatchRow.detail, "hash_mismatch");
  assert.equal(rig.calls.length, 0, "no provider call ever happens on integrity failure");
  rig.handle.log.close();
});

// ---- §7.17-equivalent: legacy queue migration ------------------------------

test("D0: legacy JSON-queue entries migrate durably and the queue retires empty", () => {
  const state = { value: emptyCompanionPassState() };
  state.value.queue.push({
    queued_at: "2026-07-13T01:00:00.000Z",
    kind: "self",
    conversation_id: "bbbb2222-0000-4000-8000-000000000001",
    turn_id: uuidLike("aaaa1111", 77),
    user_message_id: uuidLike("cccc3333", 77),
    content_sha256: "c".repeat(64),
    variant_sha256: "v".repeat(64),
    selected_memories: [],
    prior_versions: {},
    scene: { mode: "ordinary" },
  });
  const backlog = new DecisionBacklog(":memory:");
  const audits: Array<Record<string, unknown>> = [];
  const migrated = migrateLegacyQueue(
    {
      loadCompanionPass: () => structuredClone(state.value),
      saveCompanionPass: (next) => {
        state.value = structuredClone(next);
      },
    },
    backlog,
    POLICY_ID,
    (event) => audits.push(event),
  );
  assert.equal(migrated, 1);
  assert.equal(state.value.queue.length, 0, "JSON queue retired empty");
  assert.equal(backlog.counters().source_receipts_total, 1);
  const identity = backlogIdentity(
    "bbbb2222-0000-4000-8000-000000000001",
    uuidLike("aaaa1111", 77),
    "c".repeat(64),
    POLICY_ID,
  );
  assert.equal(backlog.get(identity)?.state, "deferred");
  // Idempotent: running again migrates nothing and duplicates nothing.
  assert.equal(
    migrateLegacyQueue(
      {
        loadCompanionPass: () => structuredClone(state.value),
        saveCompanionPass: (next) => {
          state.value = structuredClone(next);
        },
      },
      backlog,
      POLICY_ID,
      () => undefined,
    ),
    0,
  );
  assert.equal(backlog.counters().source_receipts_total, 1);
  backlog.close();
});

// ---- §7.18/19: recovery manifest arithmetic + resume economy ---------------

function auditLine(turnId: string, hash16: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "companion_proposal_pass",
    outcome: "skipped_budget",
    lane: "autonomous",
    kind: "self",
    turn_id: turnId,
    content_sha256: hash16,
    variant_sha256: "v".repeat(12),
    detail: "tray_full",
  });
}

test("D0 §7.18: backfill manifest arithmetic is exact and independently recomputable", async () => {
  const rig = await buildRig("manifest");
  const good = syntheticSnapshot(40);
  const dupTurn = syntheticSnapshot(41);
  const resolved = syntheticSnapshot(42);
  const mismatch = syntheticSnapshot(43);
  for (const snap of [good, dupTurn, resolved, mismatch]) {
    rig.snapshots.set(snap.turnId, snap);
  }
  // An existing card resolves `resolved`'s turn.
  const proposed = await rig.service.propose({
    body: "synthetic 已有决定的卡",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: {
      kind: "transcript",
      conversationId: resolved.conversationId,
      turnId: resolved.turnId,
      messageId: resolved.userMessageId!,
    },
    proposedBy: "companion",
    executionActor: "system",
    provenance: { authored_by: "companion" },
  });
  assert.equal(proposed.status, "ok");
  const hashOf = (s: TurnSnapshot): string =>
    turnContentHash(s.userText, s.assistantText).slice(0, 16);
  const audit = [
    auditLine(good.turnId, hashOf(good), "2026-07-13T01:21:12.214Z"),
    auditLine(dupTurn.turnId, hashOf(dupTurn), "2026-07-13T02:00:00.000Z"),
    auditLine(dupTurn.turnId, hashOf(dupTurn), "2026-07-13T02:05:00.000Z"), // duplicate receipt
    auditLine(resolved.turnId, hashOf(resolved), "2026-07-14T00:00:00.000Z"), // already resolved
    auditLine("ffff9999-0000-4000-8000-000000000404", "a".repeat(16), "2026-07-15T00:00:00.000Z"), // missing source
    auditLine(mismatch.turnId, "b".repeat(16), "2026-07-16T00:00:00.000Z"), // hash mismatch
    JSON.stringify({ timestamp: "2026-07-16T01:00:00.000Z", type: "companion_proposal_pass", outcome: "skipped_budget", detail: "tray_full" }), // invalid record
    auditLine(syntheticSnapshot(50).turnId, "c".repeat(16), "2026-09-01T00:00:00.000Z"), // post-watermark: excluded
    JSON.stringify({ timestamp: "2026-07-13T03:00:00.000Z", type: "companion_proposal_pass", outcome: "skipped_budget", detail: "hourly_budget", turn_id: "x", content_sha256: "d".repeat(16) }), // not tray_full
  ].join("\n");
  const manifest = buildRecoveryManifest({
    auditJsonl: audit,
    auditPathLabel: "synthetic",
    watermarkIso: "2026-08-02T00:00:00.000Z",
    policyId: POLICY_ID,
    snapshotByTurn: (turnId) => rig.snapshots.get(turnId) ?? null,
    existingCardForTurn: (turnId) => {
      const card = rig.service.findBySourceTurn(turnId);
      return card === undefined ? undefined : { id: card.id };
    },
    backlogTerminalFor: backlogTerminalChecker(rig.backlog),
  });
  assert.equal(manifest.audit_receipts_total, 7);
  assert.equal(manifest.recoverable, 2); // good + dupTurn(first receipt)
  assert.equal(manifest.already_resolved, 1);
  assert.equal(manifest.duplicate_receipt, 1);
  assert.equal(manifest.missing_source, 1);
  assert.equal(manifest.hash_mismatch, 1);
  assert.equal(manifest.invalid_record, 1);
  assert.equal(manifestArithmeticHolds(manifest), true);
  // Independently recomputable: a second build gives identical results.
  const manifest2 = buildRecoveryManifest({
    auditJsonl: audit,
    auditPathLabel: "synthetic",
    watermarkIso: "2026-08-02T00:00:00.000Z",
    policyId: POLICY_ID,
    snapshotByTurn: (turnId) => rig.snapshots.get(turnId) ?? null,
    existingCardForTurn: (turnId) => {
      const card = rig.service.findBySourceTurn(turnId);
      return card === undefined ? undefined : { id: card.id };
    },
    backlogTerminalFor: backlogTerminalChecker(rig.backlog),
  });
  assert.deepEqual(manifest2, manifest);
  rig.handle.log.close();
});

test("D0 §7.19: backfill resume performs zero repeated provider calls for completed identities", async () => {
  const rig = await buildRig("resume-economy", { budget: { maxPerHour: 100, maxPerDay: 100 } });
  const snaps = [syntheticSnapshot(60), syntheticSnapshot(61)];
  for (const snap of snaps) {
    rig.snapshots.set(snap.turnId, snap);
  }
  const hashOf = (s: TurnSnapshot): string =>
    turnContentHash(s.userText, s.assistantText).slice(0, 16);
  const audit = snaps
    .map((s, i) => auditLine(s.turnId, hashOf(s), `2026-07-13T0${i}:00:00.000Z`))
    .join("\n");
  const build = () =>
    buildRecoveryManifest({
      auditJsonl: audit,
      auditPathLabel: "synthetic",
      watermarkIso: "2026-08-02T00:00:00.000Z",
      policyId: POLICY_ID,
      snapshotByTurn: (turnId) => rig.snapshots.get(turnId) ?? null,
      existingCardForTurn: (turnId) => {
        const card = rig.service.findBySourceTurn(turnId);
        return card === undefined ? undefined : { id: card.id };
      },
      backlogTerminalFor: backlogTerminalChecker(rig.backlog),
    });
  const first = build();
  assert.equal(first.recoverable, 2);
  const enq1 = enqueueRecoverable(first, rig.backlog, POLICY_ID);
  assert.deepEqual(enq1, { enqueued: 2, alreadyPresent: 0 });
  await rig.worker.tick(); // decline #1
  assert.equal(rig.calls.length, 1);
  // "Restart": rebuild the manifest and re-enqueue — the completed
  // identity is already_resolved... (terminal in backlog), the pending
  // one is alreadyPresent; draining again spends exactly ONE more call.
  const second = build();
  assert.equal(second.recoverable, 1);
  assert.equal(second.already_resolved, 1);
  const enq2 = enqueueRecoverable(second, rig.backlog, POLICY_ID);
  assert.deepEqual(enq2, { enqueued: 0, alreadyPresent: 1 });
  await rig.worker.tick();
  await rig.worker.tick();
  assert.equal(rig.calls.length, 2, "completed identities never re-dial");
  rig.handle.log.close();
});

// ---- §7.20: live-database refusal -----------------------------------------

test("D0 §7.20: harness commands refuse the production data path without explicit promotion authority", () => {
  const protectedRoot = "/srv/mnemosyne-production/data";
  const requiredAuthority = promotionAuthorityFlag("a".repeat(64));
  const guarded = { protectedRoots: [protectedRoot], requiredAuthority };
  assert.throws(
    () => assertNotLiveDataPath(`${protectedRoot}/memory/mnemosyne.db`, guarded),
    /refusing the production data path/,
  );
  assert.throws(
    () =>
      assertNotLiveDataPath(
        `${protectedRoot}/audit/events.jsonl`,
        { ...guarded, presentedAuthority: "promotion-authorized-by:sha256:wrong" },
      ),
    /refusing the production data path/,
  );
  // Staging and scratch paths pass freely.
  assertNotLiveDataPath("/tmp/d0-x/mnemosyne.db", guarded);
  assertNotLiveDataPath("/srv/mnemosyne-staging/data/mnemosyne.db", guarded);
  assertNotLiveDataPath(":memory:", guarded);
  // The exact authority flag unlocks the live path.
  assertNotLiveDataPath(
    `${protectedRoot}/memory/mnemosyne.db`,
    { ...guarded, presentedAuthority: requiredAuthority },
  );
});

// ---- sensitivity guard ----------------------------------------------------

test("D0: the deterministic sensitivity guard raises and never lowers", () => {
  const intimateRef = [{ id: "m1", anchor_event_id: "e1", content_sha256: "x" }];
  assert.equal(raiseOnlySensitivity("normal", intimateRef, () => "intimate"), "sensitive");
  assert.equal(raiseOnlySensitivity("intimate", intimateRef, () => "intimate"), "intimate");
  assert.equal(raiseOnlySensitivity("intimate", [], () => null), "intimate", "never lowered");
  assert.equal(raiseOnlySensitivity("normal", [], () => null), "normal");
  assert.equal(raiseOnlySensitivity("sensitive", intimateRef, () => "normal"), "sensitive");
});
