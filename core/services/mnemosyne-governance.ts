/**
 * Mnemosyne governance service: the ONLY runtime write path into the
 * memory house, and it only moves on explicit human decisions.
 *
 * UI-independent by construction: Telegram (or any later surface) is an
 * adapter that calls these operations; every rule lives here. The
 * ordinary chat runtime never holds a reference to this service, so
 * model output structurally cannot reach a write.
 *
 * Vocabulary mapping (existing kernel + governance events only — no
 * second source of truth):
 *   propose   = memory_created + attributes_set            (unconfirmed)
 *   approve   = confirmed{by: owner|companion|both}        (human only)
 *   edit      = memory_revised(amendment)                  (stays unconfirmed)
 *   revise    = memory_revised(correction) + confirmed{by} (one transaction)
 *   reject    = retrieval_set{false, human} + memory_deactivated
 *   revoke    = retrieval_set{false, human} + memory_deactivated
 * Reject/revoke keep full history and a TYPED human actor (the
 * retrieval_set event is human-only in the domain); nothing is ever
 * deleted or overwritten in place.
 *
 * Admission quarantine runs at proposal time: directive-like or
 * structural-injection text is refused outright, exactly as retrieval
 * would refuse it later. Muse and the model may SUGGEST, but no code
 * path here accepts a non-human confirmation actor.
 */

import { randomUUID } from "node:crypto";
import type { MemoryCreationEvidence, MemoryEventEnvelope } from "../domain/memory.js";
import {
  asConversationId,
  asManualEntryId,
  asMessageId,
  asTurnId,
} from "../domain/ids.js";
import {
  deriveProvenanceAxes,
  type CanonicalSourceBasis,
  type CurationRecordedAction,
  type MnemosyneEnvelope,
  type OwnerPolicyCurrent,
  type ProposalOrigin,
  type ProvenanceRoles,
} from "../domain/mnemosyne.js";
import { assessUntrustedBody, estimateTokens } from "./anamnesis.js";
import {
  planPolicyActivatedAuReclassification,
  type PolicyAuReclassificationCard,
} from "./policy-au-reclassification.js";
import {
  planPolicyActivatedMerge,
  planPolicyActivatedSupersede,
  type PolicyConsolidationCard,
} from "./policy-card-consolidation.js";
import {
  policyRevisionPreconditionDigest,
  policyRevisionTargetDigest,
  validatePolicyRevisionDecision,
  type PolicyRevisionDecision,
} from "./policy-revision-idempotence.js";

export type HumanActor = "owner" | "companion" | "both";

export interface GovernanceIssue {
  path: string;
  message: string;
}

/** Structural store surface; the SQLite MnemosyneStore satisfies it. */
export interface GovernanceStore {
  appendJoint(
    kernel: readonly MemoryEventEnvelope[],
    governance: readonly MnemosyneEnvelope[],
  ):
    | { status: "appended"; kernel: number; governance: number }
    | { status: "rejected"; issues: GovernanceIssue[] };
  rebuildProjections(): Promise<{ items: number; priors: number }>;
  getItem(id: string): GovernanceItemView | undefined;
  listItems(): GovernanceItemView[];
  ftsSearch(query: string, limit: number): Array<{ itemId: string; rank: number }>;
  listSources(subjectKind: string, subjectId: string): Array<{ kind: string; pointer: string }>;
  /** Optional on structural fakes; required for durable decision/curation replay. */
  readGovernance?(): MnemosyneEnvelope[];
  /** D0: current durable owner policies (fold-derived from events). */
  currentPolicies(): Map<string, OwnerPolicyCurrent>;
}

export interface GovernanceItemView {
  id: string;
  title: string;
  body: string;
  scope: string;
  au_id: string | null;
  sensitivity: string;
  importance: number;
  approval_state: string;
  lifecycle_state: string;
  confirmed_by: string | null;
  retrieval: string;
  /** Projected replacement pointer when this card has been superseded. */
  supersedes?: string | null;
  /** Canonical evidence basis projected from governance events. */
  source_basis?: string | null;
  tags_text: string;
  created_at: string;
  updated_at: string;
  /** Workflow provenance JSON (v2 column); null = legacy/unknown. */
  provenance: string | null;
}

/** Safe parse of an item's provenance column. */
export function parseProvenance(item: GovernanceItemView): ProvenanceRoles | null {
  if (item.provenance === null) return null;
  try {
    const parsed: unknown = JSON.parse(item.provenance);
    return parsed !== null && typeof parsed === "object" ? (parsed as ProvenanceRoles) : null;
  } catch {
    return null;
  }
}

/** Where a proposal's text is grounded. */
export type ProposalEvidence =
  | {
      /** Already-validated canonical creation evidence; never relabelled here. */
      kind: "memory_creation";
      evidence: MemoryCreationEvidence;
      /** Exact source-turn identity used only by host-side dedup callers. */
      sourceTurnId?: string;
    }
  | {
      kind: "transcript";
      conversationId: string;
      turnId: string;
      messageId: string;
      /** Optional transport annotation (e.g. telegram message id). */
      externalKey?: string;
    }
  | { kind: "manual"; note?: string };

function materializeProposalEvidence(input: ProposalEvidence): MemoryCreationEvidence {
  if (input.kind === "memory_creation") return input.evidence;
  if (input.kind === "transcript") {
    return {
      kind: "user_statement",
      source: {
        kind: "conversation_message",
        conversationId: asConversationId(input.conversationId),
        turnId: asTurnId(input.turnId),
        messageId: asMessageId(input.messageId),
        role: "user",
        ...(input.externalKey !== undefined
          ? { external: { source: "telegram", externalTurnKey: input.externalKey } }
          : {}),
      },
    };
  }
  return {
    kind: "user_statement",
    source: { kind: "manual_entry", manualEntryId: asManualEntryId(randomUUID()) },
  };
}

/** Canonical evidence axis for every newly materialized proposal. */
export function canonicalBasisForEvidence(evidence: MemoryCreationEvidence): CanonicalSourceBasis {
  switch (evidence.kind) {
    case "user_statement": return "explicit";
    case "assistant_dialogue": return "observed";
    case "model_inference": return "inferred";
    case "imported": return "imported";
  }
}

function proposalEvidenceKind(input: ProposalEvidence): string {
  return input.kind === "memory_creation" ? input.evidence.kind : input.kind;
}

export interface ProposeInput {
  body: string;
  title?: string;
  tags?: string[];
  scope: "global" | "relationship" | "project" | "au";
  auId?: string;
  sensitivity: "normal" | "sensitive" | "intimate";
  importance: 1 | 2 | 3;
  evidence: ProposalEvidence;
  proposedBy: "owner" | "companion";
  executionActor?: "owner" | "companion" | "system";
  provenance?: ProvenanceRoles;
}

export type GovernanceOutcome<T> =
  | ({ status: "ok" } & T)
  | { status: "refused"; issues: GovernanceIssue[] }
  | { status: "already"; detail: string };

export interface GovernanceWriteReceipt {
  memoryId: string;
  eventIds: string[];
  committed: true;
  backup: { ok: boolean; detail: string };
  retrySafe: true;
}

/** Metadata-only identity copied from the applicator's frozen write plan. */
export interface CurationDecisionReceiptRecord {
  memoryId: string;
  decisionId: string;
  decisionSetId: string;
  action: CurationRecordedAction;
  targetDigest: string;
  preconditionDigest: string;
}

export interface CurationBatchReceiptRecord {
  decisionSetId: string;
  decisionSetSha256: string;
  decisionIds: readonly string[];
}

export interface MnemosyneGovernanceOptions {
  store: GovernanceStore;
  backup: (label: string) => { path: string };
  audit: (event: Record<string, unknown>) => void;
  now?: () => Date;
}

const MAX_BODY_CHARS = 2000;
const MAX_TITLE_CHARS = 120;
const MAX_POLICY_REPAIR_TAGS = 32;
const MAX_POLICY_REPAIR_TAG_CHARS = 80;

type PolicyRepairBasis = "explicit" | "observed";
type PolicyRepairScope = "global" | "relationship" | "project" | "au";
type PolicyRepairSensitivity = "normal" | "sensitive" | "intimate";
type PreparedCurationReceipt =
  | { status: "ok"; envelope: MnemosyneEnvelope }
  | { status: "already"; detail: string }
  | { status: "refused"; issues: GovernanceIssue[] };

export interface PolicyActivatedRepairAttributes {
  readonly tags?: readonly string[];
  readonly scope?: "global" | "relationship" | "project";
  readonly sensitivity?: "normal" | "sensitive" | "intimate";
  readonly importance?: 1 | 2 | 3;
}

interface PolicyRepairState {
  basis: PolicyRepairBasis;
  scope: PolicyRepairScope;
  auId: string | null;
  sensitivity: PolicyRepairSensitivity;
  importance: 1 | 2 | 3;
  tags: string[];
}
interface ResolvedPolicyRepairAttributes {
  scope: PolicyRepairScope;
  auId: string | null;
  sensitivity: PolicyRepairSensitivity;
  importance: 1 | 2 | 3;
  tags: string[];
}

function policyRepairState(item: GovernanceItemView): { ok: true; value: PolicyRepairState } | { ok: false; issues: GovernanceIssue[] } {
  const issues: GovernanceIssue[] = [];
  const basis = item.source_basis === "explicit" || item.source_basis === "observed" ? item.source_basis : null;
  if (basis === null) issues.push({ path: "sourceBasis", message: "policy-card repair requires an explicit|observed projected evidence basis" });
  const provenanceBasis = deriveProvenanceAxes(parseProvenance(item)).evidenceBasis;
  if (basis !== null && provenanceBasis !== null && provenanceBasis !== basis) {
    issues.push({ path: "provenance.source_basis", message: "projected evidence basis conflicts with provenance; repair refused" });
  }
  if (item.confirmed_by !== null) issues.push({ path: "confirmed_by", message: "policy-activated repair refuses cards carrying individual confirmation" });
  const scope = item.scope === "global" || item.scope === "relationship" || item.scope === "project" || item.scope === "au" ? item.scope : null;
  if (scope === null) issues.push({ path: "scope", message: "policy-card repair refuses non-durable scope" });
  if (scope === "au" && (item.au_id === null || item.au_id.trim().length === 0)) issues.push({ path: "auId", message: "existing AU scope is missing an AU id" });
  const sensitivity = item.sensitivity === "normal" || item.sensitivity === "sensitive" || item.sensitivity === "intimate" ? item.sensitivity : null;
  if (sensitivity === null) issues.push({ path: "sensitivity", message: "policy-card repair found invalid sensitivity" });
  const importance = item.importance === 1 || item.importance === 2 || item.importance === 3 ? item.importance : null;
  if (importance === null) issues.push({ path: "importance", message: "policy-card repair found invalid importance" });
  if (issues.length > 0 || basis === null || scope === null || sensitivity === null || importance === null) return { ok: false, issues };
  return { ok: true, value: { basis, scope, auId: item.au_id, sensitivity, importance, tags: item.tags_text.split(" ").filter(Boolean) } };
}

function resolvePolicyRepairAttributes(state: PolicyRepairState, attrs: PolicyActivatedRepairAttributes | undefined): { ok: true; value: ResolvedPolicyRepairAttributes } | { ok: false; issues: GovernanceIssue[] } {
  const issues: GovernanceIssue[] = [];
  let tags = [...state.tags];
  if (attrs?.tags !== undefined) {
    if (!Array.isArray(attrs.tags)) issues.push({ path: "attrs.tags", message: "replacement tags must be an array" });
    else if (attrs.tags.length > MAX_POLICY_REPAIR_TAGS) issues.push({ path: "attrs.tags", message: `replacement tags must contain at most ${MAX_POLICY_REPAIR_TAGS} entries` });
    else {
      const next: string[] = []; const seen = new Set<string>();
      attrs.tags.forEach((rawTag, index) => {
        if (typeof rawTag !== "string") { issues.push({ path: `attrs.tags[${index}]`, message: "tag must be a string" }); return; }
        if (rawTag.length === 0 || rawTag.length > MAX_POLICY_REPAIR_TAG_CHARS || rawTag !== rawTag.trim() || /\s/u.test(rawTag)) {
          issues.push({ path: `attrs.tags[${index}]`, message: `tag must be a trimmed non-whitespace token of 1..${MAX_POLICY_REPAIR_TAG_CHARS} chars` }); return;
        }
        if (seen.has(rawTag)) { issues.push({ path: `attrs.tags[${index}]`, message: "replacement tags must be unique" }); return; }
        seen.add(rawTag); next.push(rawTag);
      });
      tags = next;
    }
  }
  const requestedScope = attrs?.scope;
  if (requestedScope !== undefined && requestedScope !== "global" && requestedScope !== "relationship" && requestedScope !== "project") issues.push({ path: "attrs.scope", message: "revision scope must be global|relationship|project; use AU reclassification for AU scope" });
  const scope: PolicyRepairScope = requestedScope ?? state.scope;
  const auId = scope === "au" ? state.auId : null;
  if (scope === "au" && (auId === null || auId.trim().length === 0)) issues.push({ path: "attrs.scope", message: "preserved AU scope is missing an AU id" });
  const sensitivity = attrs?.sensitivity ?? state.sensitivity;
  if (sensitivity !== "normal" && sensitivity !== "sensitive" && sensitivity !== "intimate") issues.push({ path: "attrs.sensitivity", message: "invalid replacement sensitivity" });
  const importance = attrs?.importance ?? state.importance;
  if (importance !== 1 && importance !== 2 && importance !== 3) issues.push({ path: "attrs.importance", message: "replacement importance must be 1..3" });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { scope, auId, sensitivity, importance, tags } };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameCurationDecisionReceipt(left: CurationDecisionReceiptRecord, right: CurationDecisionReceiptRecord): boolean {
  return left.memoryId === right.memoryId && left.decisionId === right.decisionId && left.decisionSetId === right.decisionSetId && left.action === right.action && left.targetDigest === right.targetDigest && left.preconditionDigest === right.preconditionDigest;
}
function sameCurationBatchReceipt(left: CurationBatchReceiptRecord, right: CurationBatchReceiptRecord): boolean {
  return left.decisionSetId === right.decisionSetId && left.decisionSetSha256 === right.decisionSetSha256 && sameStringArray([...left.decisionIds].sort(), [...right.decisionIds].sort());
}

function proposalOriginFor(input: Pick<ProposeInput, "proposedBy" | "provenance">): ProposalOrigin {
  return deriveProvenanceAxes(input.provenance ?? null).proposalOrigin ?? (input.proposedBy === "owner" ? "owner_request" : "companion_self");
}
function resolveCanonicalProvenance(input: Pick<ProposeInput, "proposedBy" | "provenance">, evidenceBasis: CanonicalSourceBasis): { ok: true; value: ProvenanceRoles } | { ok: false; issues: GovernanceIssue[] } {
  const axes = deriveProvenanceAxes(input.provenance ?? null);
  if (axes.evidenceBasis !== null && axes.evidenceBasis !== evidenceBasis) {
    return { ok: false, issues: [{ path: "provenance.source_basis", message: `provenance evidence basis ${axes.evidenceBasis} conflicts with canonical evidence basis ${evidenceBasis}` }] };
  }
  return { ok: true, value: { ...(input.provenance ?? {}), source_basis: evidenceBasis, proposal_origin: axes.proposalOrigin ?? proposalOriginFor(input) } };
}
function verifiedGeneratorIdentity(value: string): boolean {
  const normalized = value.trim(); return value === normalized && normalized.length > 0 && normalized !== "unverified-model";
}
function resolveEvidence(input: ProposalEvidence): { ok: true; value: MemoryCreationEvidence } | { ok: false; issues: GovernanceIssue[] } {
  try { return { ok: true, value: materializeProposalEvidence(input) }; }
  catch { return { ok: false, issues: [{ path: "evidence", message: "proposal evidence contains an invalid canonical identity" }] }; }
}
function policyConsolidationCard(item: GovernanceItemView): PolicyConsolidationCard {
  return { id: item.id, approvalState: item.approval_state, lifecycleState: item.lifecycle_state, supersededByMemoryId: item.supersedes ?? null, sourceBasis: item.source_basis ?? null, confirmedBy: item.confirmed_by };
}
function policyAuReclassificationCard(item: GovernanceItemView): PolicyAuReclassificationCard {
  return { id: item.id, title: item.title, tags: item.tags_text.split(" ").filter(Boolean), approvalState: item.approval_state, lifecycleState: item.lifecycle_state, sourceBasis: item.source_basis ?? null, provenanceSourceBasis: deriveProvenanceAxes(parseProvenance(item)).evidenceBasis, confirmedBy: item.confirmed_by, scope: item.scope, auId: item.au_id, sensitivity: item.sensitivity, importance: item.importance };
}

export class MnemosyneGovernanceService {
  private readonly store: GovernanceStore;
  private readonly backup: (label: string) => { path: string };
  private readonly audit: (event: Record<string, unknown>) => void;
  private readonly now: () => Date;

  constructor(options: MnemosyneGovernanceOptions) {
    this.store = options.store; this.backup = options.backup; this.audit = options.audit; this.now = options.now ?? (() => new Date());
  }

  curationDecisionReceipts(decisionId: string): CurationDecisionReceiptRecord[] {
    if (this.store.readGovernance === undefined) return [];
    return this.store.readGovernance().filter((envelope) => envelope.event.type === "curation_decision_recorded" && envelope.event.decisionId === decisionId).map((envelope) => {
      if (envelope.event.type !== "curation_decision_recorded") throw new Error("unreachable");
      return { memoryId: envelope.event.memoryId, decisionId: envelope.event.decisionId, decisionSetId: envelope.event.decisionSetId, action: envelope.event.action, targetDigest: envelope.event.targetDigest, preconditionDigest: envelope.event.preconditionDigest };
    });
  }
  curationBatchReceipts(decisionSetId: string): CurationBatchReceiptRecord[] {
    if (this.store.readGovernance === undefined) return [];
    return this.store.readGovernance().filter((envelope) => envelope.event.type === "curation_batch_recorded" && envelope.event.decisionSetId === decisionSetId).map((envelope) => {
      if (envelope.event.type !== "curation_batch_recorded") throw new Error("unreachable");
      return { decisionSetId: envelope.event.decisionSetId, decisionSetSha256: envelope.event.decisionSetSha256, decisionIds: [...envelope.event.decisionIds] };
    });
  }
  private prepareCurationDecisionReceipt(receipt: CurationDecisionReceiptRecord, actor: "owner" | "companion"): PreparedCurationReceipt {
    if (this.store.readGovernance === undefined) return { status: "refused", issues: [{ path: "curationReceipt", message: "store does not expose durable governance history" }] };
    const prior = this.curationDecisionReceipts(receipt.decisionId);
    if (prior.length > 1) return { status: "refused", issues: [{ path: "curationReceipt.decisionId", message: "duplicate durable curation receipts already exist" }] };
    if (prior[0] !== undefined) {
      if (sameCurationDecisionReceipt(prior[0], receipt)) return { status: "already", detail: `curation decision ${receipt.decisionId} already recorded` };
      return { status: "refused", issues: [{ path: "curationReceipt.decisionId", message: "decision id already has a different durable curation receipt" }] };
    }
    return { status: "ok", envelope: { eventId: randomUUID(), occurredAt: this.now().toISOString(), actor, event: { type: "curation_decision_recorded", memoryId: receipt.memoryId, decisionId: receipt.decisionId, decisionSetId: receipt.decisionSetId, action: receipt.action, targetDigest: receipt.targetDigest, preconditionDigest: receipt.preconditionDigest } } };
  }
  async recordCurationKeep(receipt: CurationDecisionReceiptRecord, actor: "owner" | "companion"): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    if (receipt.action !== "KEEP") return { status: "refused", issues: [{ path: "curationReceipt.action", message: "KEEP receipt required" }] };
    const item = this.store.getItem(receipt.memoryId);
    if (item === undefined || item.lifecycle_state !== "active" || item.approval_state !== "policy_activated") return { status: "refused", issues: [{ path: "curationReceipt.memoryId", message: "KEEP requires an active policy-activated card" }] };
    const prepared = this.prepareCurationDecisionReceipt(receipt, actor); if (prepared.status !== "ok") return prepared;
    return this.commit("curation_keep", receipt.memoryId, [], [prepared.envelope], { decision_id: receipt.decisionId, decision_set_id: receipt.decisionSetId, action: receipt.action });
  }
  async recordCurationBatch(receipt: CurationBatchReceiptRecord): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    if (this.store.readGovernance === undefined) return { status: "refused", issues: [{ path: "batchReceipt", message: "store does not expose durable governance history" }] };
    const prior = this.curationBatchReceipts(receipt.decisionSetId);
    if (prior.length > 1) return { status: "refused", issues: [{ path: "batchReceipt.decisionSetId", message: "duplicate durable batch receipts already exist" }] };
    if (prior[0] !== undefined) {
      if (sameCurationBatchReceipt(prior[0], receipt)) return { status: "already", detail: `curation batch ${receipt.decisionSetId} already recorded` };
      return { status: "refused", issues: [{ path: "batchReceipt.decisionSetId", message: "decision-set id already has a different durable batch receipt" }] };
    }
    for (const decisionId of receipt.decisionIds) {
      const decisions = this.curationDecisionReceipts(decisionId);
      if (decisions.length !== 1 || decisions[0]?.decisionSetId !== receipt.decisionSetId) return { status: "refused", issues: [{ path: "batchReceipt.decisionIds", message: `decision ${decisionId} lacks one matching durable per-decision receipt` }] };
    }
    const envelope: MnemosyneEnvelope = { eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: "system", event: { type: "curation_batch_recorded", decisionSetId: receipt.decisionSetId, decisionSetSha256: receipt.decisionSetSha256, decisionIds: [...receipt.decisionIds].sort() } };
    return this.commit("curation_batch", `decision-set:${receipt.decisionSetId.slice(0, 16)}`, [], [envelope], { decision_set_id: receipt.decisionSetId, decision_count: receipt.decisionIds.length });
  }

  async propose(input: ProposeInput): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const issues: GovernanceIssue[] = []; const body = input.body.trim(); const title = (input.title ?? body.slice(0, 60)).trim();
    if (body.length === 0) issues.push({ path: "body", message: "memory text is required" });
    if (body.length > MAX_BODY_CHARS) issues.push({ path: "body", message: `memory text over ${MAX_BODY_CHARS} chars` });
    if (title.length > MAX_TITLE_CHARS) issues.push({ path: "title", message: `title over ${MAX_TITLE_CHARS} chars` });
    if (input.scope === "au" && (input.auId === undefined || input.auId.length === 0)) issues.push({ path: "auId", message: "au scope requires an AU id" });
    for (const [field, text] of [["body", body], ["title", title]] as const) if (text.length > 0) { const admission = assessUntrustedBody(text); if (!admission.ok) issues.push({ path: field, message: admission.reason }); }
    if (issues.length > 0) return { status: "refused", issues };
    const resolvedEvidence = resolveEvidence(input.evidence); if (!resolvedEvidence.ok) return { status: "refused", issues: resolvedEvidence.issues };
    const evidence = resolvedEvidence.value; const evidenceBasis = canonicalBasisForEvidence(evidence); const resolvedProvenance = resolveCanonicalProvenance(input, evidenceBasis); if (!resolvedProvenance.ok) return { status: "refused", issues: resolvedProvenance.issues }; const provenance = resolvedProvenance.value;
    const memoryId = randomUUID();
    const created = { schemaVersion: 1, eventId: randomUUID(), occurredAt: this.now().toISOString(), event: { type: "memory_created", memoryId, content: body, evidence, scope: { kind: "shared" } } } as unknown as MemoryEventEnvelope;
    const attributes: MnemosyneEnvelope = { eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: input.executionActor ?? input.proposedBy, event: { type: "attributes_set", memoryId, title, tags: [...(input.tags ?? [])], scope: input.scope, ...(input.scope === "au" ? { auId: input.auId! } : {}), sensitivity: input.sensitivity, importance: input.importance, sourceBasis: evidenceBasis } };
    const governance: MnemosyneEnvelope[] = [attributes, { eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: input.executionActor ?? input.proposedBy, event: { type: "provenance_set", memoryId, roles: provenance } }];
    return this.commit("propose", memoryId, [created], governance, { scope: input.scope, sensitivity: input.sensitivity, evidence_kind: proposalEvidenceKind(input.evidence), proposed_by: input.proposedBy, provenance_roles: provenance, token_estimate: estimateTokens(body) });
  }

  async ensureOwnerPolicy(policy: OwnerPolicyCurrent): Promise<GovernanceOutcome<{ registered: boolean }>> {
    const existing = this.store.currentPolicies().get(policy.policyId);
    if (existing !== undefined) {
      if (existing.effectiveFrom === policy.effectiveFrom && existing.manualPerCardApprovalRequired === policy.manualPerCardApprovalRequired && existing.ownerCanViewEditRevoke === policy.ownerCanViewEditRevoke && existing.authorityRef === policy.authorityRef) return { status: "already", detail: "policy already registered — nothing was written" };
      return { status: "refused", issues: [{ path: "policyId", message: "a different policy with this id already exists; policy history is append-only — mint a new policy id" }] };
    }
    const envelope: MnemosyneEnvelope = { eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: "system", event: { type: "owner_policy_set", policyId: policy.policyId, authority: policy.authority, effectiveFrom: policy.effectiveFrom, manualPerCardApprovalRequired: policy.manualPerCardApprovalRequired, ownerCanViewEditRevoke: policy.ownerCanViewEditRevoke, authorityRef: policy.authorityRef } };
    const outcome = this.store.appendJoint([], [envelope]); if (outcome.status !== "appended") return { status: "refused", issues: outcome.issues };
    await this.store.rebuildProjections(); let backupResult: { ok: boolean; detail: string };
    try { const report = this.backup("owner_policy"); backupResult = { ok: true, detail: report.path }; }
    catch (error) { backupResult = { ok: false, detail: `write persisted but backup failed: ${error instanceof Error ? error.message : String(error)}` }; this.audit({ type: "governance_backup_failed", op: "owner_policy", policy_id: policy.policyId, committed: true, retry_safe: true }); }
    this.audit({ type: "owner_policy_registered", policy_id: policy.policyId, authority_ref: policy.authorityRef, backup_ok: backupResult.ok }); return { status: "ok", registered: true };
  }
  ownerPolicy(policyId: string): OwnerPolicyCurrent | null { return this.store.currentPolicies().get(policyId) ?? null; }

  async proposeUnderPolicy(input: ProposeInput & { activation: { policyId: string; sourceBasis: "explicit" | "observed"; generator: string }; expiresAt?: string; supersedes?: { memoryId: string; reason: string } }): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const policy = this.store.currentPolicies().get(input.activation.policyId);
    if (policy === undefined) return { status: "refused", issues: [{ path: "activation.policyId", message: "owner policy not durably registered — activation refused" }] };
    if (policy.manualPerCardApprovalRequired) return { status: "refused", issues: [{ path: "activation.policyId", message: "policy requires manual per-card approval — cannot auto-activate" }] };
    if (input.supersedes !== undefined) { const old = this.store.getItem(input.supersedes.memoryId); if (old === undefined || old.lifecycle_state !== "active") return { status: "refused", issues: [{ path: "supersedes.memoryId", message: "no active card to supersede" }] }; }
    const issues: GovernanceIssue[] = []; const resolvedEvidence = resolveEvidence(input.evidence); if (!resolvedEvidence.ok) return { status: "refused", issues: resolvedEvidence.issues }; const evidence = resolvedEvidence.value; const evidenceBasis = canonicalBasisForEvidence(evidence);
    if (evidenceBasis === "inferred" || evidenceBasis === "imported") issues.push({ path: "evidence.kind", message: `${evidenceBasis} evidence cannot be activated under owner policy` });
    if (evidenceBasis !== input.activation.sourceBasis) issues.push({ path: "activation.sourceBasis", message: `activation basis ${input.activation.sourceBasis} does not match evidence basis ${evidenceBasis}` });
    const resolvedProvenance = resolveCanonicalProvenance(input, evidenceBasis); if (!resolvedProvenance.ok) issues.push(...resolvedProvenance.issues);
    if (!verifiedGeneratorIdentity(input.activation.generator)) issues.push({ path: "activation.generator", message: "verified generator identity is required for policy activation" });
    const body = input.body.trim(); const title = (input.title ?? body.slice(0, 60)).trim();
    if (body.length === 0) issues.push({ path: "body", message: "memory text is required" }); if (body.length > MAX_BODY_CHARS) issues.push({ path: "body", message: `memory text over ${MAX_BODY_CHARS} chars` }); if (title.length > MAX_TITLE_CHARS) issues.push({ path: "title", message: `title over ${MAX_TITLE_CHARS} chars` }); if (input.scope === "au" && (input.auId === undefined || input.auId.length === 0)) issues.push({ path: "auId", message: "au scope requires an AU id" });
    for (const [field, text] of [["body", body], ["title", title]] as const) if (text.length > 0) { const admission = assessUntrustedBody(text); if (!admission.ok) issues.push({ path: field, message: admission.reason }); }
    if (issues.length > 0 || !resolvedProvenance.ok) return { status: "refused", issues };
    const provenance = resolvedProvenance.value; const memoryId = randomUUID();
    const kernel: MemoryEventEnvelope[] = [{ schemaVersion: 1, eventId: randomUUID(), occurredAt: this.now().toISOString(), event: { type: "memory_created", memoryId, content: body, evidence, scope: { kind: "shared" } } } as unknown as MemoryEventEnvelope];
    if (input.supersedes !== undefined) kernel.push({ schemaVersion: 1, eventId: randomUUID(), occurredAt: this.now().toISOString(), event: { type: "memory_superseded", memoryId: input.supersedes.memoryId, supersededByMemoryId: memoryId, reason: input.supersedes.reason.slice(0, 200) } } as unknown as MemoryEventEnvelope);
    const governance: MnemosyneEnvelope[] = [
      { eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: input.executionActor ?? "system", event: { type: "attributes_set", memoryId, title, tags: [...(input.tags ?? [])], scope: input.scope, ...(input.scope === "au" ? { auId: input.auId! } : {}), sensitivity: input.sensitivity, importance: input.importance, sourceBasis: evidenceBasis } },
      { eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: input.executionActor ?? "system", event: { type: "provenance_set", memoryId, roles: provenance } },
      { eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: "system", event: { type: "policy_activated", memoryId, policyId: input.activation.policyId, activationBasis: "owner_policy", sourceBasis: input.activation.sourceBasis, generator: input.activation.generator } },
    ];
    if (input.expiresAt !== undefined) governance.push({ eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: "system", event: { type: "expiry_set", memoryId, expiresAt: input.expiresAt } });
    return this.commit("propose_under_policy", memoryId, kernel, governance, { scope: input.scope, sensitivity: input.sensitivity, evidence_kind: proposalEvidenceKind(input.evidence), activation_policy_id: input.activation.policyId, activation_source_basis: input.activation.sourceBasis, generator: input.activation.generator, ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}), ...(input.supersedes !== undefined ? { supersedes: input.supersedes.memoryId } : {}), provenance_roles: provenance, token_estimate: estimateTokens(body) });
  }

  async activateExistingUnderPolicy(memoryId: string, activation: { policyId: string; sourceBasis: "explicit" | "observed"; generator: string }, expiresAt?: string): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const policy = this.store.currentPolicies().get(activation.policyId); if (policy === undefined || policy.manualPerCardApprovalRequired) return { status: "refused", issues: [{ path: "activation.policyId", message: "owner policy not registered or requires manual approval" }] };
    const item = this.store.getItem(memoryId); if (item === undefined || item.lifecycle_state !== "active") return { status: "refused", issues: [{ path: "memoryId", message: "no active card" }] }; if (item.approval_state === "confirmed") return { status: "already", detail: "already individually confirmed — outranks policy activation" }; if (item.approval_state === "policy_activated") return { status: "already", detail: "already policy-activated" };
    if (!verifiedGeneratorIdentity(activation.generator)) return { status: "refused", issues: [{ path: "activation.generator", message: "verified generator identity is required for policy activation" }] };
    const provenanceBasis = deriveProvenanceAxes(parseProvenance(item)).evidenceBasis; const projectedBasis = item.source_basis === "explicit" || item.source_basis === "observed" ? item.source_basis : null;
    if (projectedBasis === null || provenanceBasis === null || projectedBasis !== provenanceBasis || projectedBasis !== activation.sourceBasis) return { status: "refused", issues: [{ path: "activation.sourceBasis", message: "existing card evidence basis is absent, non-activatable, or inconsistent with the requested activation basis" }] };
    const governance: MnemosyneEnvelope[] = [{ eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: "system", event: { type: "policy_activated", memoryId, policyId: activation.policyId, activationBasis: "owner_policy", sourceBasis: activation.sourceBasis, generator: activation.generator } }];
    if (expiresAt !== undefined) governance.push({ eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: "system", event: { type: "expiry_set", memoryId, expiresAt } });
    return this.commit("activate_under_policy", memoryId, [], governance, { activation_policy_id: activation.policyId, activation_source_basis: activation.sourceBasis, generator: activation.generator, ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}) });
  }

  async approve(memoryId: string, by: HumanActor): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const item = this.store.getItem(memoryId); if (item === undefined) return { status: "refused", issues: [{ path: "memoryId", message: "no such card" }] }; if (item.lifecycle_state !== "active") return { status: "refused", issues: [{ path: "memoryId", message: `card is ${item.lifecycle_state}` }] }; if (item.approval_state === "confirmed") return { status: "already", detail: "already confirmed — nothing was written again" };
    const confirmed: MnemosyneEnvelope = { eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: by === "both" ? "owner" : by, event: { type: "confirmed", memoryId, by } };
    return this.commit("approve", memoryId, [], [confirmed], { by });
  }

  async editPending(memoryId: string, newBody: string, editedBy: "owner" | "companion", newTitle?: string, provenanceDelta?: ProvenanceRoles, attrs?: { scope: "global" | "relationship" | "project" | "au"; auId?: string; sensitivity?: "normal" | "sensitive" | "intimate" }): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const item = this.store.getItem(memoryId); if (item === undefined || item.lifecycle_state !== "active") return { status: "refused", issues: [{ path: "memoryId", message: "no active card" }] }; if (item.approval_state === "confirmed") return { status: "refused", issues: [{ path: "memoryId", message: "card is confirmed — use revise instead" }] }; if (item.approval_state !== "candidate") return { status: "refused", issues: [{ path: "memoryId", message: "pending edit applies only to candidate cards; policy-activated cards require the governed policy-card repair path" }] };
    return this.reviseKernel("edit", item, newBody, editedBy, newTitle, null, provenanceDelta, attrs);
  }
  async reviseConfirmed(memoryId: string, newBody: string, by: HumanActor, newTitle?: string): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const item = this.store.getItem(memoryId); if (item === undefined || item.lifecycle_state !== "active") return { status: "refused", issues: [{ path: "memoryId", message: "no active card" }] }; if (item.approval_state !== "confirmed") return { status: "refused", issues: [{ path: "memoryId", message: "card is not confirmed — use edit instead" }] };
    return this.reviseKernel("revise", item, newBody, by === "both" ? "owner" : by, newTitle, by);
  }

  async revisePolicyActivated(memoryId: string, newBody: string, evidence: MemoryCreationEvidence, by: "owner" | "companion", newTitle?: string, attrs?: PolicyActivatedRepairAttributes, decision?: PolicyRevisionDecision, curationReceipt?: CurationDecisionReceiptRecord): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const item = this.store.getItem(memoryId); if (item === undefined || item.lifecycle_state !== "active") return { status: "refused", issues: [{ path: "memoryId", message: "no active card" }] }; if (item.approval_state !== "policy_activated") return { status: "refused", issues: [{ path: "memoryId", message: "card is not policy-activated" }] };
    const state = policyRepairState(item); if (!state.ok) return { status: "refused", issues: state.issues }; const resolvedAttrs = resolvePolicyRepairAttributes(state.value, attrs); if (!resolvedAttrs.ok) return { status: "refused", issues: resolvedAttrs.issues };
    const body = newBody.trim(); const issues: GovernanceIssue[] = []; if (body.length === 0 || body.length > MAX_BODY_CHARS) issues.push({ path: "body", message: `replacement text must be 1..${MAX_BODY_CHARS} chars` }); else { const admission = assessUntrustedBody(body); if (!admission.ok) issues.push({ path: "body", message: admission.reason }); }
    const title = newTitle === undefined ? item.title : newTitle.trim(); if (newTitle !== undefined) { if (title.length === 0 || title.length > MAX_TITLE_CHARS) issues.push({ path: "title", message: `replacement title must be 1..${MAX_TITLE_CHARS} chars` }); else { const titleAdmission = assessUntrustedBody(title); if (!titleAdmission.ok) issues.push({ path: "title", message: titleAdmission.reason }); } }
    const evidenceBasis = canonicalBasisForEvidence(evidence); if (evidenceBasis !== state.value.basis) issues.push({ path: "evidence", message: `repair evidence basis ${evidenceBasis} does not match preserved basis ${state.value.basis}` });
    if (curationReceipt !== undefined) { if (curationReceipt.action !== "REVISE") issues.push({ path: "curationReceipt.action", message: "REVISE receipt required" }); if (curationReceipt.memoryId !== item.id) issues.push({ path: "curationReceipt.memoryId", message: "curation receipt targets a different card" }); if (decision === undefined || curationReceipt.decisionId !== decision.decisionId) issues.push({ path: "curationReceipt.decisionId", message: "curation receipt must bind the policy revision decision" }); }
    if (issues.length > 0) return { status: "refused", issues };
    const nextAttrs = resolvedAttrs.value; let decisionTargetDigest: string | null = null;
    if (decision !== undefined) {
      const validation = validatePolicyRevisionDecision(decision); if (!validation.ok) return { status: "refused", issues: [{ path: validation.path, message: validation.message }] }; if (this.store.readGovernance === undefined) return { status: "refused", issues: [{ path: "decision", message: "store does not expose durable governance history; decision-backed revision refused" }] };
      decisionTargetDigest = policyRevisionTargetDigest(decision, { memoryId: item.id, body, title, tags: nextAttrs.tags, scope: nextAttrs.scope, auId: nextAttrs.auId, sensitivity: nextAttrs.sensitivity, importance: nextAttrs.importance, evidence, sourceBasis: state.value.basis });
      const priorReceipts = this.store.readGovernance().filter((envelope) => envelope.event.type === "policy_revision_recorded" && envelope.event.decisionId === decision.decisionId);
      if (priorReceipts.length > 1) return { status: "refused", issues: [{ path: "decision.decisionId", message: "duplicate durable receipts already exist for this decision id; repair refused" }] };
      const prior = priorReceipts[0]; if (prior !== undefined && prior.event.type === "policy_revision_recorded") {
        if (prior.event.memoryId === item.id && prior.event.targetDigest === decisionTargetDigest && prior.event.sourceSha256 === decision.sourceSha256 && prior.event.preconditionDigest === decision.preconditionDigest) {
          if (curationReceipt !== undefined) {
            const genericPrior = this.curationDecisionReceipts(curationReceipt.decisionId);
            if (genericPrior.length === 1 && sameCurationDecisionReceipt(genericPrior[0]!, curationReceipt)) return { status: "already", detail: `policy revision decision ${decision.decisionId} already applied — nothing was written` };
            if (genericPrior.length > 0) return { status: "refused", issues: [{ path: "curationReceipt.decisionId", message: "policy revision receipt exists but generic curation receipt conflicts" }] };
            const recovery = this.prepareCurationDecisionReceipt(curationReceipt, by); if (recovery.status !== "ok") return recovery;
            return this.commit("curation_revision_receipt_recovery", item.id, [], [recovery.envelope], { decision_id: decision.decisionId, decision_set_id: curationReceipt.decisionSetId, action: curationReceipt.action });
          }
          return { status: "already", detail: `policy revision decision ${decision.decisionId} already applied — nothing was written` };
        }
        return { status: "refused", issues: [{ path: "decision.decisionId", message: "decision id already exists with a different memory or target payload" }] };
      }
      const currentPreconditionDigest = policyRevisionPreconditionDigest({ id: item.id, body: item.body, title: item.title, tags: state.value.tags, scope: state.value.scope, auId: state.value.auId, sensitivity: state.value.sensitivity, importance: state.value.importance, approvalState: item.approval_state, lifecycleState: item.lifecycle_state, sourceBasis: state.value.basis, provenance: parseProvenance(item) });
      if (currentPreconditionDigest !== decision.preconditionDigest) return { status: "refused", issues: [{ path: "decision.preconditionDigest", message: "policy revision precondition is stale; zero writes performed" }] };
    }
    let preparedCuration: PreparedCurationReceipt | null = null; if (curationReceipt !== undefined) { preparedCuration = this.prepareCurationDecisionReceipt(curationReceipt, by); if (preparedCuration.status !== "ok") return preparedCuration; }
    const revised = { schemaVersion: 1, eventId: randomUUID(), occurredAt: this.now().toISOString(), event: { type: "memory_revised", memoryId: item.id, revisionId: randomUUID(), revisionKind: "correction", content: body, evidence, scope: { kind: "shared" } } } as unknown as MemoryEventEnvelope;
    const titleChanged = newTitle !== undefined && title !== item.title; const tagsChanged = !sameStringArray(nextAttrs.tags, state.value.tags); const scopeChanged = nextAttrs.scope !== state.value.scope || nextAttrs.auId !== state.value.auId; const sensitivityChanged = nextAttrs.sensitivity !== state.value.sensitivity; const importanceChanged = nextAttrs.importance !== state.value.importance;
    const governance: MnemosyneEnvelope[] = [];
    if (titleChanged || tagsChanged || scopeChanged || sensitivityChanged || importanceChanged || attrs !== undefined) governance.push({ eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: by, event: { type: "attributes_set", memoryId: item.id, title, tags: [...nextAttrs.tags], scope: nextAttrs.scope, ...(nextAttrs.scope === "au" && nextAttrs.auId !== null ? { auId: nextAttrs.auId } : {}), sensitivity: nextAttrs.sensitivity, importance: nextAttrs.importance, sourceBasis: state.value.basis } });
    governance.push({ eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: by, event: { type: "provenance_set", memoryId: item.id, roles: { edited_by: by } } });
    if (decision !== undefined && decisionTargetDigest !== null) governance.push({ eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: by, event: { type: "policy_revision_recorded", memoryId: item.id, decisionId: decision.decisionId, targetDigest: decisionTargetDigest, sourceSha256: decision.sourceSha256, preconditionDigest: decision.preconditionDigest } });
    if (preparedCuration?.status === "ok") governance.push(preparedCuration.envelope);
    return this.commit("revise_policy_activated", item.id, [revised], governance, { by, source_basis: state.value.basis, evidence_kind: evidence.kind, title_changed: titleChanged, tags_changed: tagsChanged, scope_changed: scopeChanged, sensitivity_changed: sensitivityChanged, importance_changed: importanceChanged, attribute_patch_supplied: attrs !== undefined, ...(decision !== undefined && decisionTargetDigest !== null ? { decision_id: decision.decisionId, target_digest: decisionTargetDigest, source_sha256: decision.sourceSha256, precondition_digest: decision.preconditionDigest } : {}), ...(curationReceipt !== undefined ? { decision_set_id: curationReceipt.decisionSetId, curation_action: curationReceipt.action } : {}), token_estimate: estimateTokens(body) });
  }

  async reclassifyPolicyActivatedAu(memoryId: string, auId: string, by: "owner" | "companion", curationReceipt?: CurationDecisionReceiptRecord): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const item = this.store.getItem(memoryId); if (item === undefined) return { status: "refused", issues: [{ path: "memoryId", message: "no such card" }] };
    let preparedCuration: PreparedCurationReceipt | null = null; if (curationReceipt !== undefined) { if (curationReceipt.action !== "RECLASSIFY_AU" || curationReceipt.memoryId !== memoryId) return { status: "refused", issues: [{ path: "curationReceipt", message: "RECLASSIFY_AU receipt target mismatch" }] }; preparedCuration = this.prepareCurationDecisionReceipt(curationReceipt, by); if (preparedCuration.status === "refused") return preparedCuration; if (preparedCuration.status === "already") return preparedCuration; }
    const outcome = planPolicyActivatedAuReclassification({ card: policyAuReclassificationCard(item), auId, by, now: this.now() });
    if (outcome.status === "already") { if (preparedCuration?.status === "ok") return this.commit("reclassify_policy_activated_au_receipt", memoryId, [], [preparedCuration.envelope], { by, au_id: auId, decision_id: curationReceipt!.decisionId }); return { status: "already", detail: outcome.detail }; }
    if (outcome.status === "refused") return { status: "refused", issues: outcome.issues.map((issue) => ({ ...issue })) };
    const governance = [...outcome.plan.governance]; if (preparedCuration?.status === "ok") governance.push(preparedCuration.envelope);
    return this.commit("reclassify_policy_activated_au", memoryId, [], governance, { by, au_id: outcome.plan.auId, source_basis: outcome.plan.sourceBasis, ...(curationReceipt !== undefined ? { decision_id: curationReceipt.decisionId } : {}) });
  }

  async supersedePolicyActivated(sourceMemoryId: string, survivorMemoryId: string, by: "owner" | "companion", reason: string, curationReceipt?: CurationDecisionReceiptRecord): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const source = this.store.getItem(sourceMemoryId); if (source === undefined) return { status: "refused", issues: [{ path: "sourceMemoryId", message: "no such source card" }] }; const survivor = this.store.getItem(survivorMemoryId); if (survivor === undefined) return { status: "refused", issues: [{ path: "survivorMemoryId", message: "no such survivor card" }] };
    let preparedCuration: PreparedCurationReceipt | null = null; if (curationReceipt !== undefined) { if (curationReceipt.action !== "SUPERSEDE" || curationReceipt.memoryId !== sourceMemoryId) return { status: "refused", issues: [{ path: "curationReceipt", message: "SUPERSEDE receipt target mismatch" }] }; preparedCuration = this.prepareCurationDecisionReceipt(curationReceipt, by); if (preparedCuration.status !== "ok") return preparedCuration; }
    const outcome = planPolicyActivatedSupersede({ source: policyConsolidationCard(source), survivor: policyConsolidationCard(survivor), by, reason, now: this.now() }); if (outcome.status === "already") return { status: "already", detail: outcome.detail }; if (outcome.status === "refused") return { status: "refused", issues: outcome.issues.map((issue) => ({ ...issue })) };
    const governance = [...outcome.plan.governance]; if (preparedCuration?.status === "ok") governance.push(preparedCuration.envelope);
    return this.commit("supersede_policy_activated", sourceMemoryId, [...outcome.plan.kernel], governance, { by, source_memory_ids: [...outcome.plan.sourceMemoryIds], survivor_memory_id: outcome.plan.survivorMemoryId, ...(curationReceipt !== undefined ? { decision_id: curationReceipt.decisionId } : {}) });
  }

  async mergePolicyActivated(sourceMemoryIds: readonly string[], survivorMemoryId: string, by: "owner" | "companion", reason: string, curationReceipt?: CurationDecisionReceiptRecord): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const survivor = this.store.getItem(survivorMemoryId); if (survivor === undefined) return { status: "refused", issues: [{ path: "survivorMemoryId", message: "no such survivor card" }] }; const sources: GovernanceItemView[] = []; const missing: GovernanceIssue[] = [];
    sourceMemoryIds.forEach((memoryId, index) => { const source = this.store.getItem(memoryId); if (source === undefined) missing.push({ path: `sourceMemoryIds[${index}]`, message: "no such source card" }); else sources.push(source); }); if (missing.length > 0) return { status: "refused", issues: missing };
    let preparedCuration: PreparedCurationReceipt | null = null; if (curationReceipt !== undefined) { if (curationReceipt.action !== "MERGE" || (!sourceMemoryIds.includes(curationReceipt.memoryId) && curationReceipt.memoryId !== survivorMemoryId)) return { status: "refused", issues: [{ path: "curationReceipt", message: "MERGE receipt target is not a consolidation participant" }] }; preparedCuration = this.prepareCurationDecisionReceipt(curationReceipt, by); if (preparedCuration.status !== "ok") return preparedCuration; }
    const outcome = planPolicyActivatedMerge({ sources: sources.map(policyConsolidationCard), survivor: policyConsolidationCard(survivor), by, reason, now: this.now() }); if (outcome.status === "already") return { status: "already", detail: outcome.detail }; if (outcome.status === "refused") return { status: "refused", issues: outcome.issues.map((issue) => ({ ...issue })) };
    const governance = [...outcome.plan.governance]; if (preparedCuration?.status === "ok") governance.push(preparedCuration.envelope);
    return this.commit("merge_policy_activated", survivorMemoryId, [...outcome.plan.kernel], governance, { by, source_memory_ids: [...outcome.plan.sourceMemoryIds], survivor_memory_id: outcome.plan.survivorMemoryId, ...(curationReceipt !== undefined ? { decision_id: curationReceipt.decisionId } : {}) });
  }

  private async reviseKernel(op: "edit" | "revise", item: GovernanceItemView, newBody: string, humanAuthor: "owner" | "companion", newTitle: string | undefined, confirmWith: HumanActor | null, provenanceDelta?: ProvenanceRoles, attrs?: { scope: "global" | "relationship" | "project" | "au"; auId?: string; sensitivity?: "normal" | "sensitive" | "intimate" }): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const body = newBody.trim(); if (body.length === 0 || body.length > MAX_BODY_CHARS) return { status: "refused", issues: [{ path: "body", message: `replacement text must be 1..${MAX_BODY_CHARS} chars` }] }; const admission = assessUntrustedBody(body); if (!admission.ok) return { status: "refused", issues: [{ path: "body", message: admission.reason }] };
    const revised = { schemaVersion: 1, eventId: randomUUID(), occurredAt: this.now().toISOString(), event: { type: "memory_revised", memoryId: item.id, revisionId: randomUUID(), revisionKind: op === "revise" ? "correction" : "amendment", content: body, evidence: { kind: "user_statement", source: { kind: "manual_entry", manualEntryId: randomUUID() } }, scope: { kind: "shared" } } } as unknown as MemoryEventEnvelope;
    const governance: MnemosyneEnvelope[] = [];
    if ((newTitle !== undefined && newTitle.trim().length > 0) || attrs !== undefined) {
      if (newTitle !== undefined) { const titleAdmission = assessUntrustedBody(newTitle); if (!titleAdmission.ok) return { status: "refused", issues: [{ path: "title", message: titleAdmission.reason }] }; }
      const scope = attrs?.scope ?? (item.scope as "global" | "relationship" | "project" | "au"); const auId = attrs !== undefined ? attrs.auId : (item.au_id ?? undefined); if (scope === "au" && (auId === undefined || auId.length === 0)) return { status: "refused", issues: [{ path: "auId", message: "au scope requires an AU id" }] };
      governance.push({ eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: humanAuthor, event: { type: "attributes_set", memoryId: item.id, title: newTitle !== undefined && newTitle.trim().length > 0 ? newTitle.trim().slice(0, MAX_TITLE_CHARS) : item.title, tags: item.tags_text.split(" ").filter(Boolean), scope, ...(scope === "au" && auId !== undefined ? { auId } : {}), sensitivity: attrs?.sensitivity ?? (item.sensitivity as "normal" | "sensitive" | "intimate"), importance: item.importance as 1 | 2 | 3, sourceBasis: "explicit" } });
    }
    if (confirmWith !== null) governance.push({ eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: confirmWith === "both" ? "owner" : confirmWith, event: { type: "confirmed", memoryId: item.id, by: confirmWith } });
    if (provenanceDelta !== undefined && Object.keys(provenanceDelta).length > 0) governance.push({ eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: humanAuthor, event: { type: "provenance_set", memoryId: item.id, roles: { ...provenanceDelta } } });
    return this.commit(op, item.id, [revised], governance, { re_confirmed: confirmWith !== null, ...(provenanceDelta !== undefined ? { provenance_roles: { ...provenanceDelta } } : {}), token_estimate: estimateTokens(body) });
  }

  async reject(memoryId: string, by: "owner" | "companion", reason: string): Promise<GovernanceOutcome<GovernanceWriteReceipt>> { return this.terminate("reject", memoryId, by, reason, ["candidate"]); }
  async revoke(memoryId: string, by: "owner" | "companion", reason: string, curationReceipt?: CurationDecisionReceiptRecord): Promise<GovernanceOutcome<GovernanceWriteReceipt>> { return this.terminate("revoke", memoryId, by, reason, ["confirmed", "policy_activated"], curationReceipt); }
  async episodicOnlyPolicyActivated(memoryId: string, by: "owner" | "companion", reason: string, curationReceipt?: CurationDecisionReceiptRecord): Promise<GovernanceOutcome<GovernanceWriteReceipt>> { return this.terminate("episodic_only", memoryId, by, reason, ["policy_activated"], curationReceipt); }
  private async terminate(op: "reject" | "revoke" | "episodic_only", memoryId: string, by: "owner" | "companion", reason: string, requiredApproval: readonly string[], curationReceipt?: CurationDecisionReceiptRecord): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const item = this.store.getItem(memoryId); if (item === undefined) return { status: "refused", issues: [{ path: "memoryId", message: "no such card" }] }; if (item.lifecycle_state !== "active") return { status: "already", detail: `already ${item.lifecycle_state} — history preserved` }; if (!requiredApproval.includes(item.approval_state)) return { status: "refused", issues: [{ path: "memoryId", message: `${op} applies to ${requiredApproval.join("|")} cards; this one is ${item.approval_state}` }] };
    let preparedCuration: PreparedCurationReceipt | null = null; if (curationReceipt !== undefined) { const expectedAction = op === "episodic_only" ? "EPISODIC_ONLY" : op === "revoke" ? "REVOKE" : null; if (expectedAction === null || curationReceipt.action !== expectedAction || curationReceipt.memoryId !== memoryId) return { status: "refused", issues: [{ path: "curationReceipt", message: `${op} curation receipt target/action mismatch` }] }; preparedCuration = this.prepareCurationDecisionReceipt(curationReceipt, by); if (preparedCuration.status !== "ok") return preparedCuration; }
    const retrievalOff: MnemosyneEnvelope = { eventId: randomUUID(), occurredAt: this.now().toISOString(), actor: by, event: { type: "retrieval_set", memoryId, enabled: false } };
    const deactivated = { schemaVersion: 1, eventId: randomUUID(), occurredAt: this.now().toISOString(), event: { type: "memory_deactivated", memoryId, reason: `${op} by ${by} via governance channel: ${reason.slice(0, 200)}` } } as unknown as MemoryEventEnvelope;
    const governance = [retrievalOff]; if (preparedCuration?.status === "ok") governance.push(preparedCuration.envelope);
    return this.commit(op, memoryId, [deactivated], governance, { by, ...(curationReceipt !== undefined ? { decision_id: curationReceipt.decisionId, decision_set_id: curationReceipt.decisionSetId } : {}) });
  }

  listPending(): GovernanceItemView[] { return this.store.listItems().filter((item) => item.approval_state === "candidate" && item.lifecycle_state === "active").sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); }
  searchConfirmed(query: string, limit: number): GovernanceItemView[] { const hits = this.store.ftsSearch(query, Math.max(limit * 4, 12)); const out: GovernanceItemView[] = []; for (const hit of hits) { const item = this.store.getItem(hit.itemId); if (item !== undefined && (item.approval_state === "confirmed" || item.approval_state === "policy_activated") && item.lifecycle_state === "active") { out.push(item); if (out.length >= limit) break; } } return out; }
  getCard(memoryId: string): GovernanceItemView | undefined { return this.store.getItem(memoryId); }
  findActiveBySourceTurn(turnId: string): GovernanceItemView | undefined { if (turnId.length < 8) return undefined; for (const item of this.store.listItems()) { if (item.lifecycle_state !== "active") continue; const pointer = this.store.listSources("memory", item.id)[0]?.pointer ?? ""; if (pointer.includes(turnId)) return item; } return undefined; }
  findBySourceTurn(turnId: string): GovernanceItemView | undefined { if (turnId.length < 8) return undefined; for (const item of this.store.listItems()) { const pointer = this.store.listSources("memory", item.id)[0]?.pointer ?? ""; if (pointer.includes(turnId)) return item; } return undefined; }
  findByIdPrefix(prefix: string): GovernanceItemView | undefined { const clean = prefix.toLowerCase(); if (clean.length < 6) return undefined; const matches = this.store.listItems().filter((item) => item.id.startsWith(clean)); return matches.length === 1 ? matches[0] : undefined; }
  sourcePointer(memoryId: string): string | null { return this.store.listSources("memory", memoryId)[0]?.pointer ?? null; }

  private async commit(op: string, memoryId: string, kernel: MemoryEventEnvelope[], governance: MnemosyneEnvelope[], auditExtra: Record<string, unknown>): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const outcome = this.store.appendJoint(kernel, governance); if (outcome.status !== "appended") { this.audit({ type: "governance_write_rejected", op, memory_id: memoryId, issue_count: outcome.issues.length }); return { status: "refused", issues: outcome.issues }; }
    await this.store.rebuildProjections(); const eventIds = [...kernel.map((e) => e.eventId), ...governance.map((e) => e.eventId)]; let backup: { ok: boolean; detail: string };
    try { const report = this.backup(op); backup = { ok: true, detail: report.path }; }
    catch (error) { backup = { ok: false, detail: `write persisted but backup failed: ${error instanceof Error ? error.message : String(error)}` }; this.audit({ type: "governance_backup_failed", op, memory_id: memoryId, event_ids: eventIds, committed: true, retry_safe: true }); }
    this.audit({ type: "governance_write", op, memory_id: memoryId, event_ids: eventIds, committed: true, backup_ok: backup.ok, ...auditExtra });
    return { status: "ok", memoryId, eventIds, committed: true, backup, retrySafe: true };
  }
  retryBackup(): { ok: boolean; detail: string } { try { const report = this.backup("retry"); this.audit({ type: "governance_backup_retry", ok: true }); return { ok: true, detail: report.path }; } catch (error) { this.audit({ type: "governance_backup_retry", ok: false }); return { ok: false, detail: error instanceof Error ? error.message : String(error) }; } }
}
