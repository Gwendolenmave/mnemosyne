import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryCreationEvidence } from "../core/domain/memory.js";
import { asConversationId, asMessageId, asModelFamilyId, asTurnId } from "../core/domain/ids.js";
import {
  curationItemPreconditionDigest,
  curationRevisionPreconditionDigest,
  preflightCurationApplication,
} from "../core/services/mnemosyne-curation-applicator.js";
import {
  curationDecisionSetDigest,
  sha256Text,
  type CurationAction,
  type CurationArtifactFile,
  type CurationDecisionSetBundle,
  type CurationEvidenceEntry,
} from "../core/services/mnemosyne-curation-contract.js";
import type { GovernanceItemView } from "../core/services/mnemosyne-governance.js";

const CANONICAL = "1".repeat(40);
const REVIEW = "2".repeat(40);
const FILE_COMMIT = "3".repeat(40);
const PACKET = "4".repeat(64);

function evidence(kind: "explicit" | "observed" = "explicit"): MemoryCreationEvidence {
  const source = {
    kind: "conversation_message" as const,
    conversationId: asConversationId("00000000-0000-4000-8000-000000000001"),
    turnId: asTurnId("00000000-0000-4000-8000-000000000002"),
    messageId: asMessageId("00000000-0000-4000-8000-000000000003"),
  };
  return kind === "explicit"
    ? { kind: "user_statement", source: { ...source, role: "user" } }
    : {
        kind: "assistant_dialogue",
        origin: { modelFamily: asModelFamilyId("synthetic-model") },
        source: { ...source, role: "assistant" },
      };
}

function row(
  action: CurationAction,
  cardId: string,
  reviewer: "owner" | "companion" | string = "companion",
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    schema: "delos.mnemosyne.card-decision.v1",
    card_id: cardId,
    original_card_sha256: sha256Text(`card:${cardId}`),
    source_turn_sha256: sha256Text(`turn:${cardId}`),
    action,
    replacement_title: null,
    replacement_body: null,
    replacement_scope: null,
    replacement_au_id: null,
    supersedes_card_ids: [],
    merge_card_ids: [],
    reason: `synthetic ${action}`,
    reviewer,
    reviewed_at: "2026-08-26T05:00:00.000Z",
  };
  if (action === "REVISE") {
    value.replacement_title = "revised title";
    value.replacement_body = "revised body";
    value.replacement_scope = "relationship";
    value.replacement_tags = ["revised"];
    value.replacement_sensitivity = "normal";
    value.replacement_importance = 2;
  }
  if (action === "RECLASSIFY_AU") value.replacement_au_id = "synthetic-au";
  return value;
}

function consolidationRow(
  action: "SUPERSEDE" | "MERGE",
  cardId: string,
  sources: readonly string[],
  survivor: string,
): Record<string, unknown> {
  return {
    ...row(action, cardId),
    consolidation: {
      source_card_ids: [...sources],
      survivor_card_id: survivor,
    },
  };
}

function artifact(path: string, content: string): CurationArtifactFile {
  return { path, content, sha256: sha256Text(content), commitSha: FILE_COMMIT };
}

function bundle(
  rows: readonly Record<string, unknown>[],
  basis: "explicit" | "observed" = "explicit",
): CurationDecisionSetBundle {
  const schemaFile = artifact("decisions/SCHEMA.md", "synthetic schema\n");
  const content = `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const decisionFiles = [artifact("decisions/REVIEWED.jsonl", content)];
  const cards: Record<string, CurationEvidenceEntry> = {};
  for (const entry of rows) {
    const cardId = entry.card_id as string;
    cards[cardId] = {
      originalCardSha256: entry.original_card_sha256 as string,
      sourceTurnSha256: entry.source_turn_sha256 as string,
      evidence: evidence(basis),
    };
  }
  const input = {
    canonicalHead: CANONICAL,
    reviewHead: REVIEW,
    schemaFile,
    packetSha256: PACKET,
    decisionFiles,
    amendmentFiles: [],
    evidenceIndex: { packetSha256: PACKET, cards },
  };
  return { ...input, decisionSetSha256: curationDecisionSetDigest(input) };
}

function item(
  id: string,
  basis: "explicit" | "observed" = "explicit",
  overrides: Partial<GovernanceItemView> = {},
): GovernanceItemView {
  return {
    id,
    title: `title ${id}`,
    body: `body ${id}`,
    scope: "relationship",
    au_id: null,
    sensitivity: "normal",
    importance: 2,
    approval_state: "policy_activated",
    lifecycle_state: "active",
    confirmed_by: null,
    retrieval: "enabled",
    supersedes: null,
    source_basis: basis,
    tags_text: "synthetic",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    provenance: JSON.stringify({ source_basis: basis, reviewed_by: "companion" }),
    ...overrides,
  };
}

test("whole-set store preflight refuses a later missing card instead of returning a partial plan", () => {
  const input = bundle([row("KEEP", "card-good"), row("REVOKE", "card-missing")]);
  const reader = { getItem: (id: string) => (id === "card-good" ? item(id) : undefined) };

  const result = preflightCurationApplication(input, reader);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.path === "decisions.card-missing"));
  }
});

test("whole-set state preflight fails closed on frozen evidence/projection basis contradiction", () => {
  const input = bundle([row("REVISE", "card-observed")], "observed");
  const reader = { getItem: (id: string) => item(id, "explicit") };

  const result = preflightCurationApplication(input, reader);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.message.includes("conflicts with projected source basis")));
  }
});

test("REVISE planning reuses the durable policy-revision frozen precondition contract", () => {
  const current = item("card-revise");
  const input = bundle([row("REVISE", current.id)]);
  const result = preflightCurationApplication(input, { getItem: () => current });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0]!.action, "REVISE");
  assert.equal(result.plans[0]!.preconditionDigest, curationRevisionPreconditionDigest(current));
  assert.notEqual(result.plans[0]!.preconditionDigest, curationItemPreconditionDigest(current));
  assert.match(result.plans[0]!.targetDigest, /^[0-9a-f]{64}$/u);
});

test("non-REVISE actions bind the exact projected state before any later writer exists", () => {
  const rows = [
    row("KEEP", "card-keep", "owner"),
    row("REVOKE", "card-revoke"),
    row("EPISODIC_ONLY", "card-episodic"),
    row("RECLASSIFY_AU", "card-au"),
  ];
  const state = new Map(rows.map((entry) => [entry.card_id as string, item(entry.card_id as string)]));
  const result = preflightCurationApplication(bundle(rows), { getItem: (id) => state.get(id) });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.plans.map((plan) => plan.action), ["KEEP", "REVOKE", "EPISODIC_ONLY", "RECLASSIFY_AU"]);
  assert.equal(result.plans[0]!.actor, "owner");
  for (const plan of result.plans) {
    assert.equal(plan.preconditionDigest, curationItemPreconditionDigest(state.get(plan.decision.row.card_id)!));
  }
});

test("RECLASSIFY_AU requires an exact canonical slug at application preflight", () => {
  const decision = row("RECLASSIFY_AU", "card-au");
  decision.replacement_au_id = "Synthetic AU";
  const result = preflightCurationApplication(bundle([decision]), { getItem: (id) => item(id) });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.message.includes("canonical AU slug")));
  }
});

test("consolidation preflight validates every referenced participant before planning", () => {
  const decision = consolidationRow("SUPERSEDE", "source-a", ["source-a"], "survivor");
  const state = new Map([["source-a", item("source-a")]]);
  const result = preflightCurationApplication(bundle([decision]), { getItem: (id) => state.get(id) });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.message === "survivor card is missing"));
  }
});

test("consolidation accepts a confirmed survivor while keeping policy sources governed", () => {
  const decision = consolidationRow("MERGE", "source-a", ["source-a", "source-b"], "survivor");
  const state = new Map<string, GovernanceItemView>([
    ["source-a", item("source-a")],
    ["source-b", item("source-b")],
    [
      "survivor",
      item("survivor", "explicit", {
        approval_state: "confirmed",
        confirmed_by: "owner",
      }),
    ],
  ]);
  const result = preflightCurationApplication(bundle([decision]), { getItem: (id) => state.get(id) });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0]!.action, "MERGE");
});

test("applicator refuses non-public reviewer vocabulary instead of silently relabelling actor identity", () => {
  const input = bundle([row("KEEP", "card-reviewer", "someone-else")]);
  const result = preflightCurationApplication(input, { getItem: (id) => item(id) });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.path.endsWith(".reviewer")));
  }
});

test("projected provenance contradiction is caught before any write-planning result is returned", () => {
  const current = item("card-provenance", "explicit", {
    provenance: JSON.stringify({ source_basis: "observed", reviewed_by: "companion" }),
  });
  const result = preflightCurationApplication(bundle([row("KEEP", current.id)]), { getItem: () => current });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.message === "projected source basis conflicts with provenance"));
  }
});
