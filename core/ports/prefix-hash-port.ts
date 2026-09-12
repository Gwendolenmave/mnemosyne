/**
 * T05A — bounded streaming verification of a sealed ledger prefix.
 *
 * Closure C. The previous design read a whole prefix into one buffer under an
 * 8 MiB ceiling, and when a lawful declaration exceeded that ceiling it reported
 * `fileBytes: 0, appendOnlyOk: false` — which the report then rendered as
 * `zero_byte_anchor_proves_nothing` and `prefix_mismatch`. A reviewer produced
 * that from a 9,437,206-byte ledger whose seal was perfectly correct: two false
 * statements, the second being the most severe diagnosis in the vocabulary, out of
 * a file size.
 *
 * Two separate mistakes were tangled there, and this module untangles them:
 *
 *   1. a read LIMIT is not an OBSERVATION. Hitting a policy ceiling is its own
 *      outcome and must never be substituted for a fact about the bytes.
 *   2. hashing does not require materializing. A sealed prefix of any lawful size
 *      can be hashed in fixed-size blocks, so the ceiling can sit far above any
 *      real ledger instead of in the middle of the lawful range.
 *
 * The outcomes below are exhaustive and mutually exclusive, so the report never has
 * to infer one fact from the absence of another.
 */

/** Exactly what was observed about a declared sealed prefix. */
export type PrefixOutcome =
  | "anchor_prefix_verified"
  /** this profile does not require the ledger, so no descriptor was opened */
  | "anchor_profile_excluded"
  | "anchor_prefix_rewritten"
  | "anchor_prefix_truncated"
  | "anchor_file_too_short"
  | "anchor_prefix_over_policy_limit"
  | "anchor_io_error"
  | "anchor_wrong_object_type"
  | "anchor_declared_bytes_invalid";

export const PREFIX_OUTCOMES: readonly PrefixOutcome[] = [
  "anchor_prefix_verified",
  "anchor_profile_excluded",
  "anchor_prefix_rewritten",
  "anchor_prefix_truncated",
  "anchor_file_too_short",
  "anchor_prefix_over_policy_limit",
  "anchor_io_error",
  "anchor_wrong_object_type",
  "anchor_declared_bytes_invalid",
] as const;

export function prefixOutcomeIsVerified(o: PrefixOutcome): boolean {
  return o === "anchor_prefix_verified";
}

/**
 * The policy ceiling, stated as data so the report can name the exact number
 * rather than describing it.
 *
 * 512 MiB, chosen to sit far above the largest lawful case anyone has produced
 * (9,437,206 bytes — roughly 0.018 of this) so that a ceiling refusal means
 * something genuinely pathological rather than "your ledger grew". Streaming is
 * what makes a ceiling this high affordable: memory is one block, not one prefix.
 */
export const SEALED_PREFIX_POLICY_CEILING = 512 * 1024 * 1024;

/** Fixed-size read block. Memory is O(block), independent of the prefix. */
export const PREFIX_BLOCK_BYTES = 64 * 1024;

export interface PrefixHashResult {
  readonly outcome: PrefixOutcome;
  /** the declared sealed length, echoed for the report */
  readonly declaredBytes: number;
  /** the real length of the object, or 0 when it could not be taken */
  readonly fileBytes: number;
  /** how many bytes were actually hashed */
  readonly hashedBytes: number;
  /** `sha256:<hex>` over exactly the declared prefix, when it could be read */
  readonly identity: string | null;
  /** the ceiling in force, always reported so the number is never implied */
  readonly policyCeiling: number;
  /** proof the descriptor was released, on every outcome including failures */
  readonly descriptorClosed: boolean;
}

/**
 * The narrow read-only capability. One operation, no path traversal, no writes.
 *
 * It is deliberately separate from `ReadOnlyFs`: this is the only place in the
 * product that opens a file descriptor and holds it across multiple reads, and
 * keeping it its own interface makes that fact visible in every signature that
 * needs it.
 */
export interface PrefixHasher {
  readonly hashRegularFilePrefix: (path: string, sealedBytes: number, expected: string) => PrefixHashResult;
}

/**
 * Pure classification of a completed streaming read.
 *
 * Extracted so the decision is testable without a filesystem, and so the adapter
 * cannot quietly invent a different rule. `expected` is the declared identity;
 * `hashed` is what was actually read.
 */
export function classifyPrefixRead(args: {
  readonly declaredBytes: number;
  readonly fileBytes: number;
  readonly hashedBytes: number;
  readonly identity: string | null;
  readonly expected: string;
  readonly ioFailed: boolean;
}): PrefixOutcome {
  if (args.ioFailed) return "anchor_io_error";
  // A file shorter than its declared seal cannot be verified, and the fact is
  // "too short" — never "rewritten". They are different events with different
  // remedies, and a reviewer found the second standing in for the first.
  if (args.fileBytes < args.declaredBytes) return "anchor_file_too_short";
  if (args.hashedBytes < args.declaredBytes) return "anchor_prefix_truncated";
  if (args.identity === null) return "anchor_io_error";
  return args.identity === args.expected ? "anchor_prefix_verified" : "anchor_prefix_rewritten";
}
