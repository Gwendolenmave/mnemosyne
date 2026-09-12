import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryCreationEvidence } from "../core/domain/memory.js";
import { asConversationId, asMessageId, asTurnId } from "../core/domain/ids.js";
import {
  curationDecisionSetDigest,
  preflightCurationDecisionSet,
  sha256Text,
  type CurationAction,
  type CurationArtifactFile,
  type CurationDecisionSetBundle,
  type CurationEvidenceEntry,
} from "../core/services/mnemosyne-curation-contract.js";

const CANONICAL = "1".repeat(40);
const REVIEW = "2".repeat(40);
const FILE_COMMIT = "3".repeat(40);
const PACKET = "4".repeat(64);

function evidence(): MemoryCreationEvidence {
  return {
    kind: "user_statement",
    source: {
      kind: "conversation_message",
      conversationId: asConversationId("00000000-0000-4000-8000-000000000001"),
      turnId: asTurnId("00000000-0000-4000-8000-000000000002"),
      messageId: asMessageId("00000000-0000-4000-8000-000000000003"),
      role: "user",
    },
  };
}

function decisionRow(action: CurationAction, cardId: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
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
    reviewer: "synthetic-reviewer",
    reviewed_at: "2026-08-24T08:00:00.000Z",
  };
  if (action === "REVISE") {
    base.replacement_title = "revised title";
    base.replacement_body = "revised body";
    base.replacement_scope = "relationship";
    base.replacement_tags = ["revised", "synthetic"];
  }
  if (action === "RECLASSIFY_AU") base.replacement_au_id = "synthetic-au";
  if (action === "SUPERSEDE") base.consolidation = { source_card_ids: [cardId], survivor_card_id: `${cardId}-survivor` };
  if (action === "MERGE") base.consolidation = { source_card_ids: [cardId, `${cardId}-source-2`], survivor_card_id: `${cardId}-survivor` };
  return base;
}

function artifact(path: string, content: string, commitSha = FILE_COMMIT): CurationArtifactFile {
  return { path, content, sha256: sha256Text(content), commitSha };
}

function buildBundle(rows: readonly Record<string, unknown>[], amendments: readonly Record<string, unknown>[] = []): CurationDecisionSetBundle {
  const decisionContent = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const amendmentContent = amendments.length === 0 ? "" : `${amendments.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const schemaFile = artifact("decisions/SCHEMA.md", "synthetic additive schema\n");
  const decisionFiles = [artifact("decisions/REVIEWED-SYNTHETIC.jsonl", decisionContent)];
  const amendmentFiles = amendments.length === 0 ? [] : [artifact("decisions/AMENDMENT-SYNTHETIC.jsonl", amendmentContent)];
  const cards: Record<string, CurationEvidenceEntry> = {};
  for (const row of rows) {
    const cardId = row.card_id as string;
    cards[cardId] = {
      originalCardSha256: row.original_card_sha256 as string,
      sourceTurnSha256: row.source_turn_sha256 as string,
      evidence: evidence(),
    };
  }
  const withoutDigest = {
    canonicalHead: CANONICAL,
    reviewHead: REVIEW,
    schemaFile,
    packetSha256: PACKET,
    decisionFiles,
    amendmentFiles,
    evidenceIndex: { packetSha256: PACKET, cards },
  };
  return { ...withoutDigest, decisionSetSha256: curationDecisionSetDigest(withoutDigest) };
}

test("curation contract accepts one frozen mixed batch containing all seven actionable decisions", () => {
  const rows = [
    decisionRow("KEEP", "card-keep"),
    decisionRow("REVISE", "card-revise"),
    decisionRow("REVOKE", "card-revoke"),
    decisionRow("EPISODIC_ONLY", "card-episode"),
    decisionRow("RECLASSIFY_AU", "card-au"),
    decisionRow("SUPERSEDE", "card-supersede"),
    decisionRow("MERGE", "card-merge"),
  ];
  const result = preflightCurationDecisionSet(buildBundle(rows));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.decisions.length, 7);
  assert.deepEqual(
    new Set(result.value.decisions.map((decision) => decision.row.action)),
    new Set(["KEEP", "REVISE", "REVOKE", "EPISODIC_ONLY", "RECLASSIFY_AU", "SUPERSEDE", "MERGE"]),
  );
  assert.equal(result.value.decisionSetId, result.value.decisionSetSha256);
  assert.equal(new Set(result.value.decisions.map((decision) => decision.decisionId)).size, 7);
});

test("curation contract resolves the newest exact hash-bound additive amendment without rewriting history", () => {
  const base = decisionRow("REVISE", "card-amended");
  const bundle0 = buildBundle([base]);
  const baseFile = bundle0.decisionFiles[0]!;
  const amendment = {
    ...base,
    replacement_tags: ["clean", "replacement"],
    amends: {
      decision_commit: baseFile.commitSha,
      decision_file: baseFile.path,
      reviewed_at: base.reviewed_at,
    },
    amendment_reason: "remove stale retrieval metadata",
    amended_at: "2026-08-24T09:00:00.000Z",
  };
  const result = preflightCurationDecisionSet(buildBundle([base], [amendment]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.decisions[0]!.row.replacement_tags, ["clean", "replacement"]);
  assert.equal(result.value.decisions[0]!.amendmentFile?.path, "decisions/AMENDMENT-SYNTHETIC.jsonl");
});

test("curation contract fails the entire set on hash mismatch or ambiguous consolidation", () => {
  const keep = decisionRow("KEEP", "card-hash-fail");
  const bundle = buildBundle([keep]);
  const badHash: CurationDecisionSetBundle = {
    ...bundle,
    evidenceIndex: {
      ...bundle.evidenceIndex,
      cards: {
        ...bundle.evidenceIndex.cards,
        "card-hash-fail": {
          ...bundle.evidenceIndex.cards["card-hash-fail"]!,
          sourceTurnSha256: "f".repeat(64),
        },
      },
    },
  };
  const hashResult = preflightCurationDecisionSet(badHash);
  assert.equal(hashResult.ok, false);
  if (!hashResult.ok) assert.ok(hashResult.issues.some((issue) => issue.message.includes("source-turn hash mismatch")));

  const ambiguous = decisionRow("SUPERSEDE", "card-ambiguous");
  delete ambiguous.consolidation;
  const ambiguityResult = preflightCurationDecisionSet(buildBundle([ambiguous]));
  assert.equal(ambiguityResult.ok, false);
  if (!ambiguityResult.ok) assert.ok(ambiguityResult.issues.some((issue) => issue.message.includes("explicit source/survivor orientation")));
});

test("NEEDS_OWNER and conflicting participant ownership are hard preflight blockers", () => {
  const needs = decisionRow("NEEDS_OWNER", "card-needs-owner");
  const blocked = preflightCurationDecisionSet(buildBundle([needs]));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.issues.some((issue) => issue.message.includes("preflight blocker")));

  const supersede = decisionRow("SUPERSEDE", "card-shared");
  const keep = decisionRow("KEEP", "card-shared-survivor");
  supersede.consolidation = { source_card_ids: ["card-shared"], survivor_card_id: "card-shared-survivor" };
  const conflict = preflightCurationDecisionSet(buildBundle([supersede, keep]));
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.ok(conflict.issues.some((issue) => issue.message.includes("participates in conflicting decisions")));
});
