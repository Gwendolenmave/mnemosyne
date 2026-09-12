/**
 * Pure fold from the canonical memory event stream to derived state. The
 * fold is the ONLY way lifecycle, current content, current evidence, and
 * current scope come into existence — nothing here is ever persisted, and
 * no timestamp is ever consulted: array order is the single ordering
 * authority (occurredAt is informational).
 *
 * Defense in depth: the fold refuses unvalidated input. Every call
 * re-runs the full stream validation and throws on failure, so a caller
 * that skipped validation can never fold an invalid stream into
 * plausible-looking state.
 */

import type { MemoryId } from "./ids.js";
import type {
  MemoryEventEnvelope,
  MemoryEvidence,
  MemoryLifecycle,
  MemoryScope,
} from "./memory.js";
import {
  validateMemoryEventStream,
  type ValidationIssue,
} from "./memory-validation.js";

function cloneMemory<T>(value: T): T {
  return structuredClone(value);
}

/** Thrown when a stream offered for folding fails canonical validation. */
export class InvalidMemoryEventStreamError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const first = issues[0];
    super(
      `refusing to fold an invalid memory event stream (${issues.length} issue${
        issues.length === 1 ? "" : "s"
      }${first ? `; first: ${first.path} — ${first.message}` : ""})`,
    );
    this.name = "InvalidMemoryEventStreamError";
    this.issues = issues;
  }
}

/**
 * Fold-derived state of one memory record. content/evidence/scope always
 * reflect the LATEST create-or-revise event by stream position — a
 * superseded or inactive record keeps its final content in history-facing
 * views but never appears in the current view.
 */
export interface MemoryRecordState {
  memoryId: MemoryId;
  lifecycle: MemoryLifecycle;
  content: string;
  evidence: MemoryEvidence;
  scope: MemoryScope;
  /** Present exactly when lifecycle is "superseded". */
  supersededByMemoryId?: MemoryId;
  /** Every envelope whose event targets this memoryId, in stream order. */
  history: MemoryEventEnvelope[];
}

export interface FoldedMemoryState {
  /** Every memory ever created, in creation (stream) order. */
  records: MemoryRecordState[];
  /** Active records only, in creation order — the current view. */
  current: MemoryRecordState[];
}

/**
 * Fold a validated canonical event stream into derived memory state.
 * Pure: the input array and its envelopes are never mutated, and equal
 * inputs always produce equal outputs.
 */
export function foldMemoryEvents(stream: readonly MemoryEventEnvelope[]): FoldedMemoryState {
  const validated = validateMemoryEventStream([...stream]);
  if (!validated.ok) {
    throw new InvalidMemoryEventStreamError(validated.issues);
  }

  const byId = new Map<MemoryId, MemoryRecordState>();
  const records: MemoryRecordState[] = [];
  for (const envelope of cloneMemory(validated.value)) {
    const event = envelope.event;
    switch (event.type) {
      case "memory_created": {
        const record: MemoryRecordState = {
          memoryId: event.memoryId,
          lifecycle: "active",
          content: event.content,
          evidence: cloneMemory(event.evidence),
          scope: cloneMemory(event.scope),
          history: [envelope],
        };
        byId.set(event.memoryId, record);
        records.push(record);
        break;
      }
      case "memory_revised": {
        // Stream validation guarantees the target exists and is active.
        const record = byId.get(event.memoryId)!;
        record.content = event.content;
        record.evidence = cloneMemory(event.evidence);
        record.scope = cloneMemory(event.scope);
        record.history.push(envelope);
        break;
      }
      case "memory_superseded": {
        const record = byId.get(event.memoryId)!;
        record.lifecycle = "superseded";
        record.supersededByMemoryId = event.supersededByMemoryId;
        record.history.push(envelope);
        break;
      }
      case "memory_deactivated": {
        const record = byId.get(event.memoryId)!;
        record.lifecycle = "inactive";
        record.history.push(envelope);
        break;
      }
    }
  }

  return {
    records,
    current: records
      .filter((record) => record.lifecycle === "active")
      .map((record) => cloneMemory(record)),
  };
}
