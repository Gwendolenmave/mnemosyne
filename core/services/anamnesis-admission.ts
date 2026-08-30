/**
 * Anamnesis H8 lexical relevance admission.
 *
 * This is the public, lexical-only slice of Delos H8. It deliberately does
 * not import an embedding provider, vector projection, or semantic contract:
 * semantic retrieval is a separate optional capability and can be added later
 * without making lexical relevance depend on it.
 *
 * Invariants:
 *   - top-k is a maximum, never a quota; zero admitted memories is success;
 *   - weak/common-token FTS collisions cannot pad a packet;
 *   - trust, importance, title/tag boosts, AU advice, and recency cannot rescue
 *     a candidate that failed relevance admission;
 *   - exact phrase/tag shortcuts only apply to meaningful queries.
 */

import { segmentForSearch } from "./segmentation.js";
import type { MemoryItemView } from "./anamnesis.js";

export type AnamnesisLexicalAdmissionReason =
  | "admitted_lexical"
  | "weak_lexical_evidence"
  | "common_only_query";

export interface AnamnesisLexicalAdmissionVerdict {
  readonly admitted: boolean;
  readonly reason: AnamnesisLexicalAdmissionReason;
  /** Diagnostic metadata only; never includes raw card text. */
  readonly detail?: string;
}

export interface AnamnesisLexicalAdmissionProfileV1 {
  readonly schema: "mnemosyne-anamnesis-lexical-admission-v1";
  readonly lexicalMinCoverage: number;
  readonly lexicalMinDistinctMatches: number;
  readonly lexicalRecipe: "segmentation-v1";
}

export const ANAMNESIS_LEXICAL_ADMISSION_PROFILE_SCHEMA_V1 =
  "mnemosyne-anamnesis-lexical-admission-v1" as const;

/**
 * Public lexical baseline copied from the accepted H8 thresholds.
 * These values are independent of any embedding model: at least two distinct
 * query tokens and at least 50% query-token coverage, unless a meaningful
 * exact phrase/tag match provides stronger direct lexical evidence.
 */
export const DEFAULT_ANAMNESIS_LEXICAL_ADMISSION_PROFILE: AnamnesisLexicalAdmissionProfileV1 =
  Object.freeze({
    schema: ANAMNESIS_LEXICAL_ADMISSION_PROFILE_SCHEMA_V1,
    lexicalMinCoverage: 0.5,
    lexicalMinDistinctMatches: 2,
    lexicalRecipe: "segmentation-v1",
  });

export function validateAnamnesisLexicalAdmissionProfileV1(
  value: unknown,
): AnamnesisLexicalAdmissionProfileV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("lexical admission profile must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== ANAMNESIS_LEXICAL_ADMISSION_PROFILE_SCHEMA_V1) {
    throw new TypeError(
      `lexical admission profile schema must be "${ANAMNESIS_LEXICAL_ADMISSION_PROFILE_SCHEMA_V1}"`,
    );
  }
  if (record.lexicalRecipe !== "segmentation-v1") {
    throw new TypeError('lexical admission profile lexicalRecipe must be "segmentation-v1"');
  }
  if (
    typeof record.lexicalMinCoverage !== "number" ||
    !Number.isFinite(record.lexicalMinCoverage) ||
    record.lexicalMinCoverage < 0 ||
    record.lexicalMinCoverage > 1
  ) {
    throw new TypeError("lexical admission profile lexicalMinCoverage must be in [0, 1]");
  }
  if (
    typeof record.lexicalMinDistinctMatches !== "number" ||
    !Number.isInteger(record.lexicalMinDistinctMatches) ||
    record.lexicalMinDistinctMatches < 1 ||
    record.lexicalMinDistinctMatches > 32
  ) {
    throw new TypeError(
      "lexical admission profile lexicalMinDistinctMatches must be an integer in [1, 32]",
    );
  }
  return Object.freeze({
    schema: ANAMNESIS_LEXICAL_ADMISSION_PROFILE_SCHEMA_V1,
    lexicalMinCoverage: record.lexicalMinCoverage,
    lexicalMinDistinctMatches: record.lexicalMinDistinctMatches,
    lexicalRecipe: "segmentation-v1",
  });
}

export interface LexicalEvidence {
  readonly distinctMatches: number;
  readonly totalDistinct: number;
  readonly coverage: number;
  readonly hasNonCommonHit: boolean;
  readonly isExactPhrase: boolean;
  readonly isExactTag: boolean;
  readonly queryIsMeaningful: boolean;
  readonly intersectionIsMeaningful: boolean;
}

/** Conservative common/function tokens for English + Chinese mixed queries. */
const COMMON_TOKENS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from",
  "has", "have", "he", "her", "his", "i", "in", "is", "it", "its",
  "me", "my", "no", "not", "of", "on", "or", "she", "so", "that",
  "the", "their", "they", "this", "to", "was", "we", "what", "when",
  "where", "which", "who", "why", "will", "with", "you", "your",
  "的", "了", "在", "和", "是", "就", "都", "而", "及", "与", "或",
  "把", "被", "给", "对", "有", "也", "还", "到", "从", "向", "为",
  "之", "其", "他", "她", "它", "这", "那", "此", "彼",
  "我", "你", "吗", "呢", "啊", "吧", "呀", "哦", "嗯", "哈", "么",
]);

function tokenizeDistinct(text: string): Set<string> {
  const segmented = segmentForSearch(text);
  if (segmented.length === 0) return new Set();
  return new Set(segmented.split(" ").filter((token) => token.length > 0));
}

function containsExactPhrase(haystack: string, needle: string): boolean {
  return needle.length > 0 && haystack.includes(needle);
}

export function computeLexicalEvidence(query: string, item: MemoryItemView): LexicalEvidence {
  const queryTokens = tokenizeDistinct(query);
  const titleTokens = tokenizeDistinct(item.title);
  const bodyTokens = tokenizeDistinct(item.body);
  const tagTokens = new Set(
    item.tags_text
      .split(" ")
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 0),
  );

  const intersection = new Set<string>();
  for (const token of queryTokens) {
    if (titleTokens.has(token) || bodyTokens.has(token) || tagTokens.has(token)) {
      intersection.add(token);
    }
  }

  const distinctMatches = intersection.size;
  const totalDistinct = queryTokens.size;
  const coverage = totalDistinct === 0 ? 0 : distinctMatches / totalDistinct;
  const queryIsMeaningful = Array.from(queryTokens).some((token) => !COMMON_TOKENS.has(token));
  const intersectionIsMeaningful = Array.from(intersection).some(
    (token) => !COMMON_TOKENS.has(token),
  );
  const hasNonCommonHit = intersectionIsMeaningful;

  const querySeg = segmentForSearch(query);
  const titleSeg = segmentForSearch(item.title);
  const bodySeg = segmentForSearch(item.body);
  const isExactPhrase =
    querySeg.length > 0 &&
    queryIsMeaningful &&
    (containsExactPhrase(titleSeg, querySeg) || containsExactPhrase(bodySeg, querySeg));
  const isExactTag =
    queryIsMeaningful &&
    queryTokens.size > 0 &&
    Array.from(queryTokens).every((token) => tagTokens.has(token));

  return {
    distinctMatches,
    totalDistinct,
    coverage,
    hasNonCommonHit,
    isExactPhrase,
    isExactTag,
    queryIsMeaningful,
    intersectionIsMeaningful,
  };
}

export function admitLexical(
  query: string,
  item: MemoryItemView,
  profile: AnamnesisLexicalAdmissionProfileV1 = DEFAULT_ANAMNESIS_LEXICAL_ADMISSION_PROFILE,
): AnamnesisLexicalAdmissionVerdict {
  const evidence = computeLexicalEvidence(query, item);

  if (!evidence.queryIsMeaningful) {
    return {
      admitted: false,
      reason: "common_only_query",
      detail: `distinct=${evidence.distinctMatches}/${evidence.totalDistinct}`,
    };
  }

  if (evidence.isExactPhrase || evidence.isExactTag) {
    return { admitted: true, reason: "admitted_lexical" };
  }

  if (
    evidence.distinctMatches >= profile.lexicalMinDistinctMatches &&
    evidence.coverage >= profile.lexicalMinCoverage &&
    evidence.hasNonCommonHit
  ) {
    return { admitted: true, reason: "admitted_lexical" };
  }

  return {
    admitted: false,
    reason: "weak_lexical_evidence",
    detail: `distinct=${evidence.distinctMatches}/${evidence.totalDistinct} coverage=${evidence.coverage.toFixed(3)}`,
  };
}
