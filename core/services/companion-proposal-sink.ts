/**
 * CompanionProposalSink: the ONLY surface the Companion proposal machinery may
 * touch. Structurally narrow — it can create a pending proposal and
 * revise Companion's own pending proposal, and NOTHING else: no approve, no
 * retrievability, no revise/revoke of confirmed cards, no priors, no
 * seals. Confirmation authority stays with the owner channel (Owner's
 * File it → confirmed event); quarantine runs inside the governance
 * service exactly as for every other proposal.
 *
 * Dedup contract (review clarification #2): at most one completed
 * proposal decision per source turn — any existing card whose evidence
 * carries the source turnId blocks a second proposal, and a normalized
 * exact-body duplicate among pending Companion proposals is refused as
 * "duplicate" rather than written twice.
 */

import type {
  GovernanceItemView,
  MnemosyneGovernanceService,
  ProposalEvidence,
} from "./mnemosyne-governance.js";
import { parseProvenance } from "./mnemosyne-governance.js";
import type { ProvenanceRoles } from "../domain/mnemosyne.js";

export interface CompanionPendingProposalInput {
  body: string;
  title?: string;
  /** Retrieval terms (summary-rule card shape): 2–5 tags/aliases. */
  tags?: string[];
  scope: "global" | "relationship" | "project" | "au";
  auId?: string;
  sensitivity: "normal" | "sensitive" | "intimate";
  /** Transcript grounding of the source turn (verified by the caller). */
  evidence: ProposalEvidence;
  /**
   * Workflow roles for this proposal. authored_by/proposed_by are forced
   * to "companion" here regardless of input — this sink cannot claim
   * anyone else's authorship.
   */
  provenance: ProvenanceRoles;
}

export type SinkOutcome =
  | { status: "ok"; memoryId: string }
  | { status: "duplicate"; existingId: string }
  | { status: "refused"; detail: string };

/** D0 owner-policy activation payload carried by the sink. */
export interface SinkActivation {
  policyId: string;
  sourceBasis: "explicit" | "observed";
  generator: string;
}

export interface CompanionProposalSink {
  proposePending(input: CompanionPendingProposalInput): Promise<SinkOutcome>;
  reviseOwnPending(memoryId: string, newBody: string): Promise<SinkOutcome>;
  /**
   * D0: create AND activate a card under a durable owner policy in one
   * transaction. Same dedup contract as proposePending; still narrow —
   * no confirm, no retrievability toggles, no priors, no seals.
   */
  proposeActivated(
    input: CompanionPendingProposalInput & {
      activation: SinkActivation;
      expiresAt?: string;
      supersedes?: { memoryId: string; reason: string };
    },
  ): Promise<SinkOutcome>;
  /**
   * D0 §6.3: activate an existing active Companion-authored candidate under
   * the owner policy (five-pending reconciliation). Refuses anything
   * that is not an active Companion-authored candidate.
   */
  activateOwnPending(
    memoryId: string,
    activation: SinkActivation,
    expiresAt?: string,
  ): Promise<SinkOutcome>;
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export class GovernedCompanionProposalSink implements CompanionProposalSink {
  constructor(private readonly service: MnemosyneGovernanceService) {}

  private pendingCompanionCards(): GovernanceItemView[] {
    return this.service
      .listPending()
      .filter((item) => parseProvenance(item)?.authored_by === "companion");
  }

  async proposePending(input: CompanionPendingProposalInput): Promise<SinkOutcome> {
    // One decision per source turn: any card grounded in this turn wins.
    if (input.evidence.kind === "transcript") {
      const existing = this.service.findActiveBySourceTurn(input.evidence.turnId);
      if (existing !== undefined) {
        return { status: "duplicate", existingId: existing.id };
      }
    }
    const body = normalized(input.body);
    for (const pending of this.pendingCompanionCards()) {
      if (normalized(pending.body) === body) {
        return { status: "duplicate", existingId: pending.id };
      }
    }
    const outcome = await this.service.propose({
      body: input.body,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
      scope: input.scope,
      ...(input.auId !== undefined ? { auId: input.auId } : {}),
      sensitivity: input.sensitivity,
      importance: 2,
      evidence: input.evidence,
      proposedBy: "companion",
      // The executing process is the machine, not a human hand
      // (clarification #3); authorship truth is the roles below.
      executionActor: "system",
      provenance: { ...input.provenance, proposed_by: "companion", authored_by: "companion" },
    });
    if (outcome.status === "ok") {
      return { status: "ok", memoryId: outcome.memoryId };
    }
    if (outcome.status === "refused") {
      return {
        status: "refused",
        detail: outcome.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      };
    }
    return { status: "refused", detail: outcome.detail };
  }

  async proposeActivated(
    input: CompanionPendingProposalInput & {
      activation: SinkActivation;
      expiresAt?: string;
      supersedes?: { memoryId: string; reason: string };
    },
  ): Promise<SinkOutcome> {
    // Same at-most-one-decision-per-source-turn contract as proposePending.
    if (input.evidence.kind === "transcript") {
      const existing = this.service.findActiveBySourceTurn(input.evidence.turnId);
      if (existing !== undefined) {
        return { status: "duplicate", existingId: existing.id };
      }
    }
    const body = normalized(input.body);
    for (const pending of this.pendingCompanionCards()) {
      if (normalized(pending.body) === body) {
        return { status: "duplicate", existingId: pending.id };
      }
    }
    const outcome = await this.service.proposeUnderPolicy({
      body: input.body,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
      scope: input.scope,
      ...(input.auId !== undefined ? { auId: input.auId } : {}),
      sensitivity: input.sensitivity,
      importance: 2,
      evidence: input.evidence,
      proposedBy: "companion",
      executionActor: "system",
      provenance: { ...input.provenance, proposed_by: "companion", authored_by: "companion" },
      activation: input.activation,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    });
    if (outcome.status === "ok") {
      return { status: "ok", memoryId: outcome.memoryId };
    }
    if (outcome.status === "refused") {
      return {
        status: "refused",
        detail: outcome.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      };
    }
    return { status: "refused", detail: outcome.detail };
  }

  async activateOwnPending(
    memoryId: string,
    activation: SinkActivation,
    expiresAt?: string,
  ): Promise<SinkOutcome> {
    const card = this.service.getCard(memoryId);
    if (
      card === undefined ||
      card.approval_state !== "candidate" ||
      card.lifecycle_state !== "active" ||
      parseProvenance(card)?.authored_by !== "companion"
    ) {
      return { status: "refused", detail: "not an active pending Companion proposal" };
    }
    const outcome = await this.service.activateExistingUnderPolicy(memoryId, activation, expiresAt);
    if (outcome.status === "ok") {
      return { status: "ok", memoryId };
    }
    if (outcome.status === "refused") {
      return {
        status: "refused",
        detail: outcome.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      };
    }
    return { status: "refused", detail: outcome.detail };
  }

  async reviseOwnPending(memoryId: string, newBody: string): Promise<SinkOutcome> {
    const card = this.service.getCard(memoryId);
    if (
      card === undefined ||
      card.approval_state !== "candidate" ||
      card.lifecycle_state !== "active" ||
      parseProvenance(card)?.authored_by !== "companion"
    ) {
      return { status: "refused", detail: "not an active pending Companion proposal" };
    }
    const outcome = await this.service.editPending(memoryId, newBody, "companion");
    if (outcome.status === "ok") {
      return { status: "ok", memoryId };
    }
    if (outcome.status === "refused") {
      return {
        status: "refused",
        detail: outcome.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      };
    }
    return { status: "refused", detail: outcome.detail };
  }
}
