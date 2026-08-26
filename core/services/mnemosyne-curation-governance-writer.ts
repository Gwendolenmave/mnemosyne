import type { MemoryCreationEvidence } from "../domain/memory.js";
import type {
  CurationBatchRecordedEvent,
  CurationDecisionRecordedEvent,
} from "../domain/mnemosyne.js";
import type {
  CurationBatchReceipt,
  CurationDecisionReceipt,
  CurationWritePlan,
  CurationWriter,
  CurationWriterOutcome,
} from "./mnemosyne-curation-applicator.js";
import type {
  GovernanceOutcome,
  GovernanceWriteReceipt,
  PolicyActivatedRepairAttributes,
} from "./mnemosyne-governance.js";
import type { PolicyRevisionDecision } from "./policy-revision-idempotence.js";

/** Metadata-only identity copied from the applicator's frozen write plan. */
export type CurationDecisionReceiptRecord = Omit<CurationDecisionRecordedEvent, "type">;

/** Metadata-only completion identity for one reviewed decision set. */
export interface CurationBatchReceiptRecord {
  readonly decisionSetId: CurationBatchRecordedEvent["decisionSetId"];
  readonly decisionSetSha256: CurationBatchRecordedEvent["decisionSetSha256"];
  readonly decisionIds: readonly string[];
}

/**
 * The narrow governance surface required by the formal curation adapter.
 *
 * It deliberately exposes no store or append primitive. The concrete
 * MnemosyneGovernanceService is the intended implementation; the next bounded
 * integration slice makes it satisfy this surface while keeping every semantic
 * mutation and replay receipt behind that one governance writer.
 */
export interface MnemosyneCurationGovernanceAuthority {
  curationDecisionReceipts(decisionId: string): readonly CurationDecisionReceiptRecord[];
  curationBatchReceipts(decisionSetId: string): readonly CurationBatchReceiptRecord[];

  recordCurationKeep(
    receipt: CurationDecisionReceiptRecord,
    actor: "owner" | "companion",
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>>;

  recordCurationBatch(
    receipt: CurationBatchReceiptRecord,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>>;

  revisePolicyActivated(
    memoryId: string,
    newBody: string,
    evidence: MemoryCreationEvidence,
    by: "owner" | "companion",
    newTitle?: string,
    attrs?: PolicyActivatedRepairAttributes,
    decision?: PolicyRevisionDecision,
    curationReceipt?: CurationDecisionReceiptRecord,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>>;

  reclassifyPolicyActivatedAu(
    memoryId: string,
    auId: string,
    by: "owner" | "companion",
    curationReceipt?: CurationDecisionReceiptRecord,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>>;

  supersedePolicyActivated(
    sourceMemoryId: string,
    survivorMemoryId: string,
    by: "owner" | "companion",
    reason: string,
    curationReceipt?: CurationDecisionReceiptRecord,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>>;

  mergePolicyActivated(
    sourceMemoryIds: readonly string[],
    survivorMemoryId: string,
    by: "owner" | "companion",
    reason: string,
    curationReceipt?: CurationDecisionReceiptRecord,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>>;

  revoke(
    memoryId: string,
    by: "owner" | "companion",
    reason: string,
    curationReceipt?: CurationDecisionReceiptRecord,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>>;

  episodicOnlyPolicyActivated(
    memoryId: string,
    by: "owner" | "companion",
    reason: string,
    curationReceipt?: CurationDecisionReceiptRecord,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>>;
}

function durableDecisionReceipt(record: CurationDecisionReceiptRecord): CurationDecisionReceipt {
  return {
    memoryId: record.memoryId,
    decisionId: record.decisionId,
    decisionSetId: record.decisionSetId,
    action: record.action,
    targetDigest: record.targetDigest,
    preconditionDigest: record.preconditionDigest,
  };
}

function refusedMessage(
  outcome: Extract<GovernanceOutcome<GovernanceWriteReceipt>, { status: "refused" }>,
): string {
  return outcome.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

/**
 * Formal curation adapter. It owns no memory store and no mutation primitive;
 * every action delegates to the supplied governance authority, then reads the
 * immutable receipt back before reporting success.
 */
export class MnemosyneCurationGovernanceWriter implements CurationWriter {
  constructor(private readonly governance: MnemosyneCurationGovernanceAuthority) {}

  readDecisionReceipt(decisionId: string): CurationDecisionReceipt | undefined {
    const records = this.governance.curationDecisionReceipts(decisionId);
    if (records.length === 0) return undefined;
    if (records.length > 1) {
      // Return a typed mismatch sentinel so whole-set preflight fails closed
      // instead of silently choosing one receipt from contradictory history.
      return {
        ...durableDecisionReceipt(records[0]!),
        decisionSetId: "duplicate-durable-curation-receipts",
      };
    }
    return durableDecisionReceipt(records[0]!);
  }

  readBatchReceipt(decisionSetId: string): CurationBatchReceipt | undefined {
    const records = this.governance.curationBatchReceipts(decisionSetId);
    if (records.length === 0) return undefined;
    if (records.length > 1) {
      return {
        decisionSetId,
        decisionSetSha256: "duplicate-durable-curation-batch-receipts",
        decisionIds: [],
      };
    }
    const record = records[0]!;
    return {
      decisionSetId: record.decisionSetId,
      decisionSetSha256: record.decisionSetSha256,
      decisionIds: [...record.decisionIds],
    };
  }

  async applyDecision(plan: CurationWritePlan): Promise<CurationWriterOutcome> {
    const row = plan.decision.row;
    const durable: CurationDecisionReceiptRecord = {
      memoryId: row.card_id,
      decisionId: plan.decision.decisionId,
      decisionSetId: plan.decision.decisionSetId,
      action: plan.action,
      targetDigest: plan.targetDigest,
      preconditionDigest: plan.preconditionDigest,
    };

    let outcome: GovernanceOutcome<GovernanceWriteReceipt>;
    switch (plan.action) {
      case "KEEP":
        outcome = await this.governance.recordCurationKeep(durable, plan.actor);
        break;
      case "REVISE": {
        if (row.replacement_body === null) {
          return { status: "refused", message: "REVISE plan has no replacement body" };
        }
        const attrs: PolicyActivatedRepairAttributes = {
          ...(row.replacement_tags !== undefined && row.replacement_tags !== null
            ? { tags: [...row.replacement_tags] }
            : {}),
          ...(row.replacement_scope !== null ? { scope: row.replacement_scope } : {}),
          ...(row.replacement_sensitivity !== undefined && row.replacement_sensitivity !== null
            ? { sensitivity: row.replacement_sensitivity }
            : {}),
          ...(row.replacement_importance !== undefined && row.replacement_importance !== null
            ? { importance: row.replacement_importance }
            : {}),
        };
        outcome = await this.governance.revisePolicyActivated(
          row.card_id,
          row.replacement_body,
          plan.decision.evidence.evidence,
          plan.actor,
          row.replacement_title ?? undefined,
          Object.keys(attrs).length === 0 ? undefined : attrs,
          {
            decisionId: plan.decision.decisionId,
            sourceSha256: plan.decision.evidence.sourceTurnSha256,
            preconditionDigest: plan.preconditionDigest,
          },
          durable,
        );
        break;
      }
      case "RECLASSIFY_AU":
        if (row.replacement_au_id === null) {
          return { status: "refused", message: "RECLASSIFY_AU plan has no exact AU id" };
        }
        outcome = await this.governance.reclassifyPolicyActivatedAu(
          row.card_id,
          row.replacement_au_id,
          plan.actor,
          durable,
        );
        break;
      case "SUPERSEDE": {
        const consolidation = row.consolidation;
        if (consolidation === undefined || consolidation.source_card_ids.length !== 1) {
          return { status: "refused", message: "SUPERSEDE plan lacks one explicit source/survivor direction" };
        }
        outcome = await this.governance.supersedePolicyActivated(
          consolidation.source_card_ids[0]!,
          consolidation.survivor_card_id,
          plan.actor,
          row.reason,
          durable,
        );
        break;
      }
      case "MERGE": {
        const consolidation = row.consolidation;
        if (consolidation === undefined || consolidation.source_card_ids.length === 0) {
          return { status: "refused", message: "MERGE plan lacks explicit source/survivor direction" };
        }
        outcome = await this.governance.mergePolicyActivated(
          consolidation.source_card_ids,
          consolidation.survivor_card_id,
          plan.actor,
          row.reason,
          durable,
        );
        break;
      }
      case "REVOKE":
        outcome = await this.governance.revoke(row.card_id, plan.actor, row.reason, durable);
        break;
      case "EPISODIC_ONLY":
        outcome = await this.governance.episodicOnlyPolicyActivated(
          row.card_id,
          plan.actor,
          row.reason,
          durable,
        );
        break;
    }

    if (outcome.status === "refused") {
      return { status: "refused", message: refusedMessage(outcome) };
    }
    const receipt = this.readDecisionReceipt(plan.decision.decisionId);
    if (receipt === undefined) {
      return {
        status: "refused",
        message: `governance operation returned ${outcome.status} without a durable curation receipt`,
      };
    }
    return { status: outcome.status === "already" ? "already" : "ok", receipt };
  }

  async completeBatch(
    receipt: CurationBatchReceipt,
  ): Promise<{ status: "ok" | "already" } | { status: "refused"; message: string }> {
    const durable: CurationBatchReceiptRecord = {
      decisionSetId: receipt.decisionSetId,
      decisionSetSha256: receipt.decisionSetSha256,
      decisionIds: [...receipt.decisionIds],
    };
    const outcome = await this.governance.recordCurationBatch(durable);
    if (outcome.status === "refused") {
      return { status: "refused", message: refusedMessage(outcome) };
    }
    return { status: outcome.status };
  }
}
