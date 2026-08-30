import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import type { MemoryCreationEvidence } from "../core/domain/memory.js";
import { asManualEntryId } from "../core/domain/ids.js";
import { encodeDurableSemanticCenterMergeReason } from "../core/policies/durable-semantic-center.js";
import {
  curationRevisionPreconditionDigest,
  type CurationWritePlan,
} from "../core/services/mnemosyne-curation-applicator.js";
import { MnemosyneCurationGovernanceWriter } from "../core/services/mnemosyne-curation-governance-writer.js";
import { MnemosyneGovernanceService } from "../core/services/mnemosyne-governance.js";

const DECISION_SET_ID = "ab".repeat(32);
const DECISION_SET_SHA = "cd".repeat(32);

function evidence(n: number): MemoryCreationEvidence {
  return {
    kind: "user_statement",
    source: {
      kind: "manual_entry",
      manualEntryId: asManualEntryId(`00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`),
    },
  };
}

function makeService(
  dbPath: string,
  handle: ReturnType<typeof openMnemosyne>,
  counters: { backups: number; audits: number; now: number },
): MnemosyneGovernanceService {
  return new MnemosyneGovernanceService({
    store: handle.store,
    backup: (label) => {
      counters.backups += 1;
      return { path: `${dbPath}.synthetic-${label}-${counters.backups}` };
    },
    audit: () => {
      counters.audits += 1;
    },
    now: () => new Date(Date.UTC(2026, 7, 26, 3, 0, counters.now++)),
  });
}

async function createPolicyCard(
  service: MnemosyneGovernanceService,
  policyId: string,
  label: string,
  n: number,
): Promise<string> {
  const result = await service.proposeUnderPolicy({
    body: `Synthetic ${label} memory body.`,
    title: `Synthetic ${label} title`,
    tags: ["synthetic", label],
    scope: "relationship",
    sensitivity: "normal",
    importance: 2,
    evidence: { kind: "memory_creation", evidence: evidence(n) },
    proposedBy: "companion",
    executionActor: "system",
    provenance: { discovered_by: "companion", proposed_by: "companion" },
    activation: {
      policyId,
      sourceBasis: "explicit",
      generator: "synthetic-memory-governor-v1",
    },
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("synthetic policy card creation failed");
  return result.memoryId;
}

function plan(
  action: CurationWritePlan["action"],
  n: number,
  cardId: string,
  sourceEvidence: MemoryCreationEvidence,
  preconditionDigest: string,
  patch: Record<string, unknown> = {},
): CurationWritePlan {
  const decisionId = n.toString(16).padStart(2, "0").repeat(32);
  return {
    decision: {
      decisionId,
      decisionSetId: DECISION_SET_ID,
      row: {
        schema: "delos.mnemosyne.card-decision.v1",
        card_id: cardId,
        original_card_sha256: "11".repeat(32),
        source_turn_sha256: "22".repeat(32),
        action,
        replacement_title: null,
        replacement_body: null,
        replacement_scope: null,
        replacement_au_id: null,
        replacement_tags: null,
        replacement_sensitivity: null,
        replacement_importance: null,
        supersedes_card_ids: [],
        merge_card_ids: [],
        reason:
          action === "MERGE"
            ? encodeDurableSemanticCenterMergeReason(
                "duplicate",
                "synthetic merge participants are duplicate statements of one durable fact",
              )
            : `Synthetic ${action.toLowerCase()} curation decision.`,
        reviewer: n % 2 === 0 ? "owner" : "companion",
        reviewed_at: "2026-08-26T03:00:00.000Z",
        ...patch,
      },
      baseFile: {
        path: `synthetic/decision-${n}.jsonl`,
        sha256: "33".repeat(32),
        commitSha: "4".repeat(40),
      },
      amendmentFile: null,
      evidence: {
        originalCardSha256: "11".repeat(32),
        sourceTurnSha256: "22".repeat(32),
        evidence: sourceEvidence,
      },
    },
    action,
    preconditionDigest,
    targetDigest: n.toString(16).padStart(2, "0").repeat(32),
    actor: n % 2 === 0 ? "owner" : "companion",
  } as unknown as CurationWritePlan;
}

function assertTerminal(
  service: MnemosyneGovernanceService,
  memoryId: string,
  lifecycle: "revoked" | "superseded",
): void {
  const item = service.getCard(memoryId);
  assert.ok(item);
  assert.equal(item.lifecycle_state, lifecycle);
  if (lifecycle === "revoked") assert.equal(item.retrieval, "disabled");
}

test("formal curation semantic effects and receipts survive rebuild/reopen and exact replay is zero-write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mnemo-public-curation-governance-"));
  const dbPath = join(dir, "memory.db");
  try {
    let handle = openMnemosyne(dbPath);
    const counters = { backups: 0, audits: 0, now: 0 };
    let service = makeService(dbPath, handle, counters);
    let writer = new MnemosyneCurationGovernanceWriter(service);
    const policyId = "synthetic-curation-policy-v1";

    assert.equal(
      (
        await service.ensureOwnerPolicy({
          policyId,
          authority: "owner_global_policy",
          effectiveFrom: "2026-08-26T00:00:00.000Z",
          manualPerCardApprovalRequired: false,
          ownerCanViewEditRevoke: true,
          authorityRef: "synthetic-curation-authority",
        })
      ).status,
      "ok",
    );

    const keepId = await createPolicyCard(service, policyId, "keep", 1);
    const reviseId = await createPolicyCard(service, policyId, "revise", 2);
    const reclassifyId = await createPolicyCard(service, policyId, "reclassify", 3);
    const supersedeId = await createPolicyCard(service, policyId, "supersede-source", 4);
    const supersedeSurvivorId = await createPolicyCard(service, policyId, "supersede-survivor", 5);
    const mergeAId = await createPolicyCard(service, policyId, "merge-a", 6);
    const mergeBId = await createPolicyCard(service, policyId, "merge-b", 7);
    const mergeSurvivorId = await createPolicyCard(service, policyId, "merge-survivor", 8);
    const revokeId = await createPolicyCard(service, policyId, "revoke", 9);
    const episodicId = await createPolicyCard(service, policyId, "episodic", 10);

    const reviseBefore = service.getCard(reviseId)!;
    const revisePrecondition = curationRevisionPreconditionDigest(reviseBefore);
    assert.ok(revisePrecondition);

    const plans: CurationWritePlan[] = [
      plan("KEEP", 11, keepId, evidence(1), "51".repeat(32)),
      plan("REVISE", 12, reviseId, evidence(12), revisePrecondition!, {
        replacement_title: "Synthetic revised title",
        replacement_body: "Synthetic revised memory body.",
        replacement_scope: "project",
        replacement_tags: ["synthetic", "revised"],
        replacement_sensitivity: "sensitive",
        replacement_importance: 3,
      }),
      plan("RECLASSIFY_AU", 13, reclassifyId, evidence(3), "53".repeat(32), {
        replacement_au_id: "synthetic-au",
      }),
      plan("SUPERSEDE", 14, supersedeId, evidence(4), "54".repeat(32), {
        consolidation: {
          survivor_card_id: supersedeSurvivorId,
          source_card_ids: [supersedeId],
        },
      }),
      plan("MERGE", 15, mergeAId, evidence(6), "55".repeat(32), {
        consolidation: {
          survivor_card_id: mergeSurvivorId,
          source_card_ids: [mergeAId, mergeBId],
        },
      }),
      plan("REVOKE", 16, revokeId, evidence(9), "56".repeat(32)),
      plan("EPISODIC_ONLY", 17, episodicId, evidence(10), "57".repeat(32)),
    ];

    for (const candidate of plans) {
      const result = await writer.applyDecision(candidate);
      assert.equal(result.status, "ok", `${candidate.action} should commit through governance`);
    }
    const batch = await writer.completeBatch({
      decisionSetId: DECISION_SET_ID,
      decisionSetSha256: DECISION_SET_SHA,
      decisionIds: plans.map((candidate) => candidate.decision.decisionId).sort(),
    });
    assert.equal(batch.status, "ok");

    assert.equal(service.getCard(keepId)?.lifecycle_state, "active");
    const revised = service.getCard(reviseId)!;
    assert.equal(revised.body, "Synthetic revised memory body.");
    assert.equal(revised.title, "Synthetic revised title");
    assert.equal(revised.tags_text, "synthetic revised");
    assert.equal(revised.scope, "project");
    assert.equal(revised.sensitivity, "sensitive");
    assert.equal(revised.importance, 3);
    assert.equal(revised.approval_state, "policy_activated");
    const reclassified = service.getCard(reclassifyId)!;
    assert.equal(reclassified.scope, "au");
    assert.equal(reclassified.au_id, "synthetic-au");
    assertTerminal(service, supersedeId, "superseded");
    assert.equal(service.getCard(supersedeId)?.supersedes, supersedeSurvivorId);
    assertTerminal(service, mergeAId, "superseded");
    assertTerminal(service, mergeBId, "superseded");
    assert.equal(service.getCard(mergeAId)?.supersedes, mergeSurvivorId);
    assert.equal(service.getCard(mergeBId)?.supersedes, mergeSurvivorId);
    assertTerminal(service, revokeId, "revoked");
    assertTerminal(service, episodicId, "revoked");
    for (const candidate of plans) {
      const receipts = service.curationDecisionReceipts(candidate.decision.decisionId);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.action, candidate.action);
    }
    assert.equal(service.curationBatchReceipts(DECISION_SET_ID).length, 1);

    const projectionSnapshot = plans.map((candidate) => service.getCard(candidate.decision.row.card_id));
    await handle.store.rebuildProjections();
    assert.deepEqual(
      plans.map((candidate) => service.getCard(candidate.decision.row.card_id)),
      projectionSnapshot,
    );

    handle.log.close();
    handle = openMnemosyne(dbPath);
    const replayCounters = { backups: 0, audits: 0, now: 0 };
    service = makeService(dbPath, handle, replayCounters);
    writer = new MnemosyneCurationGovernanceWriter(service);
    await handle.store.rebuildProjections();

    const kernelBeforeReplay = (await handle.log.readAll()).length;
    const governanceBeforeReplay = handle.store.readGovernance().length;
    const watermarkBeforeReplay = handle.store.projectionFreshness();
    for (const candidate of plans) {
      const replay = await writer.applyDecision(candidate);
      assert.equal(replay.status, "already", `${candidate.action} exact replay should be zero-write`);
    }
    const batchReplay = await writer.completeBatch({
      decisionSetId: DECISION_SET_ID,
      decisionSetSha256: DECISION_SET_SHA,
      decisionIds: plans.map((candidate) => candidate.decision.decisionId).sort(),
    });
    assert.equal(batchReplay.status, "already");
    assert.equal((await handle.log.readAll()).length, kernelBeforeReplay);
    assert.equal(handle.store.readGovernance().length, governanceBeforeReplay);
    assert.equal(replayCounters.backups, 0);
    assert.equal(replayCounters.audits, 0);
    assert.equal(replayCounters.now, 0);
    assert.deepEqual(handle.store.projectionFreshness(), watermarkBeforeReplay);

    const conflictingKeep: CurationWritePlan = {
      ...plans[0]!,
      targetDigest: "ff".repeat(32),
    };
    const conflict = await writer.applyDecision(conflictingKeep);
    assert.equal(conflict.status, "refused");
    assert.equal((await handle.log.readAll()).length, kernelBeforeReplay);
    assert.equal(handle.store.readGovernance().length, governanceBeforeReplay);

    handle.log.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
