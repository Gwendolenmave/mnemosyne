import { createHash } from "node:crypto";
import type { MemoryCreationEvidence } from "../domain/memory.js";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const MAX_DECISION_ID_CHARS = 200;

/**
 * Frozen projected identity a reviewed policy-card revision expects to replace.
 * The digest includes every retrieval-relevant axis plus provenance so a stale
 * review cannot silently apply to a different current card.
 */
export interface PolicyRevisionProjectedState {
  readonly id: string;
  readonly body: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly scope: "global" | "relationship" | "project" | "au";
  readonly auId: string | null;
  readonly sensitivity: "normal" | "sensitive" | "intimate";
  readonly importance: 1 | 2 | 3;
  readonly approvalState: string;
  readonly lifecycleState: string;
  readonly sourceBasis: "explicit" | "observed";
  readonly provenance: unknown;
}

/**
 * Immutable identity supplied by a reviewed curation/revision decision.
 * `sourceSha256` binds the already-validated source bytes; this contract never
 * dereferences or stores raw source content.
 */
export interface PolicyRevisionDecision {
  readonly decisionId: string;
  readonly sourceSha256: string;
  readonly preconditionDigest: string;
}

/** Full semantic replacement target committed by a decision. */
export interface PolicyRevisionTarget {
  readonly memoryId: string;
  readonly body: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly scope: "global" | "relationship" | "project" | "au";
  readonly auId: string | null;
  readonly sensitivity: "normal" | "sensitive" | "intimate";
  readonly importance: 1 | 2 | 3;
  readonly evidence: MemoryCreationEvidence;
  readonly sourceBasis: "explicit" | "observed";
}

export type PolicyRevisionDecisionValidation =
  | { ok: true }
  | { ok: false; path: string; message: string };

export function validatePolicyRevisionDecision(
  decision: PolicyRevisionDecision,
): PolicyRevisionDecisionValidation {
  if (
    typeof decision.decisionId !== "string" ||
    decision.decisionId.length === 0 ||
    decision.decisionId.length > MAX_DECISION_ID_CHARS ||
    decision.decisionId !== decision.decisionId.trim()
  ) {
    return {
      ok: false,
      path: "decision.decisionId",
      message: `decision id must be a trimmed string of 1..${MAX_DECISION_ID_CHARS} chars`,
    };
  }
  if (!SHA256_RE.test(decision.sourceSha256)) {
    return {
      ok: false,
      path: "decision.sourceSha256",
      message: "source hash must be lowercase sha256 hex",
    };
  }
  if (!SHA256_RE.test(decision.preconditionDigest)) {
    return {
      ok: false,
      path: "decision.preconditionDigest",
      message: "precondition digest must be lowercase sha256 hex",
    };
  }
  return { ok: true };
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

/**
 * Digest of the exact active projected state a decision expects to replace.
 * This is checked on first application; durable replay receipts will allow an
 * exact replay to short-circuit before checking the now-changed projection.
 */
export function policyRevisionPreconditionDigest(state: PolicyRevisionProjectedState): string {
  return sha256Canonical({
    schema: "delos.mnemosyne.policy-revision-precondition.v1",
    memoryId: state.id,
    body: state.body,
    title: state.title,
    tags: [...state.tags],
    scope: state.scope,
    auId: state.auId,
    sensitivity: state.sensitivity,
    importance: state.importance,
    approvalState: state.approvalState,
    lifecycleState: state.lifecycleState,
    sourceBasis: state.sourceBasis,
    provenance: state.provenance,
  });
}

/**
 * Full semantic target commitment. The target digest binds the frozen
 * precondition and exact source hash in addition to all retrieval-relevant
 * replacement metadata, evidence, AU identity, and evidence basis.
 */
export function policyRevisionTargetDigest(
  decision: PolicyRevisionDecision,
  target: PolicyRevisionTarget,
): string {
  return sha256Canonical({
    schema: "delos.mnemosyne.policy-revision-target.v1",
    preconditionDigest: decision.preconditionDigest,
    sourceSha256: decision.sourceSha256,
    memoryId: target.memoryId,
    body: target.body,
    title: target.title,
    tags: [...target.tags],
    scope: target.scope,
    auId: target.auId,
    sensitivity: target.sensitivity,
    importance: target.importance,
    evidence: target.evidence,
    sourceBasis: target.sourceBasis,
  });
}
