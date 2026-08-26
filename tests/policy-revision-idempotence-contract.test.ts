import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { MemoryCreationEvidence } from "../core/domain/memory.js";
import { asManualEntryId } from "../core/domain/ids.js";
import {
  policyRevisionPreconditionDigest,
  policyRevisionTargetDigest,
  validatePolicyRevisionDecision,
  type PolicyRevisionDecision,
  type PolicyRevisionProjectedState,
  type PolicyRevisionTarget,
} from "../core/services/policy-revision-idempotence.js";

function explicitEvidence(): MemoryCreationEvidence {
  return {
    kind: "user_statement",
    source: {
      kind: "manual_entry",
      manualEntryId: asManualEntryId(randomUUID()),
    },
  };
}

function projectedState(overrides: Partial<PolicyRevisionProjectedState> = {}): PolicyRevisionProjectedState {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    body: "Synthetic durable statement.",
    title: "Synthetic title",
    tags: ["synthetic", "stable"],
    scope: "relationship",
    auId: null,
    sensitivity: "normal",
    importance: 2,
    approvalState: "policy_activated",
    lifecycleState: "active",
    sourceBasis: "explicit",
    provenance: { source_basis: "explicit", edited_by: "owner" },
    ...overrides,
  };
}

function decision(preconditionDigest: string, overrides: Partial<PolicyRevisionDecision> = {}): PolicyRevisionDecision {
  return {
    decisionId: "synthetic-review-decision-0001",
    sourceSha256: "a".repeat(64),
    preconditionDigest,
    ...overrides,
  };
}

function target(evidence: MemoryCreationEvidence, overrides: Partial<PolicyRevisionTarget> = {}): PolicyRevisionTarget {
  return {
    memoryId: "11111111-1111-4111-8111-111111111111",
    body: "Synthetic corrected durable statement.",
    title: "Synthetic corrected title",
    tags: ["synthetic", "corrected"],
    scope: "project",
    auId: null,
    sensitivity: "sensitive",
    importance: 3,
    evidence,
    sourceBasis: "explicit",
    ...overrides,
  };
}

test("policy revision decision identity fails closed on malformed ids and hashes", () => {
  const precondition = policyRevisionPreconditionDigest(projectedState());
  assert.deepEqual(validatePolicyRevisionDecision(decision(precondition)), { ok: true });

  assert.equal(validatePolicyRevisionDecision(decision(precondition, { decisionId: " padded " })).ok, false);
  assert.equal(validatePolicyRevisionDecision(decision(precondition, { sourceSha256: "A".repeat(64) })).ok, false);
  assert.equal(validatePolicyRevisionDecision(decision(precondition, { preconditionDigest: "0".repeat(63) })).ok, false);
});

test("precondition digest is canonical but binds every frozen retrieval state", () => {
  const first = projectedState({
    provenance: { source_basis: "explicit", edited_by: "owner" },
  });
  const reordered = projectedState({
    provenance: { edited_by: "owner", source_basis: "explicit" },
  });
  const baseline = policyRevisionPreconditionDigest(first);
  assert.equal(policyRevisionPreconditionDigest(reordered), baseline);

  assert.notEqual(
    policyRevisionPreconditionDigest(projectedState({ tags: ["synthetic", "changed"] })),
    baseline,
  );
  assert.notEqual(
    policyRevisionPreconditionDigest(projectedState({ approvalState: "candidate" })),
    baseline,
  );
  assert.notEqual(
    policyRevisionPreconditionDigest(projectedState({ sourceBasis: "observed" })),
    baseline,
  );
});

test("target digest binds frozen source identity and replacement metadata", () => {
  const evidence = explicitEvidence();
  const precondition = policyRevisionPreconditionDigest(projectedState());
  const reviewed = decision(precondition);
  const baseline = policyRevisionTargetDigest(reviewed, target(evidence));

  assert.notEqual(
    policyRevisionTargetDigest(reviewed, target(evidence, { tags: ["synthetic", "different"] })),
    baseline,
  );
  assert.notEqual(
    policyRevisionTargetDigest(
      decision(precondition, { sourceSha256: "b".repeat(64) }),
      target(evidence),
    ),
    baseline,
  );
  assert.notEqual(
    policyRevisionTargetDigest(reviewed, target(explicitEvidence())),
    baseline,
  );
});
