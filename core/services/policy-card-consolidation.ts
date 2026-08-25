import { randomUUID } from "node:crypto";
import type { MemoryEventEnvelope } from "../domain/memory.js";
import type { MnemosyneEnvelope } from "../domain/mnemosyne.js";

/**
 * Pure planning contract for append-only policy-card consolidation.
 *
 * This module owns no store and performs no writes. It returns the exact
 * kernel/governance events that MnemosyneGovernanceService may commit in a
 * later integration slice. Keeping planning pure prevents a second mutation
 * authority while centralising SUPERSEDE / MERGE validation and replay rules.
 */

export type PolicyConsolidationActor = "owner" | "companion";

export interface PolicyConsolidationCard {
  readonly id: string;
  readonly approvalState: string;
  readonly lifecycleState: string;
  /** Projected replacement pointer when this record has been superseded. */
  readonly supersededByMemoryId: string | null;
  readonly sourceBasis: string | null;
  readonly confirmedBy: string | null;
}

export interface PolicyConsolidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface PolicyConsolidationPlan {
  readonly kernel: readonly MemoryEventEnvelope[];
  readonly governance: readonly MnemosyneEnvelope[];
  readonly sourceMemoryIds: readonly string[];
  readonly survivorMemoryId: string;
}

export type PolicyConsolidationOutcome =
  | { readonly status: "planned"; readonly plan: PolicyConsolidationPlan }
  | { readonly status: "already"; readonly detail: string }
  | { readonly status: "refused"; readonly issues: readonly PolicyConsolidationIssue[] };

function validToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim() &&
    !/[\r\n\u2028\u2029]/u.test(value)
  );
}

function validateSource(
  card: PolicyConsolidationCard,
  path: string,
): PolicyConsolidationIssue[] {
  const issues: PolicyConsolidationIssue[] = [];
  if (!validToken(card.id)) {
    issues.push({ path, message: "memory id must be a bounded single-line token" });
  }
  if (card.approvalState !== "policy_activated") {
    issues.push({ path, message: "source card must be policy_activated" });
  }
  if (card.lifecycleState !== "active") {
    issues.push({ path, message: "source card must be active before consolidation" });
  }
  if (card.sourceBasis !== "explicit" && card.sourceBasis !== "observed") {
    issues.push({ path, message: "source card must preserve explicit|observed evidence basis" });
  }
  if (card.confirmedBy !== null) {
    issues.push({ path, message: "policy-activated source must not carry individual confirmation" });
  }
  return issues;
}

function validateSurvivor(card: PolicyConsolidationCard): PolicyConsolidationIssue[] {
  const issues: PolicyConsolidationIssue[] = [];
  if (!validToken(card.id)) {
    issues.push({ path: "survivorMemoryId", message: "survivor id must be a bounded single-line token" });
  }
  if (card.lifecycleState !== "active") {
    issues.push({ path: "survivorMemoryId", message: "survivor card must be active" });
  }
  if (card.approvalState !== "policy_activated" && card.approvalState !== "confirmed") {
    issues.push({
      path: "survivorMemoryId",
      message: "survivor must already be retrieval-authorised (policy_activated|confirmed)",
    });
  }
  if (card.approvalState === "policy_activated") {
    if (card.sourceBasis !== "explicit" && card.sourceBasis !== "observed") {
      issues.push({
        path: "survivorMemoryId",
        message: "policy-activated survivor must preserve explicit|observed evidence basis",
      });
    }
    if (card.confirmedBy !== null) {
      issues.push({
        path: "survivorMemoryId",
        message: "policy-activated survivor must not carry individual confirmation",
      });
    }
  }
  return issues;
}

function boundedReason(reason: string): string | null {
  const clean = reason.trim();
  return clean.length > 0 && clean.length <= 200 ? clean : null;
}

function supersessionEvents(input: {
  readonly sourceMemoryId: string;
  readonly survivorMemoryId: string;
  readonly by: PolicyConsolidationActor;
  readonly reason: string;
  readonly nowIso: string;
}): { kernel: MemoryEventEnvelope; governance: MnemosyneEnvelope } {
  return {
    kernel: {
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: input.nowIso,
      event: {
        type: "memory_superseded",
        memoryId: input.sourceMemoryId,
        supersededByMemoryId: input.survivorMemoryId,
        reason: input.reason,
      },
    } as unknown as MemoryEventEnvelope,
    governance: {
      eventId: randomUUID(),
      occurredAt: input.nowIso,
      actor: input.by,
      event: {
        type: "provenance_set",
        memoryId: input.sourceMemoryId,
        roles: { edited_by: input.by },
      },
    },
  };
}

/**
 * Plan one governed record replacement. Retrying an already-completed exact
 * supersession is a no-op; a different terminal target is a hard conflict.
 */
export function planPolicyActivatedSupersede(input: {
  readonly source: PolicyConsolidationCard;
  readonly survivor: PolicyConsolidationCard;
  readonly by: PolicyConsolidationActor;
  readonly reason: string;
  readonly now?: Date;
}): PolicyConsolidationOutcome {
  if (input.source.id === input.survivor.id) {
    return {
      status: "refused",
      issues: [{ path: "survivorMemoryId", message: "a card cannot supersede itself" }],
    };
  }
  const reason = boundedReason(input.reason);
  if (reason === null) {
    return {
      status: "refused",
      issues: [{ path: "reason", message: "reason must be 1..200 non-whitespace characters" }],
    };
  }
  if (input.source.lifecycleState === "superseded") {
    if (input.source.supersededByMemoryId === input.survivor.id) {
      return { status: "already", detail: "source already superseded by this exact survivor" };
    }
    return {
      status: "refused",
      issues: [{ path: "sourceMemoryId", message: "source was already superseded by a different record" }],
    };
  }
  if (input.source.lifecycleState !== "active") {
    return {
      status: "refused",
      issues: [
        {
          path: "sourceMemoryId",
          message: `source is ${input.source.lifecycleState}; history is terminal`,
        },
      ],
    };
  }
  const issues = [
    ...validateSource(input.source, "sourceMemoryId"),
    ...validateSurvivor(input.survivor),
  ];
  if (issues.length > 0) return { status: "refused", issues };

  const nowIso = (input.now ?? new Date()).toISOString();
  const event = supersessionEvents({
    sourceMemoryId: input.source.id,
    survivorMemoryId: input.survivor.id,
    by: input.by,
    reason,
    nowIso,
  });
  return {
    status: "planned",
    plan: {
      kernel: [event.kernel],
      governance: [event.governance],
      sourceMemoryIds: [input.source.id],
      survivorMemoryId: input.survivor.id,
    },
  };
}

/**
 * Plan N→1 duplicate consolidation. Each source is retired with an independent
 * memory_superseded event while the survivor remains untouched. Sources already
 * superseded to the same survivor are skipped for crash/retry idempotence;
 * conflicting terminal history refuses the whole plan.
 */
export function planPolicyActivatedMerge(input: {
  readonly sources: readonly PolicyConsolidationCard[];
  readonly survivor: PolicyConsolidationCard;
  readonly by: PolicyConsolidationActor;
  readonly reason: string;
  readonly now?: Date;
}): PolicyConsolidationOutcome {
  if (input.sources.length === 0 || input.sources.length > 32) {
    return {
      status: "refused",
      issues: [{ path: "sourceMemoryIds", message: "merge requires 1..32 source cards" }],
    };
  }
  const reason = boundedReason(input.reason);
  if (reason === null) {
    return {
      status: "refused",
      issues: [{ path: "reason", message: "reason must be 1..200 non-whitespace characters" }],
    };
  }
  const ids = input.sources.map((card) => card.id);
  if (new Set(ids).size !== ids.length) {
    return {
      status: "refused",
      issues: [{ path: "sourceMemoryIds", message: "merge source ids must be unique" }],
    };
  }
  if (ids.includes(input.survivor.id)) {
    return {
      status: "refused",
      issues: [{ path: "survivorMemoryId", message: "survivor cannot also be a merge source" }],
    };
  }

  const issues = validateSurvivor(input.survivor);
  const activeSources: PolicyConsolidationCard[] = [];
  for (const [index, card] of input.sources.entries()) {
    if (card.lifecycleState === "superseded") {
      if (card.supersededByMemoryId === input.survivor.id) continue;
      issues.push({
        path: `sourceMemoryIds[${index}]`,
        message: "source was already superseded by a different record",
      });
      continue;
    }
    if (card.lifecycleState !== "active") {
      issues.push({
        path: `sourceMemoryIds[${index}]`,
        message: `source is ${card.lifecycleState}; history is terminal`,
      });
      continue;
    }
    issues.push(...validateSource(card, `sourceMemoryIds[${index}]`));
    activeSources.push(card);
  }
  if (issues.length > 0) return { status: "refused", issues };
  if (activeSources.length === 0) {
    return { status: "already", detail: "all merge sources already point to this exact survivor" };
  }

  const nowIso = (input.now ?? new Date()).toISOString();
  const kernel: MemoryEventEnvelope[] = [];
  const governance: MnemosyneEnvelope[] = [];
  for (const source of activeSources) {
    const event = supersessionEvents({
      sourceMemoryId: source.id,
      survivorMemoryId: input.survivor.id,
      by: input.by,
      reason,
      nowIso,
    });
    kernel.push(event.kernel);
    governance.push(event.governance);
  }
  return {
    status: "planned",
    plan: {
      kernel,
      governance,
      sourceMemoryIds: activeSources.map((card) => card.id),
      survivorMemoryId: input.survivor.id,
    },
  };
}
