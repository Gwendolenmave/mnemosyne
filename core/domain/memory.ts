/**
 * Canonical memory schemas. The append-only event stream defined here is
 * the ONLY authoritative representation of Delos memory state: lifecycle,
 * current content, current scope, revision chains, and supersession are
 * all derived by folding events, never stored. Runtime-inactive until a
 * later, separately approved commit wires a store.
 *
 * Three orthogonal dimensions, never merged into one enum:
 *   - lifecycle (derived): active | superseded | inactive;
 *   - epistemic grounding (persisted evidence union): what supports it;
 *   - visibility scope (persisted): shared or model-family-private.
 *
 * Invalid evidence states are unrepresentable at the type level: role-
 * specific reference types keep assistant messages out of user grounding,
 * creation evidence excludes user_confirmation, and imported origin only
 * exists on assistant-authored imports. Runtime validators re-enforce the
 * same rules for untrusted input.
 */

import { isCanonicalUuid } from "./ids.js";
import type {
  ConversationId,
  ImportId,
  ManualEntryId,
  MemoryEventId,
  MemoryId,
  MessageId,
  ModelFamilyId,
  AssistantInstanceId,
  RevisionId,
  TurnId,
} from "./ids.js";

export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_BUNDLE_FORMAT = "delos-memory-events";

// ---------------------------------------------------------------------------
// Source references (persisted inside evidence)
// ---------------------------------------------------------------------------

/**
 * Optional transport annotation on a conversation reference. Persisted
 * metadata only — NEVER canonical identity; validators must never require
 * or dereference it, and it must never define scope or origin.
 */
export interface ExternalSourceAnnotation {
  source?: string;
  externalTurnKey?: string;
}

interface ConversationMessageRefBase<Role extends "user" | "assistant"> {
  kind: "conversation_message";
  conversationId: ConversationId;
  turnId: TurnId;
  messageId: MessageId;
  role: Role;
  external?: ExternalSourceAnnotation;
}

/** A message the USER wrote, as persisted in a Delos transcript. */
export type UserConversationMessageRef = ConversationMessageRefBase<"user">;
/** A message the ASSISTANT wrote, as persisted in a Delos transcript. */
export type AssistantConversationMessageRef = ConversationMessageRefBase<"assistant">;
export type ConversationMessageRef = UserConversationMessageRef | AssistantConversationMessageRef;

interface ImportedRecordRefBase<Author extends "user" | "assistant" | "unknown"> {
  kind: "imported_record";
  importId: ImportId;
  recordLocator: string;
  author: Author;
}

/** The exact record inside a user-controlled imported archive. */
export type AssistantImportedRecordRef = ImportedRecordRefBase<"assistant">;
export type NonAssistantImportedRecordRef = ImportedRecordRefBase<"user" | "unknown">;
export type ImportedRecordRef = AssistantImportedRecordRef | NonAssistantImportedRecordRef;

/**
 * A genuinely out-of-band manual user entry. Carries its own Delos-minted
 * identity; the optional conversation context annotates but never
 * replaces it. A statement made inside a conversation uses
 * UserConversationMessageRef directly instead.
 */
export interface ManualEntryRef {
  kind: "manual_entry";
  manualEntryId: ManualEntryId;
  context?: ConversationMessageRef;
}

// ---------------------------------------------------------------------------
// Scope and assistant origin (persisted)
// ---------------------------------------------------------------------------

/** Visibility scope — independent of lifecycle, grounding, and confidence. */
export type MemoryScope =
  | { kind: "shared" }
  | { kind: "model_private"; modelFamily: ModelFamilyId };

/**
 * Which Delos assistant family (and optionally which persona instance)
 * produced model-originated content. Delos-owned; never a provider
 * session/thread ID. Exact model/version/provider details are not
 * canonical identity and may only arrive later as versioned annotations.
 */
export interface AssistantOrigin {
  modelFamily: ModelFamilyId;
  instanceId?: AssistantInstanceId;
}

// ---------------------------------------------------------------------------
// Epistemic evidence (persisted; kind is the authority — no stored booleans)
// ---------------------------------------------------------------------------

/** Only user-role messages or identified manual entries can ground. */
export interface UserStatementEvidence {
  kind: "user_statement";
  source: UserConversationMessageRef | ManualEntryRef;
}

/** Valid only on revisions; a creation has nothing prior to confirm. */
export interface UserConfirmationEvidence {
  kind: "user_confirmation";
  source: UserConversationMessageRef | ManualEntryRef;
}

export interface ModelInferenceEvidence {
  kind: "model_inference";
  origin: AssistantOrigin;
  confidence?: number;
  derivedFrom?: ConversationMessageRef[];
}

/** Assistant's own prior output: only assistant-role sources exist here. */
export interface AssistantDialogueEvidence {
  kind: "assistant_dialogue";
  origin: AssistantOrigin;
  source: AssistantConversationMessageRef;
}

/**
 * Origin exists ONLY on assistant-authored imports. The `origin?: never`
 * on the non-assistant variant makes the invalid combination
 * unrepresentable even under union excess-property rules.
 */
export type ImportedEvidence =
  | { kind: "imported"; source: AssistantImportedRecordRef; origin?: AssistantOrigin; confidence?: number }
  | { kind: "imported"; source: NonAssistantImportedRecordRef; origin?: never; confidence?: number };

/** Evidence permitted on memory_created: user_confirmation is excluded. */
export type MemoryCreationEvidence =
  | UserStatementEvidence
  | ModelInferenceEvidence
  | AssistantDialogueEvidence
  | ImportedEvidence;

/** Evidence permitted on memory_revised (and the full union). */
export type MemoryEvidence = MemoryCreationEvidence | UserConfirmationEvidence;

// ---------------------------------------------------------------------------
// Events (persisted; the only authoritative representation)
// ---------------------------------------------------------------------------

export type RevisionKind = "amendment" | "correction";

export interface MemoryCreatedEvent {
  type: "memory_created";
  memoryId: MemoryId;
  content: string;
  evidence: MemoryCreationEvidence;
  scope: MemoryScope;
}

/**
 * Changes content, grounding, or scope of the SAME conceptual memory.
 * Ordinary factual corrections stay on the same MemoryId as a
 * "correction" revision; prior content remains in event history.
 */
export interface MemoryRevisedEvent {
  type: "memory_revised";
  memoryId: MemoryId;
  revisionId: RevisionId;
  revisionKind: RevisionKind;
  content: string;
  evidence: MemoryEvidence;
  scope: MemoryScope;
}

/**
 * One independently existing record replaced by another (duplicate
 * consolidation, explicit record replacement). NOT the default mechanism
 * for ordinary factual correction — that is memory_revised.
 */
export interface MemorySupersededEvent {
  type: "memory_superseded";
  memoryId: MemoryId;
  supersededByMemoryId: MemoryId;
  reason?: string;
}

export interface MemoryDeactivatedEvent {
  type: "memory_deactivated";
  memoryId: MemoryId;
  reason?: string;
}

export type MemoryEvent =
  | MemoryCreatedEvent
  | MemoryRevisedEvent
  | MemorySupersededEvent
  | MemoryDeactivatedEvent;

/**
 * One persisted stream element. Stream position (array/file order) is the
 * ONLY ordering authority; occurredAt is informational.
 */
export interface MemoryEventEnvelope {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  eventId: MemoryEventId;
  occurredAt: string;
  event: MemoryEvent;
}

/**
 * Portable export: the complete canonical event stream and nothing else.
 * No integrity hashes, counts, snapshots, or materialized tables — any
 * derived form would be a second truth that could contradict the events.
 */
export interface MemoryExportBundle {
  bundleFormat: typeof MEMORY_BUNDLE_FORMAT;
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  exportedAt: string;
  events: MemoryEventEnvelope[];
}

// ---------------------------------------------------------------------------
// Derived-only concepts (never persisted, never exported)
// ---------------------------------------------------------------------------

/** Fold-derived lifecycle. No event or record ever stores this. */
export type MemoryLifecycle = "active" | "superseded" | "inactive";

/**
 * Factual-grounding rule: true only for direct user speech, explicit user
 * confirmation, or user-authored imports. Assistant dialogue and model
 * inference stay ungrounded regardless of confidence or origin — no
 * origin or confidence value can promote evidence to user grounding.
 *
 * Defensive by design: the source's actual role/author/identity is
 * verified, not just the evidence kind, so a malformed value that lies
 * about its kind still never grounds.
 */
export function isUserGrounded(evidence: MemoryEvidence): boolean {
  switch (evidence.kind) {
    case "user_statement":
    case "user_confirmation": {
      const source = evidence.source;
      if (source.kind === "manual_entry") {
        return isCanonicalUuid(source.manualEntryId);
      }
      return source.kind === "conversation_message" && source.role === "user";
    }
    case "imported":
      return evidence.source.kind === "imported_record" && evidence.source.author === "user";
    case "model_inference":
    case "assistant_dialogue":
      return false;
  }
}

/**
 * Visibility rule: shared memories are visible to every family;
 * family-private memories only on exact family match. Visibility never
 * overrides grounding and grounding never overrides visibility — factual
 * retrieval requires active lifecycle AND isUserGrounded AND isVisibleTo.
 */
export function isVisibleTo(scope: MemoryScope, currentModelFamily: ModelFamilyId): boolean {
  return scope.kind === "shared" || scope.modelFamily === currentModelFamily;
}
