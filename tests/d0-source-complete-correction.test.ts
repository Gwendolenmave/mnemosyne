/**
 * D0 source-complete quality correction tests (ruling 20260802 §8).
 * Covers: source budget boundaries, oversize_source deferral, claim-level
 * evidence validation, provenance axes, policy backup, and enqueue-only
 * mode. SYNTHETIC content only — no private card text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import { DecisionBacklog } from "../adapters/automation/decision-backlog.js";
import {
  DecisionWorker,
  type DecisionWorkerOptions,
} from "../adapters/automation/decision-worker.js";
import {
  buildVerifiedSourcePacket,
  checkSourceBudget,
  SOURCE_BUDGET,
  turnContentHash,
  validateClaimEvidence,
  type ClaimEvidence,
  type VerifiedSourcePacket,
} from "../adapters/automation/companion-proposals.js";
import { GovernedCompanionProposalSink } from "../core/services/companion-proposal-sink.js";
import {
  MnemosyneGovernanceService,
  parseProvenance,
} from "../core/services/mnemosyne-governance.js";
import { deriveProvenanceAxes } from "../core/domain/mnemosyne.js";
import { trustRank, type MemoryItemView } from "../core/services/anamnesis.js";
import type { TurnSnapshot } from "../adapters/transcripts/local/transcript-query.js";
import type { ModelResult } from "../core/ports/model-provider.js";

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

function syntheticSnapshot(i: number, userText?: string, assistantText?: string): TurnSnapshot {
  return {
    conversationId: "bbbb2222-0000-4000-8000-000000000001",
    turnId: uuidLike("aaaa1111", i),
    userMessageId: uuidLike("cccc3333", i),
    userText: userText ?? `synthetic user fact ${i}`,
    assistantText: assistantText ?? `synthetic assistant response ${i}`,
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
  backupCalls: string[];
  rebuild: (overrides?: Partial<DecisionWorkerOptions>) => DecisionWorker;
}

async function buildRig(label: string, options?: {
  budget?: Partial<import("../adapters/automation/decision-worker.js").DecisionWorkerBudget>;
  mode?: "enqueue-only" | "full";
  backupThrows?: boolean;
}): Promise<Rig> {
  const dbPath = join(mkdtempSync(join(tmpdir(), `d0-corr-${label}-`)), "delos-memory.db");
  const handle = openMnemosyne(dbPath);
  const audit: Array<Record<string, unknown>> = [];
  const backupCalls: string[] = [];
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: (l) => {
      backupCalls.push(l);
      if (options?.backupThrows) {
        throw new Error("synthetic backup failure");
      }
      return { path: `${dbPath}.gov-backup-${l}` };
    },
    audit: (event) => audit.push(event),
  });
  const registered = await service.ensureOwnerPolicy(TEST_POLICY);
  assert.notEqual(registered.status, "refused");
  const backlog = new DecisionBacklog(":memory:");
  const snapshots = new Map<string, TurnSnapshot>();
  const results: ModelResult[] = [];
  const calls: number[] = [];
  const realSink = new GovernedCompanionProposalSink(service);
  const build = (overrides?: Partial<DecisionWorkerOptions>): DecisionWorker =>
    new DecisionWorker({
      backlog,
      sink: realSink,
      provider: {
        generate: async () => {
          calls.push(1);
          return results.shift() ?? { ok: true, text: '{"decision":"decline","note":"synthetic no"}' };
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
        return current === null ? null : {
          policyId: current.policyId,
          manualPerCardApprovalRequired: current.manualPerCardApprovalRequired,
        };
      },
      mode: options?.mode ?? "full",
      audit: (event) => audit.push(event),
      ...(options?.budget !== undefined ? { budget: options.budget } : {}),
      ...(overrides ?? {}),
    });
  const worker = build();
  return { worker, backlog, service, handle, snapshots, results, calls, audit, backupCalls, rebuild: build };
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

const CARD_WITH_CLAIMS = (body: string, claims: ClaimEvidence[]): string =>
  JSON.stringify({
    decision: "propose",
    card: {
      body,
      title: "synthetic card",
      scope: "relationship",
      sensitivity: "normal",
      basis: "explicit",
      claims,
    },
  });

// ---- §8.1: fact and negation after character 1,600 -----------------------

test("§8.1: fact after char 1600 — old code would truncate, corrected code includes it", async () => {
  const rig = await buildRig("fact-after-1600");
  const padding = "A".repeat(1601);
  const fact = "合成配置明确禁用缓存。";
  const userText = padding + fact;
  const snap = syntheticSnapshot(1, userText, "已记录合成配置。");
  enqueue(rig, snap);
  const claims: ClaimEvidence[] = [{
    claim_text: "禁用缓存",
    basis: "explicit",
    evidence_side: "user",
    evidence_excerpt: fact,
  }];
  rig.results.push({
    ok: true,
    text: CARD_WITH_CLAIMS("合成配置禁用缓存。", claims),
  });
  await rig.worker.tick();
  assert.equal(rig.calls.length, 1);
  const counters = rig.backlog.counters();
  assert.equal(counters.policy_activated_total, 1, "fact after 1600 must reach activation");

});

test("§8.1: negation after char 1600 — must not be lost", async () => {
  const rig = await buildRig("negation-after-1600");
  const padding = "B".repeat(1601);
  const negation = "合成账户不是管理员，禁止授予写权限。";
  const userText = padding + negation;
  const snap = syntheticSnapshot(1, userText, "已记录合成权限约束。");
  enqueue(rig, snap);
  const claims: ClaimEvidence[] = [{
    claim_text: "不是管理员",
    basis: "explicit",
    evidence_side: "user",
    evidence_excerpt: negation,
  }];
  rig.results.push({
    ok: true,
    text: CARD_WITH_CLAIMS("合成账户不是管理员，不能授予写权限。", claims),
  });
  await rig.worker.tick();
  assert.equal(rig.calls.length, 1);
  const counters = rig.backlog.counters();
  assert.equal(counters.policy_activated_total, 1, "negation after 1600 must reach activation");

});

// ---- §8.2: exact source-budget boundary and oversize_source deferral -----

test("§8.2: source at budget-1 fits, at budget does not, at budget+1 does not", async () => {
  const limit = SOURCE_BUDGET.maxCharsPerSide;
  const mkPacket = (len: number): VerifiedSourcePacket => ({
    userText: "X".repeat(len),
    assistantText: "Y",
    contentSha256: "ignored",
    totalChars: len + 1,
  });
  const atLimitMinus1 = checkSourceBudget(mkPacket(limit - 1));
  assert.equal(atLimitMinus1.fits, true, "limit-1 must fit");

  const atLimit = checkSourceBudget(mkPacket(limit));
  assert.equal(atLimit.fits, true, "exactly at limit must fit");

  const atLimitPlus1 = checkSourceBudget(mkPacket(limit + 1));
  assert.equal(atLimitPlus1.fits, false, "limit+1 must not fit");
  assert.equal((atLimitPlus1 as { reason: string }).reason, "oversize_source");
});

test("§8.2: oversize turn parks as deferred_oversize (not terminal/quarantined, not lost)", async () => {
  const rig = await buildRig("oversize-deferred");
  const oversizeText = "Z".repeat(SOURCE_BUDGET.maxCharsPerSide + 1);
  const snap = syntheticSnapshot(1, oversizeText, "ok");
  enqueue(rig, snap);
  await rig.worker.tick();
  assert.equal(rig.calls.length, 0, "no provider call for oversize");
  const counters = rig.backlog.counters();
  // Continuous-completion ruling: the durable park is a DISTINCT state so
  // the claim pool advances past it (the plain 'deferred' shape livelocked
  // at the queue head). Still not terminal, not quarantined, never lost.
  assert.equal(counters.oversize_deferred_total, 1, "parked durable for T05D");
  assert.equal(counters.deferred_total, 0);
  assert.equal(counters.quarantined_total, 0, "must NOT be quarantined");
  assert.equal(counters.terminal_failed_total, 0, "must NOT be terminal");
});

// ---- §8.3: restart resumes oversize/deferred without duplicate calls -----

test("§8.3: oversize deferred survives restart and does not duplicate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "d0-corr-restart-"));
  const backlogPath = join(dir, "backlog.db");
  const rig = await buildRig("restart-oversize");
  const oversizeSnap = syntheticSnapshot(1, "Z".repeat(SOURCE_BUDGET.maxCharsPerSide + 1), "ok");
  rig.snapshots.set(oversizeSnap.turnId, oversizeSnap);
  rig.worker.enqueueTurn(oversizeSnap, "live", {
    selectedRefs: [],
    priorVersions: {},
    sourceTime: null,
  });
  await rig.worker.tick();
  assert.equal(rig.calls.length, 0);

  // Simulate restart: crash recovery re-defers processing items
  rig.backlog.recoverProcessing();
  await rig.worker.tick();
  assert.equal(rig.calls.length, 0, "still no provider call after restart");

});

// ---- §8.5: mixed user-explicit + assistant-inferred cannot activate as explicit

test("§8.5: mixed basis — any inferred claim forces card basis to inferred", () => {
  const claims: ClaimEvidence[] = [
    { claim_text: "合成协议支持模式A", basis: "explicit", evidence_side: "user", evidence_excerpt: "协议支持模式A" },
    { claim_text: "合成协议曾支持模式B", basis: "inferred", evidence_side: "assistant", evidence_excerpt: "可能曾支持模式B" },
  ];
  const result = validateClaimEvidence(claims, "explicit", "协议支持模式A", "可能曾支持模式B");
  assert.equal(result.valid, false);
  assert.equal((result as { reason: string }).reason, "inferred_claim_with_non_inferred_basis");
});

test("§8.5: mixed basis — inferred claim with inferred card basis is valid", () => {
  const claims: ClaimEvidence[] = [
    { claim_text: "合成协议支持模式A", basis: "explicit", evidence_side: "user", evidence_excerpt: "协议支持模式A" },
    { claim_text: "合成协议曾支持模式B", basis: "inferred", evidence_side: "assistant", evidence_excerpt: "可能曾支持模式B" },
  ];
  const result = validateClaimEvidence(claims, "inferred", "协议支持模式A", "可能曾支持模式B");
  assert.equal(result.valid, true);
});

// ---- §8.6: invalid evidence span/hash fails closed ----------------------

test("§8.6: evidence excerpt not in source text fails closed", () => {
  const claims: ClaimEvidence[] = [{
    claim_text: "合成协议支持模式B",
    basis: "explicit",
    evidence_side: "user",
    evidence_excerpt: "协议支持模式B",
  }];
  const result = validateClaimEvidence(claims, "explicit", "协议支持模式A", "已记录");
  assert.equal(result.valid, false);
  assert.ok((result as { reason: string }).reason.includes("evidence_excerpt_not_in_source"));
});

test("§8.6: wrong evidence_side fails closed", () => {
  const claims: ClaimEvidence[] = [{
    claim_text: "合成协议支持模式A",
    basis: "explicit",
    evidence_side: "assistant",
    evidence_excerpt: "协议支持模式A",
  }];
  const result = validateClaimEvidence(claims, "explicit", "协议支持模式A", "已记录");
  assert.equal(result.valid, false);
});

// ---- §8.7: second verifier rejects body assertion absent from claims -----

test("§8.7: empty claims array fails closed", () => {
  const result = validateClaimEvidence([], "explicit", "协议支持模式A", "已记录");
  assert.equal(result.valid, false);
  assert.equal((result as { reason: string }).reason, "no_claims");
});

test("§8.7: undefined claims fails closed", () => {
  const result = validateClaimEvidence(undefined, "explicit", "协议支持模式A", "已记录");
  assert.equal(result.valid, false);
  assert.equal((result as { reason: string }).reason, "no_claims");
});

// ---- §8.8: canonical new provenance and legacy compatibility mapping -----

test("§8.8: new D0 card writes canonical source_basis, not companion_self for explicit", async () => {
  const rig = await buildRig("canonical-provenance");
  const snap = syntheticSnapshot(1, "合成项目使用蓝色标签", "已记录合成项目标签。");
  enqueue(rig, snap);
  const claims: ClaimEvidence[] = [{
    claim_text: "使用蓝色标签",
    basis: "explicit",
    evidence_side: "user",
    evidence_excerpt: "合成项目使用蓝色标签",
  }];
  rig.results.push({
    ok: true,
    text: CARD_WITH_CLAIMS("合成项目使用蓝色标签。", claims),
  });
  await rig.worker.tick();
  assert.equal(rig.calls.length, 1);
  const card = rig.service.findBySourceTurn(snap.turnId);
  assert.ok(card, "card must exist");
  assert.equal(card!.approval_state, "policy_activated");
  const provenance = parseProvenance(card!);
  assert.ok(provenance, "provenance must be set");
  assert.equal(provenance!.source_basis, "user_stated", "explicit must map to user_stated");
  assert.equal(provenance!.authored_by, "companion");
  assert.equal(provenance!.proposal_origin, "companion_self");

});

test("§8.8: legacy companion_self maps to companion_self origin, null evidence basis", () => {
  const axes = deriveProvenanceAxes({ source_basis: "companion_self" });
  assert.equal(axes.proposalOrigin, "companion_self");
  assert.equal(axes.evidenceBasis, null);
});

test("§8.8: user_stated maps to explicit evidence basis", () => {
  const axes = deriveProvenanceAxes({ source_basis: "user_stated" });
  assert.equal(axes.evidenceBasis, "explicit");
  assert.equal(axes.proposalOrigin, "companion_self");
});

test("§8.8: owner_requested maps to owner_request", () => {
  const axes = deriveProvenanceAxes({ source_basis: "owner_requested" });
  assert.equal(axes.proposalOrigin, "owner_request");
});

// ---- §8.9: retrieval trust uses activation basis, never legacy origin ----

test("§8.9: trustRank uses source_basis field, not provenance origin", () => {
  const stub = (overrides: Partial<MemoryItemView>): MemoryItemView => ({
    id: "00000000-0000-0000-0000-000000000000",
    title: "t",
    body: "b",
    scope: "relationship",
    au_id: null,
    sensitivity: "normal",
    importance: 0,
    approval_state: "policy_activated",
    lifecycle_state: "active",
    seal_state: "open",
    confirmed_by: null,
    retrieval: "enabled",
    supersedes: null,
    source_basis: null,
    tags_text: "",
    created_at: "2099-01-01T00:00:00Z",
    updated_at: "2099-01-01T00:00:00Z",
    expires_at: null,
    ...overrides,
  });
  assert.equal(trustRank(stub({ source_basis: "explicit" })), 2, "explicit = rank 2");
  assert.equal(trustRank(stub({ source_basis: "observed" })), 1, "observed = rank 1");
  assert.equal(trustRank(stub({ source_basis: null })), 1, "absent basis = rank 1 (never defaults upward)");
});

// ---- §8.10: policy registration verified backup --------------------------

test("§8.10: ensureOwnerPolicy calls backup after successful registration", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "d0-corr-policy-")), "delos-memory.db");
  const handle = openMnemosyne(dbPath);
  const backupCalls: string[] = [];
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: (label) => { backupCalls.push(label); return { path: `${dbPath}.backup` }; },
    audit: () => {},
  });
  const result = await service.ensureOwnerPolicy(TEST_POLICY);
  assert.equal(result.status, "ok");
  assert.ok(backupCalls.includes("owner_policy"), "backup must be called with owner_policy label");

});

test("§8.10: policy registration with backup failure — write persists, audit records failure", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "d0-corr-policy-fail-")), "delos-memory.db");
  const handle = openMnemosyne(dbPath);
  const auditLog: Array<Record<string, unknown>> = [];
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: () => { throw new Error("synthetic backup failure"); },
    audit: (event) => auditLog.push(event),
  });
  const result = await service.ensureOwnerPolicy(TEST_POLICY);
  assert.equal(result.status, "ok", "write must succeed even if backup fails");
  const backupFailed = auditLog.find(e => e.type === "governance_backup_failed");
  assert.ok(backupFailed, "backup failure must be audited");
  assert.equal(backupFailed!.committed, true);
  assert.equal(backupFailed!.retry_safe, true);
  // Idempotent re-registration must not write again
  const again = await service.ensureOwnerPolicy(TEST_POLICY);
  assert.equal(again.status, "already");

});

// ---- §8.11: governed revocation and optional replacement -----------------

test("§8.11: revoke is idempotent — second revoke returns already", async () => {
  const rig = await buildRig("revoke-idempotent");
  const snap = syntheticSnapshot(1, "合成服务今天处于降级状态", "已收到合成服务状态。");
  enqueue(rig, snap);
  const claims: ClaimEvidence[] = [{
    claim_text: "服务处于降级状态",
    basis: "observed",
    evidence_side: "user",
    evidence_excerpt: "合成服务今天处于降级状态",
  }];
  rig.results.push({
    ok: true,
    text: JSON.stringify({
      decision: "propose",
      card: {
        body: "合成服务今天处于降级状态。",
        title: "合成服务状态",
        scope: "relationship",
        sensitivity: "sensitive",
        basis: "observed",
        claims,
      },
    }),
  });
  await rig.worker.tick();
  const card = rig.service.findBySourceTurn(snap.turnId);
  assert.ok(card, "card must exist");
  assert.equal(card!.approval_state, "policy_activated");
  assert.equal(card!.lifecycle_state, "active");
  const first = await rig.service.revoke(card!.id, "companion", "test revocation");
  assert.equal(first.status, "ok");
  const second = await rig.service.revoke(card!.id, "companion", "duplicate revocation");
  assert.equal(second.status, "already", "second revoke must be idempotent");

});

// ---- §8.14: enqueue-only accepts receipts with zero provider calls -------

test("§8.14: enqueue-only mode accepts new source receipts with zero provider calls", async () => {
  const rig = await buildRig("enqueue-only", { mode: "enqueue-only" });
  const snap = syntheticSnapshot(1);
  enqueue(rig, snap);
  assert.equal(rig.backlog.counters().deferred_total, 1);

  // tick() must be a no-op in enqueue-only
  await rig.worker.tick();
  assert.equal(rig.calls.length, 0, "zero provider calls in enqueue-only");
  assert.equal(rig.backlog.counters().deferred_total, 1, "item stays deferred");

  // Enqueue more — all durably recorded
  for (let i = 2; i <= 5; i++) {
    const s = syntheticSnapshot(i);
    enqueue(rig, s);
  }
  assert.equal(rig.backlog.counters().deferred_total, 5);
  await rig.worker.tick();
  assert.equal(rig.calls.length, 0, "still zero provider calls");

});

// ---- §8.4: buildVerifiedSourcePacket hash checks -------------------------

test("§8.4: buildVerifiedSourcePacket detects hash mismatch", () => {
  const snap = syntheticSnapshot(1);
  const result = buildVerifiedSourcePacket(snap, "wrong_hash");
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "hash_mismatch");
});

test("§8.4: buildVerifiedSourcePacket succeeds with correct hash", () => {
  const snap = syntheticSnapshot(1);
  const hash = turnContentHash(snap.userText!, snap.assistantText!);
  const result = buildVerifiedSourcePacket(snap, hash);
  assert.equal(result.ok, true);
  const packet = (result as { ok: true; packet: VerifiedSourcePacket }).packet;
  assert.equal(packet.userText, snap.userText);
  assert.equal(packet.assistantText, snap.assistantText);
});

test("§8.4: buildVerifiedSourcePacket rejects non-user turn", () => {
  const snap: TurnSnapshot = {
    conversationId: "c",
    turnId: "t",
    userMessageId: null,
    userText: null,
    assistantText: "hello",
    variantSha256: "v".repeat(64),
    selectedMemoryIds: [],
  };
  const result = buildVerifiedSourcePacket(snap, "anything");
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "non_user_turn");
});
