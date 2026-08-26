import type { MemoryCreationEvidence } from "../domain/memory.js";
import { deriveProvenanceAxes } from "../domain/mnemosyne.js";
import { parseProvenance, type GovernanceItemView } from "./mnemosyne-governance.js";
import { policyRevisionPreconditionDigest } from "./policy-revision-idempotence.js";
import {
  preflightCurationDecisionSet,
  sha256Canonical,
  type CurationAction,
  type CurationDecisionSetBundle,
  type EffectiveCurationDecision,
} from "./mnemosyne-curation-contract.js";

const AU_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export interface CurationStateReader {
  getItem(id: string): GovernanceItemView | undefined;
}

export interface CurationApplyIssue {
  readonly path: string;
  readonly message: string;
}

export interface CurationWritePlan {
  readonly decision: EffectiveCurationDecision;
  readonly action: Exclude<CurationAction, "NEEDS_OWNER">;
  readonly preconditionDigest: string;
  readonly targetDigest: string;
  readonly actor: "owner" | "companion";
}

export type CurationApplicationPreflight =
  | {
      readonly ok: true;
      readonly decisionSetId: string;
      readonly decisionSetSha256: string;
      readonly plans: readonly CurationWritePlan[];
    }
  | { readonly ok: false; readonly issues: readonly CurationApplyIssue[] };

function evidenceBasis(evidence: MemoryCreationEvidence): "explicit" | "observed" | null {
  if (evidence.kind === "user_statement") return "explicit";
  if (evidence.kind === "assistant_dialogue") return "observed";
  return null;
}

function tags(item: GovernanceItemView): string[] {
  return item.tags_text.split(" ").filter((tag) => tag.length > 0);
}

function actorFor(
  decision: EffectiveCurationDecision,
  issues: CurationApplyIssue[],
): "owner" | "companion" | null {
  if (decision.row.reviewer === "owner" || decision.row.reviewer === "companion") {
    return decision.row.reviewer;
  }
  issues.push({
    path: `decisions.${decision.row.card_id}.reviewer`,
    message: "applicable curation decisions require reviewer owner|companion",
  });
  return null;
}

function validatePolicyActivatedCard(
  item: GovernanceItemView,
  path: string,
  issues: CurationApplyIssue[],
): void {
  if (item.lifecycle_state !== "active") {
    issues.push({ path, message: `card must be active before first application; found ${item.lifecycle_state}` });
  }
  if (item.approval_state !== "policy_activated") {
    issues.push({ path, message: `card must be policy_activated; found ${item.approval_state}` });
  }
  if (item.confirmed_by !== null) {
    issues.push({ path, message: "policy-card curation refuses individually confirmed cards" });
  }
  const basis = item.source_basis;
  if (basis !== "explicit" && basis !== "observed") {
    issues.push({ path: `${path}.sourceBasis`, message: "policy card must preserve explicit|observed evidence basis" });
    return;
  }
  const provenanceBasis = deriveProvenanceAxes(parseProvenance(item)).evidenceBasis;
  if (provenanceBasis !== null && provenanceBasis !== basis) {
    issues.push({
      path: `${path}.provenance.source_basis`,
      message: "projected source basis conflicts with provenance",
    });
  }
}

function validateReviewedBasis(
  decision: EffectiveCurationDecision,
  item: GovernanceItemView,
  issues: CurationApplyIssue[],
): void {
  const basis = evidenceBasis(decision.evidence.evidence);
  if (basis === null) {
    issues.push({
      path: `decisions.${decision.row.card_id}.evidence`,
      message: "frozen curation evidence must resolve to explicit|observed",
    });
    return;
  }
  if (item.source_basis !== basis) {
    issues.push({
      path: `decisions.${decision.row.card_id}.sourceBasis`,
      message: `frozen evidence basis ${basis} conflicts with projected source basis ${item.source_basis ?? "null"}`,
    });
  }
}

function validateSurvivor(
  item: GovernanceItemView,
  path: string,
  issues: CurationApplyIssue[],
): void {
  if (item.lifecycle_state !== "active") {
    issues.push({ path, message: "consolidation survivor must be active" });
  }
  if (item.retrieval === "disabled") {
    issues.push({ path: `${path}.retrieval`, message: "consolidation survivor must remain retrieval-authorised" });
  }
  if (item.approval_state !== "policy_activated" && item.approval_state !== "confirmed") {
    issues.push({
      path,
      message: "consolidation survivor must already be policy_activated|confirmed",
    });
    return;
  }
  if (item.approval_state === "policy_activated") {
    validatePolicyActivatedCard(item, path, issues);
  }
}

function validateConsolidationState(
  decision: EffectiveCurationDecision,
  reader: CurationStateReader,
  issues: CurationApplyIssue[],
): void {
  const direction = decision.row.consolidation;
  const path = `decisions.${decision.row.card_id}.consolidation`;
  if (direction === undefined) {
    issues.push({ path, message: "explicit consolidation direction required" });
    return;
  }

  const survivor = reader.getItem(direction.survivor_card_id);
  if (survivor === undefined) {
    issues.push({ path: `${path}.survivor_card_id`, message: "survivor card is missing" });
  } else {
    validateSurvivor(survivor, `${path}.survivor`, issues);
  }

  for (const [index, sourceId] of direction.source_card_ids.entries()) {
    const source = reader.getItem(sourceId);
    if (source === undefined) {
      issues.push({ path: `${path}.source_card_ids[${index}]`, message: "source card is missing" });
      continue;
    }
    validatePolicyActivatedCard(source, `${path}.sources.${sourceId}`, issues);
  }
}

/** Stable projection-state digest used as the stale-precondition fence for non-REVISE actions. */
export function curationItemPreconditionDigest(item: GovernanceItemView): string {
  return sha256Canonical({
    schema: "delos.mnemosyne.curation-item-precondition.v1",
    id: item.id,
    title: item.title,
    body: item.body,
    scope: item.scope,
    auId: item.au_id,
    sensitivity: item.sensitivity,
    importance: item.importance,
    approvalState: item.approval_state,
    lifecycleState: item.lifecycle_state,
    confirmedBy: item.confirmed_by,
    retrieval: item.retrieval,
    supersededBy: item.supersedes ?? null,
    sourceBasis: item.source_basis ?? null,
    tags: tags(item),
    provenance: item.provenance,
  });
}

/**
 * REVISE must use the same frozen-state digest already enforced by the durable
 * policy-revision path. Returning null means the projected card cannot be
 * represented safely by that contract.
 */
export function curationRevisionPreconditionDigest(item: GovernanceItemView): string | null {
  const scope =
    item.scope === "global" || item.scope === "relationship" || item.scope === "project" || item.scope === "au"
      ? item.scope
      : null;
  const sensitivity =
    item.sensitivity === "normal" || item.sensitivity === "sensitive" || item.sensitivity === "intimate"
      ? item.sensitivity
      : null;
  const importance = item.importance === 1 || item.importance === 2 || item.importance === 3 ? item.importance : null;
  const sourceBasis = item.source_basis === "explicit" || item.source_basis === "observed" ? item.source_basis : null;
  if (scope === null || sensitivity === null || importance === null || sourceBasis === null) return null;

  return policyRevisionPreconditionDigest({
    id: item.id,
    body: item.body,
    title: item.title,
    tags: tags(item),
    scope,
    auId: item.au_id,
    sensitivity,
    importance,
    approvalState: item.approval_state,
    lifecycleState: item.lifecycle_state,
    sourceBasis,
    provenance: parseProvenance(item),
  });
}

/** Full semantic commitment for one curation decision target, with no body copied into receipts. */
export function curationDecisionTargetDigest(decision: EffectiveCurationDecision): string {
  return sha256Canonical({
    schema: "delos.mnemosyne.curation-target.v1",
    decisionSetId: decision.decisionSetId,
    decisionId: decision.decisionId,
    action: decision.row.action,
    cardId: decision.row.card_id,
    replacement: {
      title: decision.row.replacement_title,
      body: decision.row.replacement_body,
      scope: decision.row.replacement_scope,
      auId: decision.row.replacement_au_id,
      tags: decision.row.replacement_tags ?? null,
      sensitivity: decision.row.replacement_sensitivity ?? null,
      importance: decision.row.replacement_importance ?? null,
    },
    consolidation: decision.row.consolidation ?? null,
    evidence: decision.evidence,
  });
}

/**
 * Read-only whole-set application preflight. This module owns no store and has
 * no mutation port: every reviewed decision and all referenced participants are
 * validated before a later governance-writer slice is allowed to perform the
 * first append.
 */
export function preflightCurationApplication(
  bundle: CurationDecisionSetBundle,
  reader: CurationStateReader,
): CurationApplicationPreflight {
  const contract = preflightCurationDecisionSet(bundle);
  if (!contract.ok) {
    return { ok: false, issues: contract.issues.map((issue) => ({ ...issue })) };
  }

  const issues: CurationApplyIssue[] = [];
  const plans: CurationWritePlan[] = [];

  for (const decision of contract.value.decisions) {
    if (decision.row.action === "NEEDS_OWNER") {
      issues.push({
        path: `decisions.${decision.row.card_id}.action`,
        message: "NEEDS_OWNER cannot enter the applicator",
      });
      continue;
    }
    const action = decision.row.action;
    const actor = actorFor(decision, issues);
    const item = reader.getItem(decision.row.card_id);
    if (item === undefined) {
      issues.push({ path: `decisions.${decision.row.card_id}`, message: "reviewed card is missing from the target store" });
      continue;
    }

    validatePolicyActivatedCard(item, `decisions.${decision.row.card_id}`, issues);
    validateReviewedBasis(decision, item, issues);

    if (action === "REVISE" && decision.row.replacement_body === null) {
      issues.push({
        path: `decisions.${decision.row.card_id}.replacement_body`,
        message: "REVISE requires replacement_body",
      });
    }
    if (action === "RECLASSIFY_AU") {
      const auId = decision.row.replacement_au_id;
      if (auId === null || !AU_ID_RE.test(auId)) {
        issues.push({
          path: `decisions.${decision.row.card_id}.replacement_au_id`,
          message: "RECLASSIFY_AU requires an exact canonical AU slug",
        });
      }
    }
    if (action === "SUPERSEDE" || action === "MERGE") {
      validateConsolidationState(decision, reader, issues);
    }

    const preconditionDigest =
      action === "REVISE"
        ? curationRevisionPreconditionDigest(item)
        : curationItemPreconditionDigest(item);
    if (preconditionDigest === null) {
      issues.push({
        path: `decisions.${decision.row.card_id}.precondition`,
        message: "REVISE target projection cannot be represented by the policy-revision precondition contract",
      });
      continue;
    }
    if (actor === null) continue;

    plans.push({
      decision,
      action,
      preconditionDigest,
      targetDigest: curationDecisionTargetDigest(decision),
      actor,
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    decisionSetId: contract.value.decisionSetId,
    decisionSetSha256: contract.value.decisionSetSha256,
    plans,
  };
}
