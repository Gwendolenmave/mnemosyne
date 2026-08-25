import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import type { MnemosyneEnvelope } from "../core/domain/mnemosyne.js";
import { MnemosyneGovernanceService } from "../core/services/mnemosyne-governance.js";

function freshDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mnemo-source-basis-rebuild-")), "mnemosyne.db");
}

test("policy activation source basis survives rebuild and reopen", async () => {
  const dbPath = freshDb();
  let handle = openMnemosyne(dbPath);
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: (label) => ({ path: `${dbPath}.backup-${label}` }),
    audit: () => {},
  });

  const proposed = await service.propose({
    body: "synthetic source-basis rebuild card",
    title: "synthetic source-basis card",
    tags: ["synthetic", "rebuild"],
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: { kind: "manual" },
    proposedBy: "owner",
  });
  assert.equal(proposed.status, "ok");
  if (proposed.status !== "ok") {
    handle.log.close();
    return;
  }

  const beforeActivation = handle.store.getItem(proposed.memoryId)!;
  assert.equal(beforeActivation.source_basis, "explicit");
  assert.equal(beforeActivation.approval_state, "candidate");

  const now = "2026-08-25T00:00:00.000Z";
  const policyId = "synthetic-observed-policy-v1";
  const activation: MnemosyneEnvelope[] = [
    {
      eventId: randomUUID(),
      occurredAt: now,
      actor: "system",
      event: {
        type: "owner_policy_set",
        policyId,
        authority: "owner_global_policy",
        effectiveFrom: now,
        manualPerCardApprovalRequired: false,
        ownerCanViewEditRevoke: true,
        authorityRef: `sha256:${"a".repeat(64)}`,
      },
    },
    {
      eventId: randomUUID(),
      occurredAt: now,
      actor: "system",
      event: {
        type: "policy_activated",
        memoryId: proposed.memoryId,
        policyId,
        activationBasis: "owner_policy",
        sourceBasis: "observed",
        generator: "synthetic-generator-v1",
      },
    },
  ];
  const append = handle.store.appendGovernance(activation);
  assert.deepEqual(append, { status: "appended", count: 2 });

  await handle.store.rebuildProjections();
  const afterFirstRebuild = handle.store.getItem(proposed.memoryId)!;
  assert.equal(afterFirstRebuild.source_basis, "observed");
  assert.equal(afterFirstRebuild.approval_state, "policy_activated");
  assert.equal(afterFirstRebuild.title, beforeActivation.title);
  assert.equal(afterFirstRebuild.tags_text, beforeActivation.tags_text);
  assert.equal(afterFirstRebuild.scope, beforeActivation.scope);
  assert.equal(afterFirstRebuild.au_id, beforeActivation.au_id);
  assert.equal(afterFirstRebuild.sensitivity, beforeActivation.sensitivity);
  assert.equal(afterFirstRebuild.importance, beforeActivation.importance);

  handle.log.close();
  handle = openMnemosyne(dbPath);
  const afterReopen = handle.store.getItem(proposed.memoryId)!;
  assert.equal(afterReopen.source_basis, "observed");
  assert.equal(afterReopen.approval_state, "policy_activated");

  await handle.store.rebuildProjections();
  const afterSecondRebuild = handle.store.getItem(proposed.memoryId)!;
  assert.equal(afterSecondRebuild.source_basis, "observed");
  assert.equal(afterSecondRebuild.approval_state, "policy_activated");
  assert.equal(afterSecondRebuild.body, afterFirstRebuild.body);
  assert.equal(afterSecondRebuild.title, afterFirstRebuild.title);
  assert.equal(afterSecondRebuild.tags_text, afterFirstRebuild.tags_text);
  assert.equal(afterSecondRebuild.scope, afterFirstRebuild.scope);
  assert.equal(afterSecondRebuild.au_id, afterFirstRebuild.au_id);
  assert.equal(afterSecondRebuild.sensitivity, afterFirstRebuild.sensitivity);
  assert.equal(afterSecondRebuild.importance, afterFirstRebuild.importance);

  handle.log.close();
});
