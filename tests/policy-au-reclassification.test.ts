import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { validateMnemosyneStream } from "../core/domain/mnemosyne.js";
import {
  planPolicyActivatedAuReclassification,
  type PolicyAuReclassificationCard,
} from "../core/services/policy-au-reclassification.js";

function card(
  overrides: Partial<PolicyAuReclassificationCard> = {},
): PolicyAuReclassificationCard {
  return {
    id: randomUUID(),
    title: "Synthetic durable setting",
    tags: ["synthetic", "setting"],
    approvalState: "policy_activated",
    lifecycleState: "active",
    sourceBasis: "explicit",
    provenanceSourceBasis: "explicit",
    confirmedBy: null,
    scope: "global",
    auId: null,
    sensitivity: "normal",
    importance: 2,
    ...overrides,
  };
}

test("exact AU reclassification plans governance-only append events and preserves evidence metadata", () => {
  const source = card();
  const outcome = planPolicyActivatedAuReclassification({
    card: source,
    auId: "synthetic-au-01",
    by: "owner",
    now: new Date("2026-08-26T03:00:00.000Z"),
  });
  assert.equal(outcome.status, "planned");
  if (outcome.status !== "planned") return;

  assert.equal(outcome.plan.memoryId, source.id);
  assert.equal(outcome.plan.auId, "synthetic-au-01");
  assert.equal(outcome.plan.sourceBasis, "explicit");
  assert.equal(outcome.plan.governance.length, 2);
  assert.equal(validateMnemosyneStream(outcome.plan.governance).ok, true);

  const attributes = outcome.plan.governance[0]!;
  assert.equal(attributes.actor, "owner");
  assert.equal(attributes.occurredAt, "2026-08-26T03:00:00.000Z");
  assert.equal(attributes.event.type, "attributes_set");
  if (attributes.event.type === "attributes_set") {
    assert.equal(attributes.event.memoryId, source.id);
    assert.equal(attributes.event.title, source.title);
    assert.deepEqual(attributes.event.tags, source.tags);
    assert.equal(attributes.event.scope, "au");
    assert.equal(attributes.event.auId, "synthetic-au-01");
    assert.equal(attributes.event.sensitivity, source.sensitivity);
    assert.equal(attributes.event.importance, source.importance);
    assert.equal(attributes.event.sourceBasis, "explicit");
  }

  const provenance = outcome.plan.governance[1]!;
  assert.equal(provenance.actor, "owner");
  assert.equal(provenance.event.type, "provenance_set");
  if (provenance.event.type === "provenance_set") {
    assert.equal(provenance.event.memoryId, source.id);
    assert.deepEqual(provenance.event.roles, { edited_by: "owner" });
  }
});

test("AU reclassification preserves observed basis, supports exact reviewed AU moves, and replays as no-op", () => {
  const observed = card({
    sourceBasis: "observed",
    provenanceSourceBasis: "observed",
    scope: "au",
    auId: "synthetic-au-old",
    sensitivity: "sensitive",
    importance: 3,
  });

  const moved = planPolicyActivatedAuReclassification({
    card: observed,
    auId: "synthetic-au-new",
    by: "companion",
    now: new Date("2026-08-26T03:01:00.000Z"),
  });
  assert.equal(moved.status, "planned");
  if (moved.status === "planned") {
    const attributes = moved.plan.governance[0]!;
    assert.equal(attributes.event.type, "attributes_set");
    if (attributes.event.type === "attributes_set") {
      assert.equal(attributes.event.sourceBasis, "observed");
      assert.equal(attributes.event.auId, "synthetic-au-new");
      assert.equal(attributes.event.sensitivity, "sensitive");
      assert.equal(attributes.event.importance, 3);
    }
    assert.equal(moved.plan.governance.every((event) => event.actor === "companion"), true);
  }

  const replay = planPolicyActivatedAuReclassification({
    card: { ...observed, auId: "synthetic-au-new" },
    auId: "synthetic-au-new",
    by: "companion",
  });
  assert.equal(replay.status, "already");
});

test("AU reclassification fails closed on malformed identity or policy/provenance contradictions", () => {
  const invalidAuIds = [
    "",
    "Synthetic-AU",
    "synthetic au",
    "-synthetic-au",
    `a${"b".repeat(64)}`,
  ];
  for (const auId of invalidAuIds) {
    const outcome = planPolicyActivatedAuReclassification({ card: card(), auId, by: "owner" });
    assert.equal(outcome.status, "refused", auId);
  }

  const invalidCards: PolicyAuReclassificationCard[] = [
    card({ approvalState: "candidate" }),
    card({ lifecycleState: "superseded" }),
    card({ sourceBasis: "inferred", provenanceSourceBasis: "inferred" }),
    card({ sourceBasis: "explicit", provenanceSourceBasis: "observed" }),
    card({ confirmedBy: "owner" }),
    card({ scope: "session" }),
    card({ scope: "au", auId: "INVALID_AU" }),
  ];
  for (const invalid of invalidCards) {
    const outcome = planPolicyActivatedAuReclassification({
      card: invalid,
      auId: "synthetic-au-02",
      by: "owner",
    });
    assert.equal(outcome.status, "refused", JSON.stringify(invalid));
  }
});
