/**
 * Canonical memory log contract: an append-only store for the memory
 * event stream defined in core/domain/memory.ts. The stream held behind
 * this port is the ONLY authoritative representation of memory state;
 * readers derive current state by folding (core/domain/memory-fold.ts),
 * never by consulting stored snapshots.
 *
 * Contract every implementation must honor:
 *   - array/stream position is the only ordering authority; occurredAt
 *     is informational and must never reorder events;
 *   - append is all-or-nothing: the whole batch is validated against the
 *     existing stream and either every envelope commits in the given
 *     order or none does;
 *   - invalid input is REJECTED with the validation issues — never
 *     silently dropped, repaired, or partially applied;
 *   - readAll returns the full history; nothing is ever deleted.
 */

import type { MemoryEventEnvelope } from "../domain/memory.js";
import type { ValidationIssue } from "../domain/memory-validation.js";

export type MemoryEventLogAppendOutcome =
  | { status: "appended"; count: number }
  | { status: "rejected"; issues: ValidationIssue[] };

export type MemoryEventLogAppendToEmptyOutcome =
  | { status: "appended"; count: number }
  | { status: "rejected"; issues: ValidationIssue[] }
  | { status: "not-empty"; existingCount: number };

export interface MemoryEventLog {
  /** Transport label for status output and diagnostics. */
  readonly transport: string;
  /** The complete canonical stream in authoritative order. */
  readAll(): Promise<MemoryEventEnvelope[]>;
  /**
   * Validate the batch against the existing stream and append it
   * atomically. Input is treated as untrusted regardless of its static
   * type: implementations must re-validate at runtime.
   */
  append(envelopes: readonly MemoryEventEnvelope[]): Promise<MemoryEventLogAppendOutcome>;
  /**
   * Atomically import a complete stream into an empty log. The emptiness
   * check and append happen in one implementation-owned critical section.
   */
  appendToEmpty(envelopes: readonly MemoryEventEnvelope[]): Promise<MemoryEventLogAppendToEmptyOutcome>;
}
