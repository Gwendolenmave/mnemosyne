import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import { GovernedCompanionProposalSink } from "../core/services/companion-proposal-sink.js";
import {
  MnemosyneGovernanceService,
  parseProvenance,
} from "../core/services/mnemosyne-governance.js";
import { reconcilePendingCards } from "../scripts/d0-recovery.js";
import type { TurnSnapshot } from "../adapters/transcripts/local/transcript-query.js";

const POLICY_ID = "synthetic-reconcile-policy-v1";
const CONVERSATION_ID = "bbbb2222-0000-4000-8000-000000000777";
const TURN_ID = "aaaa1111-0000-4000-8000-000000000777";
const MESSAGE_ID = "cccc3333-0000-4000-8000-000000000777";

/**
 * M1 regression: once a pending card has canonical explicit creation evidence,
 * the historical reconciliation lane may confirm that same basis but may not
 * silently relabel it. This also proves the existing-card activation path can
 * consume a verified served-model identity without claiming human confirmation.
 */
test("D0 reconciliation activates a matching canonical explicit pending card", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "mnemo-reconcile-basis-")), "memory.db");
  const handle = openMnemosyne(dbPath);
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: (label) => ({ path: `${dbPath}.${label}.backup` }),
    audit: () => undefined,
  });
  const registered = await service.ensureOwnerPolicy({
    policyId: POLICY_ID,
    authority: "owner_global_policy",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    manualPerCardApprovalRequired: false,
    ownerCanViewEditRevoke: true,
    authorityRef: `sha256:${"d".repeat(64)}`,
  });
  assert.notEqual(registered.status, "refused");

  const proposed = await service.propose({
    body: "synthetic canonical explicit reconciliation card",
    title: "synthetic reconciliation",
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: {
      kind: "transcript",
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      messageId: MESSAGE_ID,
    },
    proposedBy: "companion",
    executionActor: "system",
    provenance: { authored_by: "companion", proposed_by: "companion", source_basis: "explicit" },
  });
  assert.equal(proposed.status, "ok");
  if (proposed.status !== "ok") return;

  const before = service.getCard(proposed.memoryId)!;
  assert.equal(before.source_basis, "explicit");
  assert.equal(parseProvenance(before)?.source_basis, "explicit");
  assert.equal(parseProvenance(before)?.authored_by, "companion");

  const snapshot: TurnSnapshot = {
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    userMessageId: MESSAGE_ID,
    userText: "synthetic explicit source statement",
    assistantText: "synthetic assistant response",
    variantSha256: "v".repeat(64),
    selectedMemoryIds: [],
  };
  const outcomes = await reconcilePendingCards({
    cards: [
      {
        id: before.id,
        body: before.body,
        title: before.title,
        sensitivity: before.sensitivity,
        scope: before.scope,
        approval_state: before.approval_state,
        lifecycle_state: before.lifecycle_state,
      },
    ],
    sourcePointer: (memoryId) => service.sourcePointer(memoryId),
    snapshotByTurn: (turnId) => (turnId === TURN_ID ? snapshot : null),
    sink: new GovernedCompanionProposalSink(service),
    provider: {
      generate: async () => ({
        ok: true,
        text: '{"basis":"explicit"}',
        servedModel: "synthetic-model",
      }),
    },
    persona: { staticPrefix: "SYNTHETIC-PERSONA-CORE" },
    policyId: POLICY_ID,
    audit: () => undefined,
    now: () => new Date("2026-08-26T00:00:00.000Z"),
  });

  assert.deepEqual(outcomes, [
    { memoryId: proposed.memoryId, outcome: "policy_activated", basis: "explicit" },
  ]);
  const after = service.getCard(proposed.memoryId)!;
  assert.equal(after.approval_state, "policy_activated");
  assert.equal(after.confirmed_by, null);
  assert.equal(after.source_basis, "explicit");
  handle.log.close();
});
