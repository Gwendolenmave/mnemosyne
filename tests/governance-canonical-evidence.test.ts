import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import {
  asConversationId,
  asImportId,
  asMessageId,
  asModelFamilyId,
  asTurnId,
} from "../core/domain/ids.js";
import type { MemoryCreationEvidence } from "../core/domain/memory.js";
import {
  MnemosyneGovernanceService,
  parseProvenance,
} from "../core/services/mnemosyne-governance.js";
import { deriveProvenanceAxes } from "../core/domain/mnemosyne.js";

const POLICY = {
  policyId: "synthetic-canonical-evidence-policy-v1",
  authority: "owner_global_policy" as const,
  effectiveFrom: "2026-08-26T00:00:00.000Z",
  manualPerCardApprovalRequired: false,
  ownerCanViewEditRevoke: true,
  authorityRef: `sha256:${"a".repeat(64)}`,
};

function fresh(label: string) {
  const dbPath = join(mkdtempSync(join(tmpdir(), `public-m1-${label}-`)), "mnemosyne.db");
  const handle = openMnemosyne(dbPath);
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: (name) => ({ path: `${dbPath}.${name}.backup` }),
    audit: () => undefined,
  });
  return { dbPath, handle, service };
}

function assistantDialogueEvidence(seed: string): MemoryCreationEvidence {
  return {
    kind: "assistant_dialogue",
    origin: { modelFamily: asModelFamilyId("synthetic") },
    source: {
      kind: "conversation_message",
      conversationId: asConversationId(`10000000-0000-4000-8000-${seed.padStart(12, "0")}`),
      turnId: asTurnId(`20000000-0000-4000-8000-${seed.padStart(12, "0")}`),
      messageId: asMessageId(`30000000-0000-4000-8000-${seed.padStart(12, "0")}`),
      role: "assistant",
    },
  };
}

function modelInferenceEvidence(seed: string): MemoryCreationEvidence {
  return {
    kind: "model_inference",
    origin: { modelFamily: asModelFamilyId("synthetic") },
    confidence: 0.7,
    derivedFrom: [
      {
        kind: "conversation_message",
        conversationId: asConversationId(`40000000-0000-4000-8000-${seed.padStart(12, "0")}`),
        turnId: asTurnId(`50000000-0000-4000-8000-${seed.padStart(12, "0")}`),
        messageId: asMessageId(`60000000-0000-4000-8000-${seed.padStart(12, "0")}`),
        role: "user",
      },
    ],
  };
}

function importedEvidence(seed: string): MemoryCreationEvidence {
  return {
    kind: "imported",
    source: {
      kind: "imported_record",
      importId: asImportId(`70000000-0000-4000-8000-${seed.padStart(12, "0")}`),
      recordLocator: `synthetic-record-${seed}`,
      author: "user",
    },
    confidence: 1,
  };
}

test("governance preserves canonical assistant-dialogue evidence and derives observed basis", async () => {
  const { handle, service } = fresh("observed");
  const evidence = assistantDialogueEvidence("1");
  const outcome = await service.propose({
    body: "Synthetic assistant-authored continuity observation.",
    title: "Synthetic observation",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: { kind: "memory_creation", evidence },
    proposedBy: "companion",
    executionActor: "system",
    provenance: { authored_by: "companion", proposal_origin: "companion_self" },
  });
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") return;

  const kernel = await handle.log.readAll();
  const created = kernel.find(
    (entry) => entry.event.type === "memory_created" && entry.event.memoryId === outcome.memoryId,
  );
  assert.ok(created && created.event.type === "memory_created");
  if (!created || created.event.type !== "memory_created") return;
  assert.deepEqual(created.event.evidence, evidence, "canonical evidence is never relabelled");

  const item = service.getCard(outcome.memoryId)!;
  assert.equal(item.source_basis, "observed");
  const axes = deriveProvenanceAxes(parseProvenance(item));
  assert.deepEqual(axes, { evidenceBasis: "observed", proposalOrigin: "companion_self" });
  handle.log.close();
});

test("candidate writer preserves inferred and imported evidence without promoting either", async () => {
  const { handle, service } = fresh("nonactivatable");
  const inferred = await service.propose({
    body: "Synthetic inference candidate.",
    scope: "project",
    sensitivity: "normal",
    importance: 1,
    evidence: { kind: "memory_creation", evidence: modelInferenceEvidence("2") },
    proposedBy: "companion",
  });
  const imported = await service.propose({
    body: "Synthetic imported candidate.",
    scope: "project",
    sensitivity: "normal",
    importance: 1,
    evidence: { kind: "memory_creation", evidence: importedEvidence("3") },
    proposedBy: "companion",
    provenance: { proposal_origin: "backfill", authored_by: "companion" },
  });
  assert.equal(inferred.status, "ok");
  assert.equal(imported.status, "ok");
  if (inferred.status !== "ok" || imported.status !== "ok") return;
  assert.equal(service.getCard(inferred.memoryId)!.source_basis, "inferred");
  assert.equal(service.getCard(imported.memoryId)!.source_basis, "imported");
  assert.equal(service.getCard(inferred.memoryId)!.approval_state, "candidate");
  assert.equal(service.getCard(imported.memoryId)!.approval_state, "candidate");
  const events = await handle.log.readAll();
  assert.equal(
    events.find((entry) => entry.event.type === "memory_created" && entry.event.memoryId === inferred.memoryId)?.event.type,
    "memory_created",
  );
  assert.equal(
    events.find((entry) => entry.event.type === "memory_created" && entry.event.memoryId === imported.memoryId)?.event.type,
    "memory_created",
  );
  handle.log.close();
});

test("proposal writer refuses canonical evidence and provenance contradictions before append", async () => {
  const { handle, service } = fresh("contradiction");
  const refused = await service.propose({
    body: "Synthetic contradictory proposal.",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: { kind: "memory_creation", evidence: assistantDialogueEvidence("4") },
    proposedBy: "companion",
    provenance: { source_basis: "explicit", authored_by: "companion" },
  });
  assert.equal(refused.status, "refused");
  if (refused.status === "refused") {
    assert.ok(refused.issues.some((issue) => issue.path === "provenance.source_basis"));
  }
  assert.equal((await handle.log.readAll()).length, 0);
  assert.equal(handle.store.readGovernance().length, 0);
  handle.log.close();
});

test("owner-policy writer requires activatable evidence, matching basis, and verified generator", async () => {
  const { handle, service } = fresh("policy");
  assert.notEqual((await service.ensureOwnerPolicy(POLICY)).status, "refused");

  const inferred = await service.proposeUnderPolicy({
    body: "Synthetic inferred auto-activation attempt.",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: { kind: "memory_creation", evidence: modelInferenceEvidence("5") },
    proposedBy: "companion",
    activation: { policyId: POLICY.policyId, sourceBasis: "explicit", generator: "synthetic-model" },
  });
  assert.equal(inferred.status, "refused");

  const mismatch = await service.proposeUnderPolicy({
    body: "Synthetic observed mismatch attempt.",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: { kind: "memory_creation", evidence: assistantDialogueEvidence("6") },
    proposedBy: "companion",
    activation: { policyId: POLICY.policyId, sourceBasis: "explicit", generator: "synthetic-model" },
  });
  assert.equal(mismatch.status, "refused");

  const unverified = await service.proposeUnderPolicy({
    body: "Synthetic unverified generator attempt.",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: { kind: "memory_creation", evidence: assistantDialogueEvidence("7") },
    proposedBy: "companion",
    activation: { policyId: POLICY.policyId, sourceBasis: "observed", generator: "unverified-model" },
  });
  assert.equal(unverified.status, "refused");

  const accepted = await service.proposeUnderPolicy({
    body: "Synthetic observed policy memory.",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: { kind: "memory_creation", evidence: assistantDialogueEvidence("8") },
    proposedBy: "companion",
    executionActor: "system",
    provenance: { authored_by: "companion", proposal_origin: "companion_self" },
    activation: { policyId: POLICY.policyId, sourceBasis: "observed", generator: "synthetic-model" },
  });
  assert.equal(accepted.status, "ok");
  if (accepted.status !== "ok") return;
  const item = service.getCard(accepted.memoryId)!;
  assert.equal(item.source_basis, "observed");
  assert.equal(item.approval_state, "policy_activated");
  assert.equal(item.confirmed_by, null);
  assert.equal(deriveProvenanceAxes(parseProvenance(item)).evidenceBasis, "observed");
  handle.log.close();
});

test("existing-card policy activation fails closed when requested and projected evidence bases disagree", async () => {
  const { handle, service } = fresh("existing");
  assert.notEqual((await service.ensureOwnerPolicy(POLICY)).status, "refused");
  const candidate = await service.propose({
    body: "Synthetic observed candidate for existing-card activation.",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: { kind: "memory_creation", evidence: assistantDialogueEvidence("9") },
    proposedBy: "companion",
    provenance: { authored_by: "companion" },
  });
  assert.equal(candidate.status, "ok");
  if (candidate.status !== "ok") return;

  const refused = await service.activateExistingUnderPolicy(candidate.memoryId, {
    policyId: POLICY.policyId,
    sourceBasis: "explicit",
    generator: "synthetic-model",
  });
  assert.equal(refused.status, "refused");
  if (refused.status === "refused") {
    assert.ok(refused.issues.some((issue) => issue.path === "activation.sourceBasis"));
  }
  assert.equal(service.getCard(candidate.memoryId)!.approval_state, "candidate");
  handle.log.close();
});
