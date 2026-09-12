import assert from "node:assert/strict";
import test from "node:test";
import {
  MUSE_NAMES,
  assertNotMuseTrace,
  principalId,
  PrincipalRegistry,
  syntheticPrincipalRegistry,
} from "../index.js";
import {
  composeMuseSignals,
  memoryCandidateIntentFromComposition,
  retrievalIntentFromComposition,
} from "../core/services/musagetes.js";
import { defineOwnerAutoMemoryPolicy } from "../adapters/automation/decision-worker.js";

test("the public ontology contains exactly the nine canonical Muses", () => {
  assert.deepEqual(MUSE_NAMES, [
    "Calliope", "Clio", "Erato", "Euterpe", "Melpomene",
    "Polyhymnia", "Terpsichore", "Thalia", "Urania",
  ]);
});

test("Musagetes composes multiple lenses instead of selecting one class", () => {
  const composition = composeMuseSignals([
    { muse: "Clio", weight: 0.7, confidence: 0.8, tags: ["history"], traceId: "trace-1" },
    { muse: "Urania", weight: 0.9, confidence: 0.9, tags: ["systems"], traceId: "trace-2" },
    { muse: "Clio", weight: 0.4, confidence: 1, tags: ["lower duplicate"], traceId: "trace-3" },
    { muse: "Thalia", weight: 0.01, confidence: 1, tags: ["below floor"], traceId: "trace-4" },
  ], { mode: "ordinary" }, "2099-01-01T00:00:00.000Z");
  assert.deepEqual(composition.active.map((signal) => signal.muse), ["Urania", "Clio"]);
});

test("Musagetes emits bounded Anamnesis and Mnemosyne intents without trace payloads", () => {
  const composition = composeMuseSignals([
    { muse: "Erato", weight: 0.8, confidence: 0.7, tags: ["relationship"], traceId: "trace-1" },
    { muse: "Euterpe", weight: 0.6, confidence: 0.7, tags: ["voice"], traceId: "trace-2" },
  ], { mode: "intimate", realm: "reality" }, "2099-01-01T00:00:00.000Z");
  const retrieval = retrievalIntentFromComposition(composition, {
    query: "synthetic recall",
    sensitivityCeiling: "intimate",
    maxItems: 4.8,
    maxTokens: 900.2,
  });
  assert.deepEqual(retrieval.activeMuses, ["Erato", "Euterpe"]);
  assert.deepEqual(retrieval.budget, { maxItems: 4, maxTokens: 900 });
  const candidate = memoryCandidateIntentFromComposition(composition, {
    conversationId: "conversation-1",
    turnId: "turn-1",
    contentSha256: "a".repeat(64),
  });
  assert.equal(candidate.action, "consider");
  assert.equal(JSON.stringify(candidate).includes("trace-"), false);
});

test("Muse evaluation traces are structurally refused as memory evidence", () => {
  assert.throws(
    () => assertNotMuseTrace({ kind: "muse_trace", traceId: "trace-1" }),
    /cannot become memory evidence/,
  );
  assert.doesNotThrow(() => assertNotMuseTrace({ kind: "user_statement" }));
});

test("principal registry maps deployment ids to stable roles and capabilities", () => {
  const registry = syntheticPrincipalRegistry();
  assert.equal(registry.canonicalActor(principalId("owner")), "owner");
  assert.equal(registry.hasCapability(principalId("owner"), "register_owner_policy"), true);
  assert.equal(registry.hasCapability(principalId("system"), "confirm"), false);
  assert.equal(registry.hasCapability(principalId("companion"), "confirm"), true);
  assert.throws(() => registry.requireCapability(principalId("system"), "seal"), /not authorized/);
});

test("principal ids and role bindings fail closed", () => {
  assert.throws(() => principalId(""), /portable identifier/);
  const id = principalId("same-id");
  assert.throws(() => new PrincipalRegistry([
    { id, roles: ["owner"] },
    { id, roles: ["system"] },
  ]), /duplicate principal/);
});

test("automatic activation policy is deployment supplied and digest pinned", () => {
  const policy = defineOwnerAutoMemoryPolicy({
    policyId: "synthetic-owner-policy-v1",
    authority: "owner_global_policy",
    effectiveFrom: "2099-01-01T00:00:00.000Z",
    manualPerCardApprovalRequired: false,
    ownerCanViewEditRevoke: true,
    authorityRef: `sha256:${"a".repeat(64)}`,
  });
  assert.equal(policy.policyId, "synthetic-owner-policy-v1");
  assert.throws(() => defineOwnerAutoMemoryPolicy({
    ...policy,
    authorityRef: "sha256:short",
  }), /full sha256/);
});
