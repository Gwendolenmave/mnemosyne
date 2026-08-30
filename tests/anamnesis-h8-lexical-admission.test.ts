import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitLexical,
  computeLexicalEvidence,
  DEFAULT_ANAMNESIS_LEXICAL_ADMISSION_PROFILE,
  validateAnamnesisLexicalAdmissionProfileV1,
} from "../core/services/anamnesis-admission.js";
import {
  retrieve,
  type AnamnesisSource,
  type MemoryItemView,
  type MemorySceneScope,
} from "../core/services/anamnesis.js";

const NOW = "2026-08-30T12:00:00.000Z";
const PLAIN: MemorySceneScope = { mode: "ordinary", intimacyActive: false };

function card(overrides: Partial<MemoryItemView> = {}): MemoryItemView {
  return {
    id: "card-default",
    title: "synthetic memory card",
    body: "synthetic memory body",
    scope: "project",
    au_id: null,
    sensitivity: "normal",
    importance: 1,
    approval_state: "confirmed",
    lifecycle_state: "active",
    seal_state: "open",
    confirmed_by: "owner",
    retrieval: "enabled",
    retrieval_explicit: 1,
    supersedes: null,
    source_basis: "explicit",
    tags_text: "synthetic",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    expires_at: null,
    ...overrides,
  };
}

function sourceFor(items: MemoryItemView[]): AnamnesisSource {
  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    ftsSearch: (_query, limit) =>
      items.slice(0, limit).map((item, index) => ({ itemId: item.id, rank: index + 1 })),
    getItem: (id) => byId.get(id),
    listPriors: () => [],
    listFragments: () => [],
    listSources: () => [],
  };
}

test("H8 profile: public lexical baseline is versioned and validated", () => {
  assert.equal(DEFAULT_ANAMNESIS_LEXICAL_ADMISSION_PROFILE.lexicalMinCoverage, 0.5);
  assert.equal(DEFAULT_ANAMNESIS_LEXICAL_ADMISSION_PROFILE.lexicalMinDistinctMatches, 2);
  assert.deepEqual(
    validateAnamnesisLexicalAdmissionProfileV1(DEFAULT_ANAMNESIS_LEXICAL_ADMISSION_PROFILE),
    DEFAULT_ANAMNESIS_LEXICAL_ADMISSION_PROFILE,
  );
  assert.throws(
    () =>
      validateAnamnesisLexicalAdmissionProfileV1({
        ...DEFAULT_ANAMNESIS_LEXICAL_ADMISSION_PROFILE,
        lexicalMinCoverage: 1.5,
      }),
    /lexicalMinCoverage/,
  );
});

test("H8 admission: common-only exact phrase/tag cannot bypass relevance", () => {
  const item = card({ title: "the", body: "the remembered thing", tags_text: "the" });
  const evidence = computeLexicalEvidence("the", item);
  assert.equal(evidence.isExactPhrase, false);
  assert.equal(evidence.isExactTag, false);
  const verdict = admitLexical("the", item);
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, "common_only_query");
});

test("H8 admission: weak single-token collisions are rejected", () => {
  const item = card({
    title: "delos architecture",
    body: "delos memory system architecture overview",
    tags_text: "memory architecture",
  });
  const evidence = computeLexicalEvidence("delos third party deployment pipeline outline", item);
  assert.equal(evidence.distinctMatches, 1);
  assert.equal(evidence.coverage < 0.5, true);
  const verdict = admitLexical("delos third party deployment pipeline outline", item);
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, "weak_lexical_evidence");
});

test("H8 admission: meaningful exact phrase preserves short Chinese recall", () => {
  const item = card({
    title: "project context",
    body: "synthetic project fixture 建 系统",
    tags_text: "project",
  });
  const verdict = admitLexical("系统", item);
  assert.equal(verdict.admitted, true);
  assert.equal(verdict.reason, "admitted_lexical");
});

test("H8 retrieval: top-k is a maximum and ranking boosts never rescue rejected padding", () => {
  const relevant = card({
    id: "relevant",
    title: "lumbar pillow support",
    body: "lumbar pillow support for back discomfort",
    tags_text: "lumbar pillow support",
    importance: 1,
  });
  const boostedWeak = card({
    id: "boosted-weak",
    title: "unrelated high-priority note",
    body: "lumbar unrelated notes",
    tags_text: "unrelated",
    importance: 1000,
    approval_state: "confirmed",
  });
  const auBoostedWeak = card({
    id: "au-boosted-weak",
    title: "another unrelated note",
    body: "pillow unrelated notes",
    tags_text: "unrelated",
    importance: 1000,
    scope: "au",
    au_id: "au-active",
  });

  const result = retrieve(
    sourceFor([boostedWeak, auBoostedWeak, relevant]),
    "lumbar pillow support",
    { mode: "au", auId: "au-active", intimacyActive: false },
    NOW,
    5,
  );

  assert.deepEqual(result.ranked.map((entry) => entry.item.id), ["relevant"]);
  assert.equal(result.ranked.length, 1);
  assert.equal(
    result.excluded.some(
      (entry) => entry.id === "boosted-weak" && entry.reason === "admission: weak_lexical_evidence",
    ),
    true,
  );
  assert.equal(
    result.excluded.some(
      (entry) => entry.id === "au-boosted-weak" && entry.reason === "admission: weak_lexical_evidence",
    ),
    true,
  );
});

test("H8 retrieval: empty recall is success instead of quota fill", () => {
  const weakA = card({ id: "weak-a", body: "delos unrelated note", importance: 500 });
  const weakB = card({ id: "weak-b", body: "pipeline unrelated note", importance: 500 });
  const result = retrieve(
    sourceFor([weakA, weakB]),
    "delos deployment pipeline outline",
    PLAIN,
    NOW,
    5,
  );
  assert.equal(result.ranked.length, 0);
  assert.equal(result.excluded.filter((entry) => entry.reason.startsWith("admission:")).length, 2);
});
