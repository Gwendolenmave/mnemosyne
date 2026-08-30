/**
 * D0 §7 adversarial fixtures 10–17: policy-activated retrieval semantics,
 * honest confirmation state, precedence, supersession with history,
 * AU/reality labelling, intimate classification, Core/Prior byte
 * safety, and the five-pending reconciliation. SYNTHETIC content only.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import { MnemosyneGovernanceService, parseProvenance } from "../core/services/mnemosyne-governance.js";
import { GovernedCompanionProposalSink } from "../core/services/companion-proposal-sink.js";
import { buildMemoryReadPacket, isEligible, trustRank } from "../core/services/anamnesis.js";
import { deriveProvenanceAxes } from "../core/domain/mnemosyne.js";
import { reconcilePendingCards } from "../scripts/d0-recovery.js";
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
const ACTIVATION = { policyId: POLICY_ID, sourceBasis: "explicit" as const, generator: "synthetic-model" };
const NOW_ISO = "2026-08-02T12:00:00.000Z";

async function buildService(label: string) {
  const dbPath = join(mkdtempSync(join(tmpdir(), `d0p-${label}-`)), "delos-memory.db");
  const handle = openMnemosyne(dbPath);
  const audit: Array<Record<string, unknown>> = [];
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: (l) => ({ path: `${dbPath}.gov-backup-${l}` }),
    audit: (event) => audit.push(event),
  });
  const registered = await service.ensureOwnerPolicy(TEST_POLICY);
  assert.notEqual(registered.status, "refused");
  return { service, handle, audit, dbPath };
}

function turnUuid(i: number): string {
  return `aaaa1111-0000-4000-8000-${String(i).padStart(12, "0")}`;
}

function transcriptEvidence(i: number) {
  return {
    kind: "transcript" as const,
    conversationId: "bbbb2222-0000-4000-8000-000000000001",
    turnId: turnUuid(i),
    messageId: `cccc3333-0000-4000-8000-${String(i).padStart(12, "0")}`,
  };
}

// ---- §7.10/11: retrieval eligibility + honest confirmation state ----------

test("D0 §7.10/11: a policy-activated card is retrievable; candidates are not; confirmed_by stays NULL", async () => {
  const { service, handle } = await buildService("retrieval");
  const activated = await service.proposeUnderPolicy({
      body: "synthetic 合成操作员正在校验月面温室。",
      title: "synthetic 月面温室",
      tags: ["月面温室"],
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(1),
    proposedBy: "companion",
    executionActor: "system",
    provenance: { authored_by: "companion", proposal_origin: "companion_self" },
    activation: ACTIVATION,
  });
  assert.equal(activated.status, "ok");
  if (activated.status !== "ok") return;
  const candidate = await service.propose({
      body: "synthetic 一张还没归档的候选卡（月面温室相关）。",
      title: "synthetic 候选月面温室",
      tags: ["月面温室候选"],
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(2),
    proposedBy: "companion",
    executionActor: "system",
    provenance: { authored_by: "companion" },
  });
  assert.equal(candidate.status, "ok");
  if (candidate.status !== "ok") return;

  const card = service.getCard(activated.memoryId)!;
  assert.equal(card.approval_state, "policy_activated");
  assert.equal(card.confirmed_by, null, "§7.11: confirmed_by remains NULL for policy activation");

  const packet = buildMemoryReadPacket({
    source: handle.store,
    query: "月面温室",
    scene: { mode: "ordinary", intimacyActive: false },
    nowIso: NOW_ISO,
  });
  const ids = packet.memories.map((m) => m.id);
  assert.ok(ids.includes(activated.memoryId), "policy-activated card IS retrievable");
  assert.ok(!ids.includes(candidate.memoryId), "candidate is NOT retrievable");
  const label = packet.memories.find((m) => m.id === activated.memoryId)!.confidence;
  assert.equal(label, "auto:explicit", "visible trust distinction in the packet");
  handle.log.close();
});

test("D0: activation is fail-closed without a registered policy and never claims owner/system confirmation", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "d0p-nopolicy-")), "delos-memory.db");
  const handle = openMnemosyne(dbPath);
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: (l) => ({ path: `${dbPath}.gov-backup-${l}` }),
    audit: () => undefined,
  });
  const refused = await service.proposeUnderPolicy({
    body: "synthetic 没有政策就不许自动入档。",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: { kind: "manual" },
    proposedBy: "companion",
    executionActor: "system",
    activation: ACTIVATION,
  });
  assert.equal(refused.status, "refused");
  if (refused.status !== "refused") return;
  assert.ok(refused.issues[0]!.message.includes("not durably registered"));
  const outcome = handle.store.appendGovernance([
    {
      eventId: "dddd4444-0000-4000-8000-000000000009",
      occurredAt: NOW_ISO,
      actor: "system",
      event: { type: "confirmed", memoryId: "eeee5555-0000-4000-8000-000000000001", by: "owner" },
    },
  ]);
  assert.equal(outcome.status, "rejected");
  handle.log.close();
});

// ---- §7.12: confirmed cards keep semantics and precedence ------------------

test("D0 §7.12: individually confirmed cards keep their semantics and outrank policy-activated on conflict", async () => {
  const { service, handle } = await buildService("precedence");
  const confirmed = await service.propose({
      body: "synthetic 项目标签当前为 alpha。",
      title: "synthetic 项目标签",
      tags: ["项目标签"],
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(3),
    proposedBy: "companion",
    executionActor: "system",
    provenance: { authored_by: "companion" },
  });
  assert.equal(confirmed.status, "ok");
  if (confirmed.status !== "ok") return;
  await service.approve(confirmed.memoryId, "owner");
  const auto = await service.proposeUnderPolicy({
      body: "synthetic 项目标签当前为 beta。",
      title: "synthetic 项目标签",
      tags: ["项目标签"],
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(4),
    proposedBy: "companion",
    executionActor: "system",
    provenance: { authored_by: "companion", proposal_origin: "companion_self" },
    activation: ACTIVATION,
  });
  assert.equal(auto.status, "ok");
  if (auto.status !== "ok") return;

  const confirmedCard = service.getCard(confirmed.memoryId)!;
  assert.equal(confirmedCard.approval_state, "confirmed");
  assert.equal(confirmedCard.confirmed_by, "owner", "existing confirmation semantics unchanged");
  assert.ok(trustRank({ ...confirmedCard, seal_state: "unsealed" } as never) > 0);

  const packet = buildMemoryReadPacket({
    source: handle.store,
    query: "项目标签",
    scene: { mode: "ordinary", intimacyActive: false },
    nowIso: NOW_ISO,
  });
  const ids = packet.memories.map((m) => m.id);
  assert.ok(ids.includes(confirmed.memoryId), "confirmed card retrieved");
  assert.ok(!ids.includes(auto.memoryId), "policy-activated same-title card outranked");
  const excludedReason = packet.audit.excluded.find((e) => e.id === auto.memoryId)?.reason;
  assert.ok(excludedReason?.includes("outranked"), `reason: ${excludedReason}`);
  handle.log.close();
});

// ---- §7.13: supersession preserves history --------------------------------

test("D0 §7.13: explicit new state supersedes an older card without erasing history", async () => {
  const { service, handle } = await buildService("supersede");
  const old = await service.proposeUnderPolicy({
      body: "synthetic 数据格式仍为版本 A。",
      title: "synthetic 数据格式版本",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(5),
    proposedBy: "companion",
    executionActor: "system",
    activation: ACTIVATION,
  });
  assert.equal(old.status, "ok");
  if (old.status !== "ok") return;
  const replacement = await service.proposeUnderPolicy({
      body: "synthetic 数据格式已升级到版本 B。",
      title: "synthetic 数据格式版本（新）",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(6),
    proposedBy: "companion",
    executionActor: "system",
    activation: ACTIVATION,
    supersedes: { memoryId: old.memoryId, reason: "explicit new state from source turn" },
  });
  assert.equal(replacement.status, "ok");
  if (replacement.status !== "ok") return;

  const oldCard = service.getCard(old.memoryId)!;
  assert.equal(oldCard.lifecycle_state, "superseded");
  const kernel = await handle.log.readAll();
  const oldHistory = kernel.filter((e) => e.event.memoryId === old.memoryId);
  assert.ok(oldHistory.length >= 2, "history preserved: created + superseded");
  assert.equal(oldHistory.some((e) => e.event.type === "memory_superseded"), true);

  const packet = buildMemoryReadPacket({
    source: handle.store,
    query: "数据格式",
    scene: { mode: "ordinary", intimacyActive: false },
    nowIso: NOW_ISO,
  });
  const ids = packet.memories.map((m) => m.id);
  assert.ok(ids.includes(replacement.memoryId));
  assert.ok(!ids.includes(old.memoryId), "superseded card never retrieves");
  handle.log.close();
});

// ---- §7.14: AU / reality labelling ----------------------------------------

test("D0 §7.14: AU and reality cards coexist with explicit model-visible realm metadata", async () => {
  const { service, handle } = await buildService("au");
  const reality = await service.proposeUnderPolicy({
      body: "synthetic 现实层有一个编号 R7 的档案箱。",
      title: "synthetic 档案箱 R7",
      tags: ["档案箱"],
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(7),
    proposedBy: "companion",
    executionActor: "system",
    activation: ACTIVATION,
  });
  const au = await service.proposeUnderPolicy({
      body: "synthetic AU 设定里档案箱 R7 会唱歌。",
      title: "synthetic AU 档案箱设定",
      tags: ["档案箱"],
    scope: "au",
    auId: "au-synthetic-1",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(8),
    proposedBy: "companion",
    executionActor: "system",
    activation: ACTIVATION,
  });
  assert.equal(reality.status, "ok");
  assert.equal(au.status, "ok");
  if (reality.status !== "ok" || au.status !== "ok") return;

  const ordinary = buildMemoryReadPacket({
    source: handle.store,
    query: "档案箱",
    scene: { mode: "ordinary", intimacyActive: false },
    nowIso: NOW_ISO,
  });
  assert.ok(ordinary.memories.some((m) => m.id === reality.memoryId));
  assert.equal(ordinary.memories.find((m) => m.id === au.memoryId)?.auId, "au-synthetic-1");

  const inAu = buildMemoryReadPacket({
    source: handle.store,
    query: "档案箱",
    scene: { mode: "au", auId: "au-synthetic-1", intimacyActive: false },
    nowIso: NOW_ISO,
  });
  assert.ok(inAu.memories.some((m) => m.id === au.memoryId), "AU card retrieves inside its AU");

  const otherAu = buildMemoryReadPacket({
    source: handle.store,
    query: "档案箱",
    scene: { mode: "au", auId: "au-synthetic-OTHER", intimacyActive: false },
    nowIso: NOW_ISO,
  });
  assert.ok(otherAu.memories.some((m) => m.id === au.memoryId), "scene selection is ranking advice, not isolation");
  handle.log.close();
});

// ---- §7.15: intimate classification ---------------------------------------

test("D0 §7.15: intimate policy-activated material is retrievable without a context gate", async () => {
  const { service, handle } = await buildService("intimate");
  const intimate = await service.proposeUnderPolicy({
      body: "synthetic intimate fixture token OMEGA，仅用于权限隔离测试。",
    title: "synthetic 私密",
    tags: ["synthetic私密标记"],
    scope: "relationship",
    sensitivity: "intimate",
    importance: 2,
    evidence: transcriptEvidence(9),
    proposedBy: "companion",
    executionActor: "system",
    activation: ACTIVATION,
  });
  assert.equal(intimate.status, "ok");
  if (intimate.status !== "ok") return;
  const card = service.getCard(intimate.memoryId)!;
  assert.equal(card.retrieval, "enabled", "intimate classification is not a default retrieval-off");
  const verdict = isEligible(card as never, { mode: "ordinary", intimacyActive: false }, NOW_ISO);
  assert.equal(verdict.ok, true);
  const packet = buildMemoryReadPacket({
    source: handle.store,
    query: "synthetic私密标记",
    scene: { mode: "ordinary", intimacyActive: true },
    nowIso: NOW_ISO,
  });
  assert.equal(packet.memories.some((memory) => memory.id === intimate.memoryId), true);
  handle.log.close();
});

// ---- §7.16: Core / House Prior byte safety --------------------------------

test("D0 §7.16: prompt sources are byte-identical and priors untouched across the full flow", async () => {
  const promptsDir = join(process.cwd(), "prompts");
  const before = new Map<string, string>();
  for (const name of readdirSync(promptsDir)) {
    before.set(name, createHash("sha256").update(readFileSync(join(promptsDir, name))).digest("hex"));
  }
  const { service, handle } = await buildService("prior-safety");
  const priorsBefore = JSON.stringify(handle.store.listPriors());
  await service.proposeUnderPolicy({
    body: "synthetic 正常的一条自动入档记忆。",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(10),
    proposedBy: "companion",
    executionActor: "system",
    activation: ACTIVATION,
  });
  assert.equal(JSON.stringify(handle.store.listPriors()), priorsBefore, "priors untouched");
  for (const name of readdirSync(promptsDir)) {
    const after = createHash("sha256").update(readFileSync(join(promptsDir, name))).digest("hex");
    assert.equal(after, before.get(name), `prompt file ${name} byte-identical`);
  }
  handle.log.close();
});

// ---- §7.17: five-pending reconciliation -----------------------------------

test("D0 §7.17: existing pending cards reach typed terminal outcomes without owner action", async () => {
  const { service, handle, audit } = await buildService("five-pending");
  const sink = new GovernedCompanionProposalSink(service);
  const snapshots = new Map<string, TurnSnapshot>();
  const mkTurn = (i: number, userText: string, assistantText: string): TurnSnapshot => {
    const snap: TurnSnapshot = {
      conversationId: "bbbb2222-0000-4000-8000-000000000001",
      turnId: turnUuid(100 + i),
      userMessageId: `cccc3333-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
      userText,
      assistantText,
      variantSha256: "v".repeat(64),
      selectedMemoryIds: [],
    };
    snapshots.set(snap.turnId, snap);
    return snap;
  };
  const cards: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    mkTurn(i, `synthetic source item ${i}`, `synthetic response item ${i}`);
    const proposed = await service.propose({
      body: `synthetic 待归档旧卡第${i}张`,
      title: `synthetic 旧卡${i}`,
      scope: "relationship",
      sensitivity: "normal",
      importance: 2,
      evidence: transcriptEvidence(100 + i),
      proposedBy: "companion",
      executionActor: "system",
      provenance: { authored_by: "companion", proposed_by: "companion", source_basis: "explicit" },
    });
    assert.equal(proposed.status, "ok");
    if (proposed.status === "ok") cards.push(proposed.memoryId);
  }
  snapshots.delete(turnUuid(104));
  const results: ModelResult[] = [
    { ok: true, text: '{"basis":"explicit"}', servedModel: "synthetic-model" },
    { ok: true, text: '{"basis":"observed","valid_until":"2026-07-20T00:00:00+08:00"}', servedModel: "synthetic-model" },
    { ok: true, text: '{"basis":"inferred"}', servedModel: "synthetic-model" },
    { ok: true, text: '{"basis":"observed"}', servedModel: "synthetic-model" },
  ];
  const outcomes = await reconcilePendingCards({
    cards: cards.map((id) => {
      const item = service.getCard(id)!;
      return {
        id: item.id,
        body: item.body,
        title: item.title,
        sensitivity: item.sensitivity,
        scope: item.scope,
        approval_state: item.approval_state,
        lifecycle_state: item.lifecycle_state,
      };
    }),
    sourcePointer: (memoryId) => service.sourcePointer(memoryId),
    snapshotByTurn: (turnId) => snapshots.get(turnId) ?? null,
    sink,
    provider: {
      generate: async () => results.shift() ?? { ok: false, errorKind: "empty_output", detail: "no result" },
    },
    persona: { staticPrefix: "SYNTHETIC-PERSONA-CORE" },
    policyId: POLICY_ID,
    audit: (event) => audit.push(event),
    now: () => new Date(NOW_ISO),
  });

  assert.equal(outcomes.length, 5);
  assert.deepEqual(outcomes[0], { memoryId: cards[0]!, outcome: "policy_activated", basis: "explicit" });
  assert.equal(service.getCard(cards[0]!)!.approval_state, "policy_activated");
  assert.equal(service.getCard(cards[0]!)!.confirmed_by, null);

  // #1 was created from canonical user-statement evidence (explicit), but the
  // historical classifier now asks to relabel it observed. The governance
  // writer refuses that contradiction; no expiry or activation is appended.
  assert.equal(outcomes[1]!.outcome, "failed");
  if (outcomes[1]!.outcome === "failed") {
    assert.ok(outcomes[1]!.detail.includes("evidence basis"));
  }
  const contradictoryTemporal = service.getCard(cards[1]!)!;
  assert.equal(contradictoryTemporal.approval_state, "candidate");
  assert.equal(handle.store.getItem(cards[1]!)!.source_basis, "explicit");
  assert.equal(handle.store.getItem(cards[1]!)!.expires_at, null);

  assert.deepEqual(outcomes[2], { memoryId: cards[2]!, outcome: "quarantined_candidate", detail: "inferred_basis" });
  assert.equal(service.getCard(cards[2]!)!.approval_state, "candidate");

  // #3 is the same immutable-evidence contradiction without a temporal hint.
  assert.equal(outcomes[3]!.outcome, "failed");
  if (outcomes[3]!.outcome === "failed") {
    assert.ok(outcomes[3]!.detail.includes("evidence basis"));
  }
  assert.equal(service.getCard(cards[3]!)!.approval_state, "candidate");
  assert.equal(handle.store.getItem(cards[3]!)!.source_basis, "explicit");

  assert.equal(outcomes[4]!.outcome, "quarantined_candidate");
  if (outcomes[4]!.outcome === "quarantined_candidate") assert.ok(outcomes[4]!.detail.startsWith("source_invalid:"));
  assert.equal(service.getCard(cards[4]!)!.approval_state, "candidate");
  for (const id of cards) assert.equal(service.getCard(id)!.lifecycle_state, "active");
  handle.log.close();
});

// ---- compatibility reader --------------------------------------------------

test("D0: new writers canonicalize legacy proposal hints while the compatibility reader remains historical", async () => {
  const { service, handle } = await buildService("compat-axes");
  const migrated = await service.propose({
    body: "synthetic 一张旧词表调用产生的新卡。",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(30),
    proposedBy: "companion",
    executionActor: "system",
    provenance: { source_basis: "owner_requested", requested_by: "owner", authored_by: "companion" },
  });
  assert.equal(migrated.status, "ok");
  if (migrated.status !== "ok") return;
  const roles = parseProvenance(service.getCard(migrated.memoryId)!)!;
  assert.equal(roles.source_basis, "explicit", "new writer emits the canonical evidence axis");
  assert.equal(roles.proposal_origin, "owner_request", "legacy workflow hint becomes proposal_origin");
  assert.deepEqual(deriveProvenanceAxes(roles), {
    evidenceBasis: "explicit",
    proposalOrigin: "owner_request",
  });
  assert.deepEqual(deriveProvenanceAxes({ source_basis: "owner_requested", requested_by: "owner" }), {
    evidenceBasis: null,
    proposalOrigin: "owner_request",
  });
  assert.deepEqual(deriveProvenanceAxes({ source_basis: "user_stated", requested_by: "owner" }), {
    evidenceBasis: "explicit",
    proposalOrigin: "owner_request",
  });
  assert.deepEqual(deriveProvenanceAxes(null), { evidenceBasis: null, proposalOrigin: null });
  handle.log.close();
});

// ---- owner rights over policy-activated cards ------------------------------

test("D0: the owner can revoke a policy-activated card, and revocation removes it from retrieval", async () => {
  const { service, handle } = await buildService("revoke");
  const auto = await service.proposeUnderPolicy({
      body: "synthetic 这条夹具记录应被撤回。",
    title: "synthetic 待撤回",
    tags: ["撤回"],
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: transcriptEvidence(31),
    proposedBy: "companion",
    executionActor: "system",
    activation: ACTIVATION,
  });
  assert.equal(auto.status, "ok");
  if (auto.status !== "ok") return;
  const revoked = await service.revoke(auto.memoryId, "owner", "synthetic 不想留");
  assert.equal(revoked.status, "ok");
  const card = service.getCard(auto.memoryId)!;
  assert.equal(card.lifecycle_state, "revoked");
  const packet = buildMemoryReadPacket({ source: handle.store, query: "撤回", scene: { mode: "ordinary", intimacyActive: false }, nowIso: NOW_ISO });
  assert.deepEqual(packet.memories, []);
  handle.log.close();
});