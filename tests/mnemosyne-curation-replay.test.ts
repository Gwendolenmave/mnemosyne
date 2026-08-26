import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryCreationEvidence } from "../core/domain/memory.js";
import { asConversationId, asMessageId, asTurnId } from "../core/domain/ids.js";
import {
  applyCurationDecisionSet,
  preflightCurationApplication,
  type CurationBatchReceipt,
  type CurationDecisionReceipt,
  type CurationWritePlan,
  type CurationWriter,
} from "../core/services/mnemosyne-curation-applicator.js";
import {
  curationDecisionSetDigest,
  sha256Text,
  type CurationArtifactFile,
  type CurationDecisionSetBundle,
  type CurationEvidenceEntry,
} from "../core/services/mnemosyne-curation-contract.js";
import type { GovernanceItemView } from "../core/services/mnemosyne-governance.js";

const CANONICAL = "a".repeat(40);
const REVIEW = "b".repeat(40);
const FILE_COMMIT = "c".repeat(40);
const PACKET = "d".repeat(64);

function evidence(): MemoryCreationEvidence {
  return {
    kind: "user_statement",
    source: {
      kind: "conversation_message",
      conversationId: asConversationId("00000000-0000-4000-8000-000000000011"),
      turnId: asTurnId("00000000-0000-4000-8000-000000000012"),
      messageId: asMessageId("00000000-0000-4000-8000-000000000013"),
      role: "user",
    },
  };
}

function artifact(path: string, content: string): CurationArtifactFile {
  return { path, content, sha256: sha256Text(content), commitSha: FILE_COMMIT };
}

function decision(cardId: string): Record<string, unknown> {
  return {
    schema: "delos.mnemosyne.card-decision.v1",
    card_id: cardId,
    original_card_sha256: sha256Text(`card:${cardId}`),
    source_turn_sha256: sha256Text(`turn:${cardId}`),
    action: "KEEP",
    replacement_title: null,
    replacement_body: null,
    replacement_scope: null,
    replacement_au_id: null,
    supersedes_card_ids: [],
    merge_card_ids: [],
    reason: "synthetic keep",
    reviewer: "owner",
    reviewed_at: "2026-08-26T06:00:00.000Z",
  };
}

function bundle(cardIds: readonly string[]): CurationDecisionSetBundle {
  const rows = cardIds.map(decision);
  const schemaFile = artifact("decisions/SCHEMA.md", "synthetic schema\n");
  const decisionFiles = [
    artifact("decisions/REVIEWED.jsonl", `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`),
  ];
  const cards: Record<string, CurationEvidenceEntry> = {};
  for (const entry of rows) {
    const cardId = entry.card_id as string;
    cards[cardId] = {
      originalCardSha256: entry.original_card_sha256 as string,
      sourceTurnSha256: entry.source_turn_sha256 as string,
      evidence: evidence(),
    };
  }
  const input = {
    canonicalHead: CANONICAL,
    reviewHead: REVIEW,
    schemaFile,
    packetSha256: PACKET,
    decisionFiles,
    amendmentFiles: [],
    evidenceIndex: { packetSha256: PACKET, cards },
  };
  return { ...input, decisionSetSha256: curationDecisionSetDigest(input) };
}

function item(id: string): GovernanceItemView {
  return {
    id,
    title: `title ${id}`,
    body: `body ${id}`,
    scope: "relationship",
    au_id: null,
    sensitivity: "normal",
    importance: 2,
    approval_state: "policy_activated",
    lifecycle_state: "active",
    confirmed_by: null,
    retrieval: "enabled",
    supersedes: null,
    source_basis: "explicit",
    tags_text: "synthetic",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    provenance: JSON.stringify({ source_basis: "explicit", reviewed_by: "owner" }),
  };
}

function receiptFor(plan: CurationWritePlan): CurationDecisionReceipt {
  return {
    memoryId: plan.decision.row.card_id,
    decisionId: plan.decision.decisionId,
    decisionSetId: plan.decision.decisionSetId,
    action: plan.action,
    targetDigest: plan.targetDigest,
    preconditionDigest: plan.preconditionDigest,
  };
}

class FakeWriter implements CurationWriter {
  readonly decisions = new Map<string, CurationDecisionReceipt>();
  readonly batches = new Map<string, CurationBatchReceipt>();
  readonly applied: string[] = [];
  readonly completed: string[] = [];
  corruptNextReceipt = false;

  readDecisionReceipt(decisionId: string): CurationDecisionReceipt | undefined {
    return this.decisions.get(decisionId);
  }

  readBatchReceipt(decisionSetId: string): CurationBatchReceipt | undefined {
    return this.batches.get(decisionSetId);
  }

  async applyDecision(plan: CurationWritePlan) {
    this.applied.push(plan.decision.decisionId);
    const receipt = receiptFor(plan);
    if (this.corruptNextReceipt) {
      this.corruptNextReceipt = false;
      return { status: "ok" as const, receipt: { ...receipt, targetDigest: "0".repeat(64) } };
    }
    this.decisions.set(receipt.decisionId, receipt);
    return { status: "ok" as const, receipt };
  }

  async completeBatch(receipt: CurationBatchReceipt) {
    this.completed.push(receipt.decisionSetId);
    this.batches.set(receipt.decisionSetId, receipt);
    return { status: "ok" as const };
  }
}

test("exact durable decision receipts skip post-write state and perform zero semantic writes", async () => {
  const input = bundle(["card-a"]);
  const state = new Map([["card-a", item("card-a")]]);
  const reader = { getItem: (id: string) => state.get(id) };
  const initial = preflightCurationApplication(input, reader);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;

  const writer = new FakeWriter();
  const exact = receiptFor(initial.plans[0]!);
  writer.decisions.set(exact.decisionId, exact);
  // Simulate projection state after a semantic action: replay must use durable
  // identity rather than requiring the old frozen card to still exist.
  state.clear();

  const result = await applyCurationDecisionSet(input, reader, writer);
  assert.equal(result.status, "already");
  if (result.status === "refused") return;
  assert.equal(result.applied, 0);
  assert.equal(result.already, 1);
  assert.deepEqual(writer.applied, []);
  assert.equal(writer.completed.length, 1);
});

test("mixed replay applies only decisions without a durable per-decision receipt", async () => {
  const input = bundle(["card-a", "card-b"]);
  const state = new Map([
    ["card-a", item("card-a")],
    ["card-b", item("card-b")],
  ]);
  const reader = { getItem: (id: string) => state.get(id) };
  const initial = preflightCurationApplication(input, reader);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;

  const writer = new FakeWriter();
  const priorPlan = initial.plans.find((plan) => plan.decision.row.card_id === "card-a")!;
  const prior = receiptFor(priorPlan);
  writer.decisions.set(prior.decisionId, prior);

  const result = await applyCurationDecisionSet(input, reader, writer);
  assert.equal(result.status, "ok");
  if (result.status === "refused") return;
  assert.equal(result.applied, 1);
  assert.equal(result.already, 1);
  assert.equal(writer.applied.length, 1);
  assert.equal(writer.decisions.size, 2);
  assert.equal(writer.completed.length, 1);
});

test("conflicting reuse of a decision id fails closed before the writer is called", async () => {
  const input = bundle(["card-a"]);
  const reader = { getItem: (id: string) => item(id) };
  const initial = preflightCurationApplication(input, reader);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;

  const writer = new FakeWriter();
  const exact = receiptFor(initial.plans[0]!);
  writer.decisions.set(exact.decisionId, { ...exact, targetDigest: "f".repeat(64) });

  const result = await applyCurationDecisionSet(input, reader, writer);
  assert.equal(result.status, "refused");
  if (result.status !== "refused") return;
  assert.ok(result.issues.some((issue) => issue.message.includes("conflicting durable receipt")));
  assert.deepEqual(writer.applied, []);
  assert.deepEqual(writer.completed, []);
});

test("an exact durable batch receipt makes whole-set replay a zero-write no-op", async () => {
  const input = bundle(["card-a", "card-b"]);
  const reader = { getItem: (id: string) => item(id) };
  const initial = preflightCurationApplication(input, reader);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;

  const writer = new FakeWriter();
  for (const plan of initial.plans) {
    const receipt = receiptFor(plan);
    writer.decisions.set(receipt.decisionId, receipt);
  }
  writer.batches.set(initial.decisionSetId, {
    decisionSetId: initial.decisionSetId,
    decisionSetSha256: initial.decisionSetSha256,
    decisionIds: initial.plans.map((plan) => plan.decision.decisionId).sort(),
  });

  const result = await applyCurationDecisionSet(input, reader, writer);
  assert.equal(result.status, "already");
  assert.deepEqual(writer.applied, []);
  assert.deepEqual(writer.completed, []);
});

test("writer receipt mismatch is rejected before batch completion", async () => {
  const input = bundle(["card-a"]);
  const writer = new FakeWriter();
  writer.corruptNextReceipt = true;

  const result = await applyCurationDecisionSet(input, { getItem: (id) => item(id) }, writer);
  assert.equal(result.status, "refused");
  if (result.status !== "refused") return;
  assert.ok(result.issues.some((issue) => issue.message.includes("does not bind")));
  assert.equal(writer.applied.length, 1);
  assert.deepEqual(writer.completed, []);
});
