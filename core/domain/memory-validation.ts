/**
 * Handwritten runtime validators for the canonical memory schemas. Pure
 * and in-memory only: schema-level shape rules and stream-level ordering
 * rules live here; store concerns (empty-target preconditions,
 * all-or-nothing writes, fsync, JSONL I/O, torn-tail recovery, import
 * execution) belong to later commits and are deliberately absent.
 *
 * Unknown fields are rejected recursively on every canonical persisted
 * shape — this is what makes stored lifecycle/trusted/grounded booleans
 * structurally impossible, not just discouraged.
 */

import { isCanonicalUuid, isDelosSlug } from "./ids.js";
import {
  MEMORY_BUNDLE_FORMAT,
  MEMORY_SCHEMA_VERSION,
  type MemoryEventEnvelope,
  type MemoryExportBundle,
} from "./memory.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

// ---------------------------------------------------------------------------
// Small shared checks
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Canonical timestamp rule: exactly the UTC Date.toISOString() form
 * (`YYYY-MM-DDTHH:MM:SS.mmmZ`, millisecond precision), verified by an
 * exact reparse round-trip. Higher fractional precision, missing
 * milliseconds, and rolled-over calendar dates (e.g. 2026-02-30) are all
 * rejected — one instant has exactly one canonical textual form.
 */
export function isIsoUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/** Missing-required and unknown-field checks for one object shape. */
function checkShape(
  obj: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!(key in obj)) {
      issues.push({ path: `${path}.${key}`, message: "required field is missing" });
    }
  }
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: "unknown field is not allowed on canonical shapes",
      });
    }
  }
}

function checkUuid(
  obj: Record<string, unknown>,
  key: string,
  idName: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!(key in obj)) {
    return; // already reported by checkShape
  }
  const value = obj[key];
  if (typeof value !== "string" || !isCanonicalUuid(value)) {
    issues.push({
      path: `${path}.${key}`,
      message: `${idName} must be a canonical lowercase hyphenated UUID`,
    });
  }
}

function checkSlug(
  obj: Record<string, unknown>,
  key: string,
  idName: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!(key in obj)) {
    return;
  }
  const value = obj[key];
  if (typeof value !== "string" || !isDelosSlug(value)) {
    issues.push({
      path: `${path}.${key}`,
      message: `${idName} must be a lowercase slug matching ^[a-z][a-z0-9-]{0,31}$`,
    });
  }
}

function checkNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!(key in obj)) {
    return;
  }
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path: `${path}.${key}`, message: `${key} must be a non-empty string` });
  }
}

// ---------------------------------------------------------------------------
// Source references
// ---------------------------------------------------------------------------

function checkConversationMessageRef(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  requiredRole: "user" | "assistant" | null,
): void {
  if (!isRecord(value) || value["kind"] !== "conversation_message") {
    issues.push({ path, message: "expected a conversation_message reference" });
    return;
  }
  checkShape(value, path, issues, ["kind", "conversationId", "turnId", "messageId", "role"], [
    "external",
  ]);
  checkUuid(value, "conversationId", "ConversationId", path, issues);
  checkUuid(value, "turnId", "TurnId", path, issues);
  checkUuid(value, "messageId", "MessageId", path, issues);
  const role = value["role"];
  if (role !== "user" && role !== "assistant") {
    issues.push({ path: `${path}.role`, message: 'role must be "user" or "assistant"' });
  } else if (requiredRole !== null && role !== requiredRole) {
    issues.push({
      path: `${path}.role`,
      message: `this evidence kind requires a ${requiredRole}-role message source`,
    });
  }
  const external = value["external"];
  if (external !== undefined) {
    // Optional annotation only: type-checked, never required, never identity.
    if (!isRecord(external)) {
      issues.push({ path: `${path}.external`, message: "external annotation must be an object" });
    } else {
      checkShape(external, `${path}.external`, issues, [], ["source", "externalTurnKey"]);
      for (const key of ["source", "externalTurnKey"] as const) {
        if (key in external && typeof external[key] !== "string") {
          issues.push({ path: `${path}.external.${key}`, message: `${key} must be a string` });
        }
      }
    }
  }
}

function checkImportedRecordRef(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): "user" | "assistant" | "unknown" | null {
  if (!isRecord(value) || value["kind"] !== "imported_record") {
    issues.push({ path, message: "expected an imported_record reference" });
    return null;
  }
  checkShape(value, path, issues, ["kind", "importId", "recordLocator", "author"]);
  checkUuid(value, "importId", "ImportId", path, issues);
  checkNonEmptyString(value, "recordLocator", path, issues);
  const author = value["author"];
  if (author !== "user" && author !== "assistant" && author !== "unknown") {
    issues.push({
      path: `${path}.author`,
      message: 'author must be "user", "assistant", or "unknown"',
    });
    return null;
  }
  return author;
}

function checkManualEntryRef(value: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  checkShape(value, path, issues, ["kind", "manualEntryId"], ["context"]);
  checkUuid(value, "manualEntryId", "ManualEntryId", path, issues);
  if (value["context"] !== undefined) {
    checkConversationMessageRef(value["context"], `${path}.context`, issues, null);
  }
}

/** user_statement / user_confirmation source: user-role message or identified manual entry. */
function checkUserActionSource(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (isRecord(value) && value["kind"] === "manual_entry") {
    checkManualEntryRef(value, path, issues);
    return;
  }
  if (isRecord(value) && value["kind"] === "conversation_message") {
    checkConversationMessageRef(value, path, issues, "user");
    return;
  }
  issues.push({
    path,
    message: "source must be a conversation_message or manual_entry reference",
  });
}

// ---------------------------------------------------------------------------
// Scope, origin, evidence
// ---------------------------------------------------------------------------

function checkScope(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "scope must be an object" });
    return;
  }
  const kind = value["kind"];
  if (kind === "shared") {
    checkShape(value, path, issues, ["kind"]);
  } else if (kind === "model_private") {
    checkShape(value, path, issues, ["kind", "modelFamily"]);
    checkSlug(value, "modelFamily", "ModelFamilyId", path, issues);
  } else {
    issues.push({ path: `${path}.kind`, message: 'scope kind must be "shared" or "model_private"' });
  }
}

function checkOrigin(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "origin must be an object" });
    return;
  }
  checkShape(value, path, issues, ["modelFamily"], ["instanceId"]);
  checkSlug(value, "modelFamily", "ModelFamilyId", path, issues);
  if ("instanceId" in value) {
    checkSlug(value, "instanceId", "AssistantInstanceId", path, issues);
  }
}

function checkConfidence(value: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  if (!("confidence" in value)) {
    return;
  }
  const confidence = value["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    issues.push({
      path: `${path}.confidence`,
      message: "confidence must be a finite number within [0,1]",
    });
  }
}

function checkEvidence(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  allowUserConfirmation: boolean,
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "evidence must be an object" });
    return;
  }
  const kind = value["kind"];
  switch (kind) {
    case "user_statement": {
      checkShape(value, path, issues, ["kind", "source"]);
      checkUserActionSource(value["source"], `${path}.source`, issues);
      break;
    }
    case "user_confirmation": {
      if (!allowUserConfirmation) {
        issues.push({
          path: `${path}.kind`,
          message: "user_confirmation is not allowed on memory_created; nothing exists yet to confirm",
        });
      }
      checkShape(value, path, issues, ["kind", "source"]);
      checkUserActionSource(value["source"], `${path}.source`, issues);
      break;
    }
    case "model_inference": {
      checkShape(value, path, issues, ["kind", "origin"], ["confidence", "derivedFrom"]);
      checkOrigin(value["origin"], `${path}.origin`, issues);
      checkConfidence(value, path, issues);
      if ("derivedFrom" in value) {
        const derivedFrom = value["derivedFrom"];
        if (!Array.isArray(derivedFrom)) {
          issues.push({ path: `${path}.derivedFrom`, message: "derivedFrom must be an array" });
        } else {
          derivedFrom.forEach((ref, i) => {
            checkConversationMessageRef(ref, `${path}.derivedFrom[${i}]`, issues, null);
          });
        }
      }
      break;
    }
    case "assistant_dialogue": {
      checkShape(value, path, issues, ["kind", "origin", "source"]);
      checkOrigin(value["origin"], `${path}.origin`, issues);
      checkConversationMessageRef(value["source"], `${path}.source`, issues, "assistant");
      break;
    }
    case "imported": {
      checkShape(value, path, issues, ["kind", "source"], ["origin", "confidence"]);
      const author = checkImportedRecordRef(value["source"], `${path}.source`, issues);
      if ("origin" in value) {
        if (author !== null && author !== "assistant") {
          issues.push({
            path: `${path}.origin`,
            message: 'origin is only permitted when the imported author is "assistant"',
          });
        }
        checkOrigin(value["origin"], `${path}.origin`, issues);
      }
      checkConfidence(value, path, issues);
      break;
    }
    default: {
      issues.push({
        path: `${path}.kind`,
        message:
          "evidence kind must be user_statement, user_confirmation, model_inference, assistant_dialogue, or imported",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Events and envelopes
// ---------------------------------------------------------------------------

function checkEvent(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "event must be an object" });
    return;
  }
  const type = value["type"];
  switch (type) {
    case "memory_created": {
      checkShape(value, path, issues, ["type", "memoryId", "content", "evidence", "scope"]);
      checkUuid(value, "memoryId", "MemoryId", path, issues);
      checkNonEmptyString(value, "content", path, issues);
      checkEvidence(value["evidence"], `${path}.evidence`, issues, false);
      checkScope(value["scope"], `${path}.scope`, issues);
      break;
    }
    case "memory_revised": {
      checkShape(value, path, issues, [
        "type",
        "memoryId",
        "revisionId",
        "revisionKind",
        "content",
        "evidence",
        "scope",
      ]);
      checkUuid(value, "memoryId", "MemoryId", path, issues);
      checkUuid(value, "revisionId", "RevisionId", path, issues);
      const revisionKind = value["revisionKind"];
      if (revisionKind !== "amendment" && revisionKind !== "correction") {
        issues.push({
          path: `${path}.revisionKind`,
          message: 'revisionKind must be "amendment" or "correction"',
        });
      }
      checkNonEmptyString(value, "content", path, issues);
      checkEvidence(value["evidence"], `${path}.evidence`, issues, true);
      checkScope(value["scope"], `${path}.scope`, issues);
      break;
    }
    case "memory_superseded": {
      checkShape(value, path, issues, ["type", "memoryId", "supersededByMemoryId"], ["reason"]);
      checkUuid(value, "memoryId", "MemoryId", path, issues);
      checkUuid(value, "supersededByMemoryId", "MemoryId", path, issues);
      if ("reason" in value && typeof value["reason"] !== "string") {
        issues.push({ path: `${path}.reason`, message: "reason must be a string" });
      }
      break;
    }
    case "memory_deactivated": {
      checkShape(value, path, issues, ["type", "memoryId"], ["reason"]);
      checkUuid(value, "memoryId", "MemoryId", path, issues);
      if ("reason" in value && typeof value["reason"] !== "string") {
        issues.push({ path: `${path}.reason`, message: "reason must be a string" });
      }
      break;
    }
    default: {
      issues.push({
        path: `${path}.type`,
        message:
          "event type must be memory_created, memory_revised, memory_superseded, or memory_deactivated",
      });
    }
  }
}

export function validateMemoryEventEnvelope(
  value: unknown,
  path = "$",
): ValidationResult<MemoryEventEnvelope> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path, message: "envelope must be an object" }] };
  }
  checkShape(value, path, issues, ["schemaVersion", "eventId", "occurredAt", "event"]);
  if ("schemaVersion" in value && value["schemaVersion"] !== MEMORY_SCHEMA_VERSION) {
    issues.push({
      path: `${path}.schemaVersion`,
      message: `schemaVersion must be exactly ${MEMORY_SCHEMA_VERSION}`,
    });
  }
  checkUuid(value, "eventId", "MemoryEventId", path, issues);
  if ("occurredAt" in value) {
    const occurredAt = value["occurredAt"];
    if (typeof occurredAt !== "string" || !isIsoUtcTimestamp(occurredAt)) {
      issues.push({
        path: `${path}.occurredAt`,
        message: "occurredAt must be a UTC Date.toISOString() timestamp (YYYY-MM-DDTHH:MM:SS.mmmZ)",
      });
    }
  }
  if ("event" in value) {
    checkEvent(value["event"], `${path}.event`, issues);
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: value as unknown as MemoryEventEnvelope };
}

// ---------------------------------------------------------------------------
// Stream-level validation (pure, in-memory; array order is authoritative)
// ---------------------------------------------------------------------------

function validateEnvelopeStream(
  value: unknown,
  basePath: string,
): ValidationResult<MemoryEventEnvelope[]> {
  if (!Array.isArray(value)) {
    return { ok: false, issues: [{ path: basePath, message: "event stream must be an array" }] };
  }
  const issues: ValidationIssue[] = [];
  const envelopes: MemoryEventEnvelope[] = [];
  (value as unknown[]).forEach((element, i) => {
    const result = validateMemoryEventEnvelope(element, `${basePath}[${i}]`);
    if (result.ok) {
      envelopes.push(result.value);
    } else {
      issues.push(...result.issues);
    }
  });
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const seenEventIds = new Set<string>();
  const seenRevisionIds = new Set<string>();
  const lifecycle = new Map<string, "active" | "superseded" | "inactive">();
  envelopes.forEach((envelope, i) => {
    const path = `${basePath}[${i}]`;
    if (seenEventIds.has(envelope.eventId)) {
      issues.push({ path: `${path}.eventId`, message: "duplicate eventId in stream" });
    }
    seenEventIds.add(envelope.eventId);
    const event = envelope.event;
    switch (event.type) {
      case "memory_created": {
        if (lifecycle.has(event.memoryId)) {
          issues.push({
            path: `${path}.event.memoryId`,
            message: "memoryId was already created earlier in the stream",
          });
        } else {
          lifecycle.set(event.memoryId, "active");
        }
        break;
      }
      case "memory_revised": {
        if (seenRevisionIds.has(event.revisionId)) {
          issues.push({ path: `${path}.event.revisionId`, message: "duplicate revisionId in stream" });
        }
        seenRevisionIds.add(event.revisionId);
        const state = lifecycle.get(event.memoryId);
        if (state === undefined) {
          issues.push({
            path: `${path}.event.memoryId`,
            message: "memory_revised targets a memory not created earlier in the stream",
          });
        } else if (state !== "active") {
          issues.push({
            path: `${path}.event.memoryId`,
            message: `memory_revised targets a ${state} memory; terminal states cannot change`,
          });
        }
        break;
      }
      case "memory_superseded": {
        const state = lifecycle.get(event.memoryId);
        if (state === undefined) {
          issues.push({
            path: `${path}.event.memoryId`,
            message: "memory_superseded targets a memory not created earlier in the stream",
          });
        } else if (state !== "active") {
          issues.push({
            path: `${path}.event.memoryId`,
            message: `memory_superseded targets a ${state} memory; terminal states cannot change`,
          });
        }
        if (event.supersededByMemoryId === event.memoryId) {
          issues.push({
            path: `${path}.event.supersededByMemoryId`,
            message: "a memory cannot supersede itself",
          });
        } else {
          const target = lifecycle.get(event.supersededByMemoryId);
          if (target === undefined) {
            issues.push({
              path: `${path}.event.supersededByMemoryId`,
              message: "supersededByMemoryId must reference a memory created earlier in the stream",
            });
          } else if (target !== "active") {
            issues.push({
              path: `${path}.event.supersededByMemoryId`,
              message: `supersededByMemoryId must reference an active memory, but the target is ${target}`,
            });
          }
        }
        if (state === "active") {
          lifecycle.set(event.memoryId, "superseded");
        }
        break;
      }
      case "memory_deactivated": {
        const state = lifecycle.get(event.memoryId);
        if (state === undefined) {
          issues.push({
            path: `${path}.event.memoryId`,
            message: "memory_deactivated targets a memory not created earlier in the stream",
          });
        } else if (state !== "active") {
          issues.push({
            path: `${path}.event.memoryId`,
            message: `memory_deactivated targets a ${state} memory; terminal states cannot change`,
          });
        } else {
          lifecycle.set(event.memoryId, "inactive");
        }
        break;
      }
    }
  });
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: envelopes };
}

export function validateMemoryEventStream(value: unknown): ValidationResult<MemoryEventEnvelope[]> {
  return validateEnvelopeStream(value, "$");
}

// ---------------------------------------------------------------------------
// Export bundle
// ---------------------------------------------------------------------------

export function validateMemoryExportBundle(value: unknown): ValidationResult<MemoryExportBundle> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path: "$", message: "bundle must be an object" }] };
  }
  checkShape(value, "$", issues, ["bundleFormat", "schemaVersion", "exportedAt", "events"]);
  if ("bundleFormat" in value && value["bundleFormat"] !== MEMORY_BUNDLE_FORMAT) {
    issues.push({
      path: "$.bundleFormat",
      message: `bundleFormat must be exactly "${MEMORY_BUNDLE_FORMAT}"`,
    });
  }
  if ("schemaVersion" in value && value["schemaVersion"] !== MEMORY_SCHEMA_VERSION) {
    issues.push({
      path: "$.schemaVersion",
      message: `schemaVersion must be exactly ${MEMORY_SCHEMA_VERSION}`,
    });
  }
  if ("exportedAt" in value) {
    const exportedAt = value["exportedAt"];
    if (typeof exportedAt !== "string" || !isIsoUtcTimestamp(exportedAt)) {
      issues.push({
        path: "$.exportedAt",
        message: "exportedAt must be a UTC Date.toISOString() timestamp (YYYY-MM-DDTHH:MM:SS.mmmZ)",
      });
    }
  }
  if ("events" in value) {
    const streamResult = validateEnvelopeStream(value["events"], "$.events");
    if (!streamResult.ok) {
      issues.push(...streamResult.issues);
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: value as unknown as MemoryExportBundle };
}
