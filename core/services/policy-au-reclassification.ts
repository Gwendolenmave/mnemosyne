import { randomUUID } from "node:crypto";
import type { MnemosyneEnvelope } from "../domain/mnemosyne.js";

/**
 * Pure planning contract for exact AU reclassification of an active
 * policy-activated card.
 *
 * This module owns no store and performs no writes. It preserves the card's
 * body/evidence/approval axis by emitting governance-only events for the
 * existing MnemosyneGovernanceService to commit in a later integration slice.
 * AU identity is accepted only as an exact canonical slug; no fuzzy matching,
 * normalization, keyword inference, or host-specific scene lookup occurs here.
 */

export type PolicyAuReclassificationActor = "owner" | "companion";
export type PolicyAuReclassificationBasis = "explicit" | "observed";
export type PolicyAuReclassificationScope = "global" | "relationship" | "project" | "au";
export type PolicyAuReclassificationSensitivity = "normal" | "sensitive" | "intimate";

export interface PolicyAuReclassificationCard {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly approvalState: string;
  readonly lifecycleState: string;
  readonly sourceBasis: string | null;
  /** Canonical evidence axis derived from stored provenance; null is legacy/unknown. */
  readonly provenanceSourceBasis: string | null;
  readonly confirmedBy: string | null;
  readonly scope: string;
  readonly auId: string | null;
  readonly sensitivity: string;
  readonly importance: number;
}

export interface PolicyAuReclassificationIssue {
  readonly path: string;
  readonly message: string;
}

export interface PolicyAuReclassificationPlan {
  readonly governance: readonly MnemosyneEnvelope[];
  readonly memoryId: string;
  readonly auId: string;
  readonly sourceBasis: PolicyAuReclassificationBasis;
}

export type PolicyAuReclassificationOutcome =
  | { readonly status: "planned"; readonly plan: PolicyAuReclassificationPlan }
  | { readonly status: "already"; readonly detail: string }
  | { readonly status: "refused"; readonly issues: readonly PolicyAuReclassificationIssue[] };

/**
 * Portable public contract for an exact AU identity. It intentionally mirrors
 * the host's canonical slug shape without importing a host/runtime scene port.
 */
export const CANONICAL_AU_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

function validToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim() &&
    !/[\r\n\u2028\u2029]/u.test(value)
  );
}

function validateCard(card: PolicyAuReclassificationCard): {
  issues: PolicyAuReclassificationIssue[];
  basis: PolicyAuReclassificationBasis | null;
  scope: PolicyAuReclassificationScope | null;
  sensitivity: PolicyAuReclassificationSensitivity | null;
  importance: 1 | 2 | 3 | null;
} {
  const issues: PolicyAuReclassificationIssue[] = [];
  if (!validToken(card.id)) {
    issues.push({ path: "memoryId", message: "memory id must be a bounded single-line token" });
  }
  if (card.approvalState !== "policy_activated") {
    issues.push({ path: "memoryId", message: "card must be policy_activated" });
  }
  if (card.lifecycleState !== "active") {
    issues.push({ path: "memoryId", message: "card must be active before AU reclassification" });
  }
  const basis =
    card.sourceBasis === "explicit" || card.sourceBasis === "observed" ? card.sourceBasis : null;
  if (basis === null) {
    issues.push({
      path: "sourceBasis",
      message: "policy-card AU reclassification requires explicit|observed evidence basis",
    });
  }
  if (
    basis !== null &&
    card.provenanceSourceBasis !== null &&
    card.provenanceSourceBasis !== basis
  ) {
    issues.push({
      path: "provenance.source_basis",
      message: "projected evidence basis conflicts with provenance; AU reclassification refused",
    });
  }
  if (card.confirmedBy !== null) {
    issues.push({
      path: "confirmedBy",
      message: "policy-activated card must not carry individual confirmation",
    });
  }
  if (card.title.length === 0 || card.title.length > 120 || card.title !== card.title.trim()) {
    issues.push({ path: "title", message: "title must be a trimmed 1..120 character string" });
  }
  if (
    !Array.isArray(card.tags) ||
    card.tags.some(
      (tag) =>
        typeof tag !== "string" ||
        tag.length === 0 ||
        tag.length > 80 ||
        tag !== tag.trim() ||
        /\s/u.test(tag),
    ) ||
    new Set(card.tags).size !== card.tags.length
  ) {
    issues.push({ path: "tags", message: "tags must be unique trimmed non-whitespace tokens" });
  }
  const scope =
    card.scope === "global" ||
    card.scope === "relationship" ||
    card.scope === "project" ||
    card.scope === "au"
      ? card.scope
      : null;
  if (scope === null) {
    issues.push({ path: "scope", message: "policy-card AU reclassification refuses non-durable scope" });
  }
  if (scope === "au" && (card.auId === null || !CANONICAL_AU_ID_PATTERN.test(card.auId))) {
    issues.push({ path: "auId", message: "existing AU scope is missing a canonical AU id" });
  }
  const sensitivity =
    card.sensitivity === "normal" ||
    card.sensitivity === "sensitive" ||
    card.sensitivity === "intimate"
      ? card.sensitivity
      : null;
  if (sensitivity === null) {
    issues.push({ path: "sensitivity", message: "invalid sensitivity" });
  }
  const importance =
    card.importance === 1 || card.importance === 2 || card.importance === 3
      ? card.importance
      : null;
  if (importance === null) {
    issues.push({ path: "importance", message: "importance must be 1..3" });
  }
  return { issues, basis, scope, sensitivity, importance };
}

/**
 * Plan one governance-only AU classification change. Exact replay to the same
 * AU is a no-op. Moving from one reviewed AU slug to another is allowed only
 * when the caller supplies the exact replacement slug; the planner never
 * derives or normalizes that identity.
 */
export function planPolicyActivatedAuReclassification(input: {
  readonly card: PolicyAuReclassificationCard;
  readonly auId: string;
  readonly by: PolicyAuReclassificationActor;
  readonly now?: Date;
}): PolicyAuReclassificationOutcome {
  const state = validateCard(input.card);
  const issues = [...state.issues];
  if (!CANONICAL_AU_ID_PATTERN.test(input.auId)) {
    issues.push({ path: "auId", message: "AU id must be an exact canonical slug" });
  }
  if (
    issues.length > 0 ||
    state.basis === null ||
    state.scope === null ||
    state.sensitivity === null ||
    state.importance === null
  ) {
    return { status: "refused", issues };
  }
  if (input.card.scope === "au" && input.card.auId === input.auId) {
    return { status: "already", detail: "card already has this exact AU classification" };
  }

  const nowIso = (input.now ?? new Date()).toISOString();
  const governance: MnemosyneEnvelope[] = [
    {
      eventId: randomUUID(),
      occurredAt: nowIso,
      actor: input.by,
      event: {
        type: "attributes_set",
        memoryId: input.card.id,
        title: input.card.title,
        tags: [...input.card.tags],
        scope: "au",
        auId: input.auId,
        sensitivity: state.sensitivity,
        importance: state.importance,
        sourceBasis: state.basis,
      },
    },
    {
      eventId: randomUUID(),
      occurredAt: nowIso,
      actor: input.by,
      event: {
        type: "provenance_set",
        memoryId: input.card.id,
        roles: { edited_by: input.by },
      },
    },
  ];

  return {
    status: "planned",
    plan: {
      governance,
      memoryId: input.card.id,
      auId: input.auId,
      sourceBasis: state.basis,
    },
  };
}
