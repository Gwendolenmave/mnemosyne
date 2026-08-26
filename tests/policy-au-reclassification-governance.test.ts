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
} from "../core/services/mnemosyne-governance.js";
import { deriveProvenanceAxes } from "../core/domain/mnemosyne.js";

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

function projectedState(item: ReturnType<MnemosyneGovernanceService["getCard"]>) {
  assert.ok(item !== undefined);
  const axes = deriveProvenanceAxes(parseProvenance(item));
  return {
    body: item.body,
    title: item.title,
    tags: item.tags_text,
    scope: item.scope,
    auId: item.au_id,
    sensitivity: item.sensitivity,
    importance: item.importance,
    approval: item.approval_state,
    lifecycle: item.lifecycle_state,
    sourceBasis: item.source_basis,
    provenanceBasis: axes.evidenceBasis,
    editedBy: parseProvenance(item)?.edited_by ?? null,
  };
}

test("policy AU reclassification stays append-only and stable across rebuild and reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mnemo-public-au-governance-"));
  const dbPath = join(dir, "memory.db");
  try {
    let backupCount = 0;
    let auditCount = 0;
    let handle = openMnemosyne(dbPath);
    let governance = new MnemosyneGovernanceService({
      store: handle.store,
      backup: (label) => {
        backupCount += 1;
        return { path: `${dbPath}.backup-${label}-${backupCount}` };
      },
      audit: () => {
        auditCount += 1;
      },
      now: () => new Date("2026-08-26T04:00:00.000Z"),
    });

    const policyId = "synthetic-policy-au-v1";
    const policy = await governance.ensureOwnerPolicy({
      policyId,
      authority: "owner_global_policy",
      effectiveFrom: "2026-08-26T00:00:00.000Z",
      manualPerCardApprovalRequired: false,
      ownerCanViewEditRevoke: true,
      authorityRef: "synthetic-owner-ruling-au",
    });
    assert.equal(policy.status, "ok");

    const created = await governance.proposeUnderPolicy({
      body: "Synthetic durable observation that belongs to one reviewed realm.",
      title: "Synthetic realm memory",
      tags: ["synthetic", "realm"],
      scope: "relationship",
      sensitivity: "sensitive",
      importance: 3,
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

    const before = projectedState(governance.getCard(created.memoryId));
    assert.equal(before.scope, "relationship");
    assert.equal(before.auId, null);
    assert.equal(before.sourceBasis, "observed");
    assert.equal(before.provenanceBasis, "observed");

    const kernelBefore = (await handle.log.readAll()).length;
    const governanceBefore = handle.store.readGovernance().length;
    const backupsBefore = backupCount;
    const auditsBefore = auditCount;

    const first = await governance.reclassifyPolicyActivatedAu(
      created.memoryId,
      "synthetic-realm",
      "owner",
    );
    assert.equal(first.status, "ok");
    assert.equal((await handle.log.readAll()).length, kernelBefore);
    assert.equal(handle.store.readGovernance().length, governanceBefore + 2);
    assert.equal(backupCount, backupsBefore + 1);
    assert.equal(auditCount, auditsBefore + 1);

    const after = projectedState(governance.getCard(created.memoryId));
    assert.deepEqual(after, {
      ...before,
      scope: "au",
      auId: "synthetic-realm",
      editedBy: "owner",
    });

    const lastGovernance = handle.store.readGovernance().slice(-2);
    assert.deepEqual(
      lastGovernance.map((envelope) => envelope.event.type),
      ["attributes_set", "provenance_set"],
    );
    assert.equal(lastGovernance.every((envelope) => envelope.actor === "owner"), true);

    await handle.store.rebuildProjections();
    assert.deepEqual(projectedState(governance.getCard(created.memoryId)), after);

    const replayKernel = (await handle.log.readAll()).length;
    const replayGovernance = handle.store.readGovernance().length;
    const replayBackups = backupCount;
    const replayAudits = auditCount;
    const replay = await governance.reclassifyPolicyActivatedAu(
      created.memoryId,
      "synthetic-realm",
      "owner",
    );
    assert.equal(replay.status, "already");
    assert.equal((await handle.log.readAll()).length, replayKernel);
    assert.equal(handle.store.readGovernance().length, replayGovernance);
    assert.equal(backupCount, replayBackups);
    assert.equal(auditCount, replayAudits);

    handle.log.close();
    handle = openMnemosyne(dbPath);
    governance = new MnemosyneGovernanceService({
      store: handle.store,
      backup: (label) => ({ path: `${dbPath}.reopen-${label}` }),
      audit: () => undefined,
      now: () => new Date("2026-08-26T05:00:00.000Z"),
    });
    await handle.store.rebuildProjections();
    assert.deepEqual(projectedState(governance.getCard(created.memoryId)), after);

    const reopenKernel = (await handle.log.readAll()).length;
    const reopenGovernance = handle.store.readGovernance().length;
    const replayAfterReopen = await governance.reclassifyPolicyActivatedAu(
      created.memoryId,
      "synthetic-realm",
      "companion",
    );
    assert.equal(replayAfterReopen.status, "already");
    assert.equal((await handle.log.readAll()).length, reopenKernel);
    assert.equal(handle.store.readGovernance().length, reopenGovernance);

    handle.log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
