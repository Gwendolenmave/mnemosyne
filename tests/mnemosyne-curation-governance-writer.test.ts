import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryCreationEvidence } from "../core/domain/memory.js";
import type {
  CurationBatchReceipt,
  CurationWritePlan,
} from "../core/services/mnemosyne-curation-applicator.js";
import {
  MnemosyneCurationGovernanceWriter,
  type CurationBatchReceiptRecord,
  type CurationDecisionReceiptRecord,
  type MnemosyneCurationGovernanceAuthority,
} from "../core/services/mnemosyne-curation-governance-writer.js";
import type {
  GovernanceOutcome,
  GovernanceWriteReceipt,
  PolicyActivatedRepairAttributes,
} from "../core/services/mnemosyne-governance.js";
import type { PolicyRevisionDecision } from "../core/services/policy-revision-idempotence.js";

const EVIDENCE = {
  kind: "user_statement",
  source: {
    kind: "manual_entry",
    manualEntryId: "00000000-0000-4000-8000-000000000001",
  },
} as unknown as MemoryCreationEvidence;

interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
}

function writeReceipt(memoryId: string): GovernanceOutcome<GovernanceWriteReceipt> {
  return {
    status: "ok",
    memoryId,
    eventIds: ["synthetic-event"],
    committed: true,
    backup: { ok: true, detail: "/synthetic/backup" },
    retrySafe: true,
  };
}

class FakeAuthority implements MnemosyneCurationGovernanceAuthority {
  readonly calls: Call[] = [];
  readonly decisions = new Map<string, CurationDecisionReceiptRecord[]>();
  readonly batches = new Map<string, CurationBatchReceiptRecord[]>();
  persistDecisionReceipts = true;

  curationDecisionReceipts(decisionId: string): readonly CurationDecisionReceiptRecord[] {
    return this.decisions.get(decisionId) ?? [];
  }

  curationBatchReceipts(decisionSetId: string): readonly CurationBatchReceiptRecord[] {
    return this.batches.get(decisionSetId) ?? [];
  }

  private record(
    op: string,
    args: readonly unknown[],
    receipt: CurationDecisionReceiptRecord,
  ): GovernanceOutcome<GovernanceWriteReceipt> {
    this.calls.push({ op, args });
    if (this.persistDecisionReceipts) this.decisions.set(receipt.decisionId, [receipt]);
    return writeReceipt(receipt.memoryId);
  }

  async recordCurationKeep(
    receipt: CurationDecisionReceiptRecord,
    actor: "owner" | "companion",
  ) {
    return this.record("KEEP", [actor], receipt);
  }

  async recordCurationBatch(receipt: CurationBatchReceiptRecord) {
    this.calls.push({ op: "BATCH", args: [receipt.decisionSetId] });
    this.batches.set(receipt.decisionSetId, [receipt]);
    return writeReceipt(`decision-set:${receipt.decisionSetId}`);
  }

  async revisePolicyActivated(
    memoryId: string,
    newBody: string,
    evidence: MemoryCreationEvidence,
    by: "owner" | "companion",
    newTitle?: string,
    attrs?: PolicyActivatedRepairAttributes,
    decision?: PolicyRevisionDecision,
    curationReceipt?: CurationDecisionReceiptRecord,
  ) {
    assert.ok(curationReceipt);
    return this.record("REVISE", [memoryId, newBody, evidence, by, newTitle, attrs, decision], curationReceipt);
  }

  async reclassifyPolicyActivatedAu(
    memoryId: string,
    auId: string,
    by: "owner" | "companion",
    curationReceipt?: CurationDecisionReceiptRecord,
  ) {
    assert.ok(curationReceipt);
    return this.record("RECLASSIFY_AU", [memoryId, auId, by], curationReceipt);
  }

  async supersedePolicyActivated(
    sourceMemoryId: string,
    survivorMemoryId: string,
    by: "owner" | "companion",
    reason: string,
    curationReceipt?: CurationDecisionReceiptRecord,
  ) {
    assert.ok(curationReceipt);
    return this.record("SUPERSEDE", [sourceMemoryId, survivorMemoryId, by, reason], curationReceipt);
  }

  async mergePolicyActivated(
    sourceMemoryIds: readonly string[],
    survivorMemoryId: string,
    by: "owner" | "companion",
    reason: string,
    curationReceipt?: CurationDecisionReceiptRecord,
  ) {
    assert.ok(curationReceipt);
    return this.record("MERGE", [[...sourceMemoryIds], survivorMemoryId, by, reason], curationReceipt);
  }

  async revoke(
    memoryId: string,
    by: "owner" | "companion",
    reason: string,
    curationReceipt?: CurationDecisionReceiptRecord,
  ) {
    assert.ok(curationReceipt);
    return this.record("REVOKE", [memoryId, by, reason], curationReceipt);
  }

  async episodicOnlyPolicyActivated(
    memoryId: string,
    by: "owner" | "companion",
    reason: string,
    curationReceipt?: CurationDecisionReceiptRecord,
  ) {
    assert.ok(curationReceipt);
    return this.record("EPISODIC_ONLY", [memoryId, by, reason], curationReceipt);
  }
}

function plan(
  action: CurationWritePlan["action"],
  n: number,
  patch: Record<string, unknown> = {},
): CurationWritePlan {
  const hex = n.toString(16).padStart(2, "0");
  const decisionId = hex.repeat(32);
  const decisionSetId = "ab".repeat(32);
  const row = {
    schema: "delos.mnemosyne.card-decision.v1",
    card_id: `card-${n}`,
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
    reason: `synthetic ${action.toLowerCase()} decision`,
    reviewer: n % 2 === 0 ? "owner" : "companion",
    reviewed_at: "2026-08-20T00:00:00.000Z",
    ...patch,
  };
  return {
    decision: {
      decisionId,
      decisionSetId,
      row,
      baseFile: { path: `synthetic/${n}.jsonl`, sha256: "33".repeat(32), commitSha: "4".repeat(40) },
      amendmentFile: null,
      evidence: {
        originalCardSha256: "11".repeat(32),
        sourceTurnSha256: "22".repeat(32),
        evidence: EVIDENCE,
      },
    },
    action,
    preconditionDigest: "55".repeat(32),
    targetDigest: "66".repeat(32),
    actor: n % 2 === 0 ? "owner" : "companion",
  } as unknown as CurationWritePlan;
}

test("writer maps all seven curation actions only onto the governance authority", async () => {
  const authority = new FakeAuthority();
  const writer = new MnemosyneCurationGovernanceWriter(authority);

  const plans = [
    plan("KEEP", 1),
    plan("REVISE", 2, {
      replacement_title: "revised synthetic title",
      replacement_body: "revised synthetic body",
      replacement_scope: "project",
      replacement_tags: ["revised", "synthetic"],
      replacement_sensitivity: "sensitive",
      replacement_importance: 3,
    }),
    plan("RECLASSIFY_AU", 3, { replacement_au_id: "synthetic-au" }),
    plan("SUPERSEDE", 4, {
      consolidation: { survivor_card_id: "card-survivor-a", source_card_ids: ["card-4"] },
    }),
    plan("MERGE", 5, {
      consolidation: {
        survivor_card_id: "card-survivor-b",
        source_card_ids: ["card-5", "card-merge-peer"],
      },
    }),
    plan("REVOKE", 6),
    plan("EPISODIC_ONLY", 7),
  ];

  for (const candidate of plans) {
    const outcome = await writer.applyDecision(candidate);
    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.equal(outcome.receipt.memoryId, candidate.decision.row.card_id);
      assert.equal(outcome.receipt.decisionId, candidate.decision.decisionId);
      assert.equal(outcome.receipt.action, candidate.action);
      assert.equal(outcome.receipt.targetDigest, candidate.targetDigest);
      assert.equal(outcome.receipt.preconditionDigest, candidate.preconditionDigest);
    }
  }

  assert.deepEqual(
    authority.calls.map((call) => call.op),
    ["KEEP", "REVISE", "RECLASSIFY_AU", "SUPERSEDE", "MERGE", "REVOKE", "EPISODIC_ONLY"],
  );

  const revise = authority.calls[1]!;
  assert.equal(revise.args[0], "card-2");
  assert.equal(revise.args[1], "revised synthetic body");
  assert.deepEqual(revise.args[5], {
    tags: ["revised", "synthetic"],
    scope: "project",
    sensitivity: "sensitive",
    importance: 3,
  });
  const revisionDecision = revise.args[6] as PolicyRevisionDecision;
  assert.equal(revisionDecision.decisionId, plans[1]!.decision.decisionId);
  assert.equal(revisionDecision.sourceSha256, "22".repeat(32));
  assert.equal(revisionDecision.preconditionDigest, "55".repeat(32));
});

test("writer refuses malformed action payloads before asking governance to mutate", async () => {
  const authority = new FakeAuthority();
  const writer = new MnemosyneCurationGovernanceWriter(authority);

  assert.equal((await writer.applyDecision(plan("REVISE", 8))).status, "refused");
  assert.equal((await writer.applyDecision(plan("RECLASSIFY_AU", 9))).status, "refused");
  assert.equal(
    (
      await writer.applyDecision(
        plan("SUPERSEDE", 10, {
          consolidation: { survivor_card_id: "survivor", source_card_ids: ["a", "b"] },
        }),
      )
    ).status,
    "refused",
  );
  assert.equal(
    (
      await writer.applyDecision(
        plan("MERGE", 11, {
          consolidation: { survivor_card_id: "survivor", source_card_ids: [] },
        }),
      )
    ).status,
    "refused",
  );
  assert.equal(authority.calls.length, 0);
});

test("writer does not report success unless governance exposes the durable receipt", async () => {
  const authority = new FakeAuthority();
  authority.persistDecisionReceipts = false;
  const writer = new MnemosyneCurationGovernanceWriter(authority);

  const outcome = await writer.applyDecision(plan("KEEP", 12));
  assert.equal(outcome.status, "refused");
  if (outcome.status === "refused") assert.match(outcome.message, /without a durable curation receipt/u);
  assert.equal(authority.calls.length, 1);
});

test("batch completion delegates only metadata and round-trips the durable batch receipt", async () => {
  const authority = new FakeAuthority();
  const writer = new MnemosyneCurationGovernanceWriter(authority);
  const receipt: CurationBatchReceipt = {
    decisionSetId: "ab".repeat(32),
    decisionSetSha256: "cd".repeat(32),
    decisionIds: ["01".repeat(32), "02".repeat(32)],
  };

  const outcome = await writer.completeBatch(receipt);
  assert.equal(outcome.status, "ok");
  assert.deepEqual(writer.readBatchReceipt(receipt.decisionSetId), receipt);
  assert.equal(authority.calls.at(-1)?.op, "BATCH");
});

test("duplicate durable receipt history is surfaced as a mismatch sentinel, never silently chosen", () => {
  const authority = new FakeAuthority();
  const writer = new MnemosyneCurationGovernanceWriter(authority);
  const candidate = plan("KEEP", 13);
  const record: CurationDecisionReceiptRecord = {
    memoryId: candidate.decision.row.card_id,
    decisionId: candidate.decision.decisionId,
    decisionSetId: candidate.decision.decisionSetId,
    action: candidate.action,
    targetDigest: candidate.targetDigest,
    preconditionDigest: candidate.preconditionDigest,
  };
  authority.decisions.set(record.decisionId, [record, { ...record }]);

  const receipt = writer.readDecisionReceipt(record.decisionId);
  assert.ok(receipt);
  assert.equal(receipt.decisionSetId, "duplicate-durable-curation-receipts");
});
