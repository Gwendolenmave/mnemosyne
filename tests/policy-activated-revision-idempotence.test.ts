import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import type { MemoryCreationEvidence } from "../core/domain/memory.js";
import {
  asConversationId,
  asMessageId,
  asModelFamilyId,
  asTurnId,
} from "../core/domain/ids.js";
import {
  MnemosyneGovernanceService,
  parseProvenance,
  type GovernanceItemView,
  type PolicyActivatedRepairAttributes,
} from "../core/services/mnemosyne-governance.js";
import {
  policyRevisionPreconditionDigest,
  policyRevisionTargetDigest,
  type PolicyRevisionDecision,
} from "../core/services/policy-revision-idempotence.js";

function assistantEvidence(): MemoryCreationEvidence {
  return {
    kind: "assistant_dialogue",
    origin: { modelFamily: asModelFamilyId("synthetic-family") },
    source: {
      kind: "conversation_message",
      conversationId: asConversationId(randomUUID()),
      turnId: asTurnId(randomUUID()),
      messageId: asMessageId(randomUUID()),
      role: "assistant",
    },
  };
}

function preconditionDigest(item: GovernanceItemView): string {
  const basis = item.source_basis;
  assert.ok(basis === "explicit" || basis === "observed");
  const scope = item.scope;
  assert.ok(scope === "global" || scope === "relationship" || scope === "project" || scope === "au");
  const sensitivity = item.sensitivity;
  assert.ok(sensitivity === "normal" || sensitivity === "sensitive" || sensitivity === "intimate");
  assert.ok(item.importance === 1 || item.importance === 2 || item.importance === 3);
  return policyRevisionPreconditionDigest({
    id: item.id,
    body: item.body,
    title: item.title,
    tags: item.tags_text.split(" ").filter(Boolean),
    scope,
    auId: item.au_id,
    sensitivity,
    importance: item.importance,
    approvalState: item.approval_state,
    lifecycleState: item.lifecycle_state,
    sourceBasis: basis,
    provenance: parseProvenance(item),
  });
}

function projectionDigest(item: GovernanceItemView): string {
  return JSON.stringify({
    body: item.body,
    title: item.title,
    tags: item.tags_text,
    scope: item.scope,
    auId: item.au_id,
    sensitivity: item.sensitivity,
    importance: item.importance,
    approval: item.approval_state,
    lifecycle: item.lifecycle_state,
    retrieval: item.retrieval,
    sourceBasis: item.source_basis,
    provenance: item.provenance,
    updatedAt: item.updated_at,
  });
}

test("policy revision decision replays as a durable zero-write no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mnemo-public-policy-revision-"));
  const dbPath = join(dir, "memory.db");
  try {
    let backupCount = 0;
    let auditCount = 0;
    let nowCalls = 0;
    const now = () => new Date(Date.UTC(2026, 7, 26, 1, 0, nowCalls++));
    let handle = openMnemosyne(dbPath);
    let service = new MnemosyneGovernanceService({
      store: handle.store,
      backup: (label) => {
        backupCount += 1;
        return { path: `${dbPath}.backup-${label}-${backupCount}` };
      },
      audit: () => {
        auditCount += 1;
      },
      now,
    });

    const policyId = "synthetic-policy-revision-v1";
    assert.equal(
      (
        await service.ensureOwnerPolicy({
          policyId,
          authority: "owner_global_policy",
          effectiveFrom: "2026-08-26T00:00:00.000Z",
          manualPerCardApprovalRequired: false,
          ownerCanViewEditRevoke: true,
          authorityRef: "synthetic-owner-ruling-revision",
        })
      ).status,
      "ok",
    );

    const created = await service.proposeUnderPolicy({
      body: "synthetic durable original statement",
      title: "synthetic original title",
      tags: ["synthetic", "oldtag"],
      scope: "relationship",
      sensitivity: "normal",
      importance: 2,
      evidence: { kind: "memory_creation", evidence: assistantEvidence() },
      proposedBy: "companion",
      executionActor: "system",
      provenance: { discovered_by: "companion", proposed_by: "companion" },
      activation: {
        policyId,
        sourceBasis: "observed",
        generator: "synthetic-memory-governor-v1",
      },
    });
    assert.equal(created.status, "ok");
    if (created.status !== "ok") return;

    const before = service.getCard(created.memoryId)!;
    const replacementEvidence = assistantEvidence();
    const attrs: PolicyActivatedRepairAttributes = {
      tags: ["synthetic", "newtag"],
      scope: "project",
      sensitivity: "sensitive",
      importance: 3,
    };
    const decision: PolicyRevisionDecision = {
      decisionId: "synthetic-curation-decision-0001",
      sourceSha256: "a".repeat(64),
      preconditionDigest: preconditionDigest(before),
    };
    const expectedTargetDigest = policyRevisionTargetDigest(decision, {
      memoryId: created.memoryId,
      body: "synthetic corrected durable statement",
      title: "synthetic corrected title",
      tags: ["synthetic", "newtag"],
      scope: "project",
      auId: null,
      sensitivity: "sensitive",
      importance: 3,
      evidence: replacementEvidence,
      sourceBasis: "observed",
    });

    const first = await service.revisePolicyActivated(
      created.memoryId,
      "synthetic corrected durable statement",
      replacementEvidence,
      "owner",
      "synthetic corrected title",
      attrs,
      decision,
    );
    assert.equal(first.status, "ok");

    const afterFirst = service.getCard(created.memoryId)!;
    assert.equal(afterFirst.tags_text, "synthetic newtag");
    assert.equal(afterFirst.scope, "project");
    assert.equal(afterFirst.sensitivity, "sensitive");
    assert.equal(afterFirst.importance, 3);
    assert.equal(handle.store.ftsSearch("oldtag", 10).some((hit) => hit.itemId === created.memoryId), false);
    assert.equal(handle.store.ftsSearch("newtag", 10).some((hit) => hit.itemId === created.memoryId), true);

    const kernelAfterFirst = await handle.log.readAll();
    const receipt = [...handle.store.readGovernance()]
      .reverse()
      .find(
        (envelope) =>
          envelope.event.type === "policy_revision_recorded" &&
          envelope.event.decisionId === decision.decisionId,
      );
    assert.ok(receipt !== undefined && receipt.event.type === "policy_revision_recorded");
    if (receipt === undefined || receipt.event.type !== "policy_revision_recorded") return;
    assert.equal(receipt.event.memoryId, created.memoryId);
    assert.equal(receipt.event.targetDigest, expectedTargetDigest);
    assert.equal(receipt.event.sourceSha256, decision.sourceSha256);
    assert.equal(receipt.event.preconditionDigest, decision.preconditionDigest);

    const governanceAfterFirst = handle.store.readGovernance().length;
    const backupsAfterFirst = backupCount;
    const auditsAfterFirst = auditCount;
    const nowAfterFirst = nowCalls;
    const watermarkAfterFirst = handle.store.projectionFreshness();
    const projectionAfterFirst = projectionDigest(afterFirst);

    await handle.store.rebuildProjections();
    assert.equal(projectionDigest(service.getCard(created.memoryId)!), projectionAfterFirst);
    assert.equal(handle.store.ftsSearch("oldtag", 10).some((hit) => hit.itemId === created.memoryId), false);
    assert.equal(handle.store.ftsSearch("newtag", 10).some((hit) => hit.itemId === created.memoryId), true);

    const replay = await service.revisePolicyActivated(
      created.memoryId,
      "synthetic corrected durable statement",
      replacementEvidence,
      "owner",
      "synthetic corrected title",
      attrs,
      decision,
    );
    assert.equal(replay.status, "already");
    assert.equal((await handle.log.readAll()).length, kernelAfterFirst.length);
    assert.equal(handle.store.readGovernance().length, governanceAfterFirst);
    assert.equal(backupCount, backupsAfterFirst);
    assert.equal(auditCount, auditsAfterFirst);
    assert.equal(nowCalls, nowAfterFirst);
    assert.deepEqual(handle.store.projectionFreshness(), watermarkAfterFirst);
    assert.equal(projectionDigest(service.getCard(created.memoryId)!), projectionAfterFirst);

    const conflict = await service.revisePolicyActivated(
      created.memoryId,
      "synthetic different payload using the same decision id",
      replacementEvidence,
      "owner",
      "synthetic corrected title",
      attrs,
      decision,
    );
    assert.equal(conflict.status, "refused");
    assert.equal((await handle.log.readAll()).length, kernelAfterFirst.length);
    assert.equal(handle.store.readGovernance().length, governanceAfterFirst);
    assert.equal(backupCount, backupsAfterFirst);
    assert.equal(auditCount, auditsAfterFirst);
    assert.equal(nowCalls, nowAfterFirst);

    handle.log.close();
    handle = openMnemosyne(dbPath);
    let reopenBackups = 0;
    let reopenAudits = 0;
    let reopenNow = 0;
    service = new MnemosyneGovernanceService({
      store: handle.store,
      backup: (label) => {
        reopenBackups += 1;
        return { path: `${dbPath}.reopen-backup-${label}` };
      },
      audit: () => {
        reopenAudits += 1;
      },
      now: () => new Date(Date.UTC(2026, 7, 26, 2, 0, reopenNow++)),
    });
    await handle.store.rebuildProjections();
    const reopenedProjection = projectionDigest(service.getCard(created.memoryId)!);
    const reopenedKernelCount = (await handle.log.readAll()).length;
    const reopenedGovernanceCount = handle.store.readGovernance().length;
    const reopenedWatermark = handle.store.projectionFreshness();
    assert.equal(handle.store.ftsSearch("oldtag", 10).some((hit) => hit.itemId === created.memoryId), false);
    assert.equal(handle.store.ftsSearch("newtag", 10).some((hit) => hit.itemId === created.memoryId), true);

    const replayAfterReopen = await service.revisePolicyActivated(
      created.memoryId,
      "synthetic corrected durable statement",
      replacementEvidence,
      "owner",
      "synthetic corrected title",
      attrs,
      decision,
    );
    assert.equal(replayAfterReopen.status, "already");
    assert.equal((await handle.log.readAll()).length, reopenedKernelCount);
    assert.equal(handle.store.readGovernance().length, reopenedGovernanceCount);
    assert.equal(reopenBackups, 0);
    assert.equal(reopenAudits, 0);
    assert.equal(reopenNow, 0);
    assert.deepEqual(handle.store.projectionFreshness(), reopenedWatermark);
    assert.equal(projectionDigest(service.getCard(created.memoryId)!), reopenedProjection);

    const staleDecision: PolicyRevisionDecision = {
      decisionId: "synthetic-curation-decision-stale",
      sourceSha256: "b".repeat(64),
      preconditionDigest: preconditionDigest(before),
    };
    const stale = await service.revisePolicyActivated(
      created.memoryId,
      "synthetic stale correction",
      assistantEvidence(),
      "owner",
      "synthetic stale title",
      attrs,
      staleDecision,
    );
    assert.equal(stale.status, "refused");
    assert.equal((await handle.log.readAll()).length, reopenedKernelCount);
    assert.equal(handle.store.readGovernance().length, reopenedGovernanceCount);
    assert.equal(reopenBackups, 0);
    assert.equal(reopenAudits, 0);
    assert.equal(reopenNow, 0);

    const current = service.getCard(created.memoryId)!;
    const nextDecision: PolicyRevisionDecision = {
      decisionId: "synthetic-curation-decision-0002",
      sourceSha256: "c".repeat(64),
      preconditionDigest: preconditionDigest(current),
    };
    const changed = await service.revisePolicyActivated(
      created.memoryId,
      "synthetic second legitimate correction",
      assistantEvidence(),
      "companion",
      "synthetic second title",
      { ...attrs, importance: 2 },
      nextDecision,
    );
    assert.equal(changed.status, "ok");
    assert.equal((await handle.log.readAll()).length, reopenedKernelCount + 1);
    assert.ok(handle.store.readGovernance().length > reopenedGovernanceCount);

    handle.log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
