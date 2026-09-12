import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { foldMemoryEvents } from "../core/domain/memory-fold.js";
import type { MemoryEventEnvelope } from "../core/domain/memory.js";
import { asManualEntryId, asMemoryEventId, asMemoryId } from "../core/domain/ids.js";
import { validateMnemosyneStream } from "../core/domain/mnemosyne.js";
import { encodeDurableSemanticCenterMergeReason } from "../core/policies/durable-semantic-center.js";
import {
  planPolicyActivatedMerge,
  planPolicyActivatedSupersede,
  type PolicyConsolidationCard,
} from "../core/services/policy-card-consolidation.js";

function card(
  id: string = randomUUID(),
  overrides: Partial<PolicyConsolidationCard> = {},
): PolicyConsolidationCard {
  return {
    id,
    approvalState: "policy_activated",
    lifecycleState: "active",
    supersededByMemoryId: null,
    sourceBasis: "explicit",
    confirmedBy: null,
    ...overrides,
  };
}

function created(memoryId: string, content: string): MemoryEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: asMemoryEventId(randomUUID()),
    occurredAt: "2026-08-26T00:00:00.000Z",
    event: {
      type: "memory_created",
      memoryId: asMemoryId(memoryId),
      content,
      evidence: {
        kind: "user_statement",
        source: { kind: "manual_entry", manualEntryId: asManualEntryId(randomUUID()) },
      },
      scope: { kind: "shared" },
    },
  };
}

function supersededEvent(source: string, survivor: string): MemoryEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: asMemoryEventId(randomUUID()),
    occurredAt: "2026-08-26T00:00:00.000Z",
    event: {
      type: "memory_superseded",
      memoryId: asMemoryId(source),
      supersededByMemoryId: asMemoryId(survivor),
      reason: "synthetic prior merge",
    },
  };
}

function mergeReason(rationale: string): string {
  return encodeDurableSemanticCenterMergeReason("duplicate", rationale);
}

test("policy-card supersede is append-only, exact-target idempotent, and survivor-safe", () => {
  const source = card();
  const survivor = card();
  const outcome = planPolicyActivatedSupersede({
    source,
    survivor,
    by: "owner",
    reason: "duplicate record consolidated from exact synthetic evidence",
    now: new Date("2026-08-26T00:00:00.000Z"),
  });
  assert.equal(outcome.status, "planned");
  if (outcome.status !== "planned") return;

  assert.equal(outcome.plan.kernel.length, 1);
  assert.equal(outcome.plan.governance.length, 1);
  const kernel = outcome.plan.kernel[0]!;
  assert.equal(kernel.event.type, "memory_superseded");
  if (kernel.event.type === "memory_superseded") {
    assert.equal(kernel.event.memoryId, source.id);
    assert.equal(kernel.event.supersededByMemoryId, survivor.id);
  }
  const governance = outcome.plan.governance[0]!;
  assert.equal(governance.actor, "owner");
  assert.equal(governance.event.type, "provenance_set");
  if (governance.event.type === "provenance_set") {
    assert.equal(governance.event.memoryId, source.id);
    assert.equal(governance.event.roles.edited_by, "owner");
  }
  assert.equal(validateMnemosyneStream(outcome.plan.governance).ok, true);

  const folded = foldMemoryEvents([
    created(source.id, "synthetic duplicate source"),
    created(survivor.id, "synthetic surviving record"),
    ...outcome.plan.kernel,
  ]);
  const sourceState = folded.records.find((record) => record.memoryId === source.id)!;
  const survivorState = folded.records.find((record) => record.memoryId === survivor.id)!;
  assert.equal(sourceState.lifecycle, "superseded");
  assert.equal(sourceState.supersededByMemoryId, survivor.id);
  assert.equal(survivorState.lifecycle, "active");
  assert.deepEqual(folded.current.map((record) => record.memoryId), [survivor.id]);

  const retry = planPolicyActivatedSupersede({
    source: card(source.id, {
      lifecycleState: "superseded",
      supersededByMemoryId: survivor.id,
    }),
    survivor,
    by: "owner",
    reason: "same exact reviewed consolidation",
  });
  assert.equal(retry.status, "already");

  const conflictingTarget = card();
  const conflict = planPolicyActivatedSupersede({
    source: card(source.id, {
      lifecycleState: "superseded",
      supersededByMemoryId: survivor.id,
    }),
    survivor: conflictingTarget,
    by: "owner",
    reason: "must not rewrite terminal history",
  });
  assert.equal(conflict.status, "refused");

  const candidateTarget = planPolicyActivatedSupersede({
    source: card(),
    survivor: card(randomUUID(), { approvalState: "candidate" }),
    by: "owner",
    reason: "candidate cannot silently become canonical survivor",
  });
  assert.equal(candidateTarget.status, "refused");
});

test("policy-card merge requires one durable semantic center and rejects category-only consolidation", () => {
  const survivor = card();
  const sourceA = card();
  const sourceB = card(randomUUID(), { sourceBasis: "observed" });

  const categoryOnly = planPolicyActivatedMerge({
    sources: [sourceA, sourceB],
    survivor,
    by: "owner",
    reason: "all three cards are media preferences so they should share one card",
  });
  assert.equal(categoryOnly.status, "refused");
  if (categoryOnly.status === "refused") {
    assert.equal(categoryOnly.issues.some((issue) => issue.path === "mergeSemanticRelation"), true);
  }

  const typed = planPolicyActivatedMerge({
    sources: [sourceA, sourceB],
    survivor,
    by: "owner",
    reason: encodeDurableSemanticCenterMergeReason(
      "strict_subsumption",
      "survivor contains the same durable fact without absorbing an independent preference",
    ),
  });
  assert.equal(typed.status, "planned");
  if (typed.status === "planned") {
    assert.equal(typed.plan.mergeSemanticRelation, "strict_subsumption");
    assert.equal(
      typed.plan.kernel.every(
        (event) =>
          event.event.type === "memory_superseded" &&
          typeof event.event.reason === "string" &&
          event.event.reason.startsWith("[semantic-center:strict_subsumption]"),
      ),
      true,
    );
  }
});

test("policy-card merge plans only unfinished N-to-1 sources and fails closed on conflicts", () => {
  const survivor = card();
  const sourceA = card();
  const sourceB = card(randomUUID(), { sourceBasis: "observed" });
  const sourceAlready = card(randomUUID(), {
    lifecycleState: "superseded",
    supersededByMemoryId: survivor.id,
  });

  const outcome = planPolicyActivatedMerge({
    sources: [sourceA, sourceB, sourceAlready],
    survivor,
    by: "companion",
    reason: mergeReason("three synthetic records are duplicate statements of one durable memory"),
    now: new Date("2026-08-26T00:00:00.000Z"),
  });
  assert.equal(outcome.status, "planned");
  if (outcome.status !== "planned") return;
  assert.deepEqual(outcome.plan.sourceMemoryIds, [sourceA.id, sourceB.id]);
  assert.equal(outcome.plan.mergeSemanticRelation, "duplicate");
  assert.equal(outcome.plan.kernel.length, 2);
  assert.equal(outcome.plan.governance.length, 2);
  assert.equal(outcome.plan.governance.every((event) => event.actor === "companion"), true);
  assert.equal(validateMnemosyneStream(outcome.plan.governance).ok, true);

  const folded = foldMemoryEvents([
    created(sourceA.id, "synthetic merge source A"),
    created(sourceB.id, "synthetic merge source B"),
    created(sourceAlready.id, "synthetic prior source"),
    created(survivor.id, "synthetic merge survivor"),
    supersededEvent(sourceAlready.id, survivor.id),
    ...outcome.plan.kernel,
  ]);
  assert.equal(
    folded.records
      .filter((record) => record.memoryId !== survivor.id)
      .every(
        (record) =>
          record.lifecycle === "superseded" && record.supersededByMemoryId === survivor.id,
      ),
    true,
  );
  assert.deepEqual(folded.current.map((record) => record.memoryId), [survivor.id]);

  const completeRetry = planPolicyActivatedMerge({
    sources: [
      card(sourceA.id, { lifecycleState: "superseded", supersededByMemoryId: survivor.id }),
      card(sourceB.id, { lifecycleState: "superseded", supersededByMemoryId: survivor.id }),
    ],
    survivor,
    by: "owner",
    reason: "legacy pre-policy completed merge retry",
  });
  assert.equal(completeRetry.status, "already");

  const otherTarget = card();
  const conflict = planPolicyActivatedMerge({
    sources: [
      card(sourceA.id, { lifecycleState: "superseded", supersededByMemoryId: otherTarget.id }),
      sourceB,
    ],
    survivor,
    by: "owner",
    reason: mergeReason("conflicting historical target must stop the duplicate merge"),
  });
  assert.equal(conflict.status, "refused");

  const duplicateInput = planPolicyActivatedMerge({
    sources: [sourceA, sourceA],
    survivor,
    by: "owner",
    reason: mergeReason("duplicate source ids are not a valid duplicate merge set"),
  });
  assert.equal(duplicateInput.status, "refused");
});
