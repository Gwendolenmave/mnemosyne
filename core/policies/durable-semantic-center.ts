export const DURABLE_SEMANTIC_CENTER_POLICY_ID = "mnemosyne-durable-semantic-center-v1";

/**
 * Mnemosyne long-term cards are atomic retrieval units. A broad category such
 * as "media", "relationship", "project", or "body habit" is NOT a semantic
 * center and never establishes merge authority by itself.
 *
 * MERGE is allowed only when every retiring source and the survivor represent
 * the same independently retrievable durable meaning in one of these ways:
 *
 * - duplicate: materially the same durable fact/rule;
 * - paraphrase: the same durable meaning expressed differently;
 * - strict_subsumption: the survivor fully contains the source's durable
 *   meaning without broadening into a category/overview that also contains
 *   independently changeable facts.
 *
 * If two memories can sensibly be retrieved, corrected, revoked, or changed
 * independently, they are different semantic centers and must remain separate
 * cards. Overview cards stay overview cards; specific strong preferences do not
 * get absorbed merely because they share a category label.
 */
export type DurableSemanticCenterMergeRelation =
  | "duplicate"
  | "paraphrase"
  | "strict_subsumption";

export interface DurableSemanticCenterMergeProof {
  readonly policyId: typeof DURABLE_SEMANTIC_CENTER_POLICY_ID;
  readonly relation: DurableSemanticCenterMergeRelation;
  readonly rationale: string;
}

const MERGE_REASON_RE = /^\[semantic-center:(duplicate|paraphrase|strict_subsumption)\]\s+(.+)$/u;
const MAX_RATIONALE_CHARS = 150;

/**
 * Produce the canonical, append-only merge reason consumed by the governance
 * planner. Keeping the relation inside the persisted reason means historical
 * `memory_superseded` events retain the proof even after projections rebuild.
 */
export function encodeDurableSemanticCenterMergeReason(
  relation: DurableSemanticCenterMergeRelation,
  rationale: string,
): string {
  const clean = rationale.trim();
  if (clean.length === 0 || clean.length > MAX_RATIONALE_CHARS || /[\r\n\u2028\u2029]/u.test(clean)) {
    throw new Error(`semantic-center merge rationale must be 1..${MAX_RATIONALE_CHARS} single-line characters`);
  }
  return `[semantic-center:${relation}] ${clean}`;
}

/** Runtime validation for callers that bypass TypeScript types. */
export function parseDurableSemanticCenterMergeReason(
  reason: string,
): DurableSemanticCenterMergeProof | null {
  const clean = reason.trim();
  const match = MERGE_REASON_RE.exec(clean);
  if (match === null) return null;
  const relation = match[1] as DurableSemanticCenterMergeRelation;
  const rationale = match[2]!.trim();
  if (
    rationale.length === 0 ||
    rationale.length > MAX_RATIONALE_CHARS ||
    /[\r\n\u2028\u2029]/u.test(rationale)
  ) {
    return null;
  }
  return {
    policyId: DURABLE_SEMANTIC_CENTER_POLICY_ID,
    relation,
    rationale,
  };
}
