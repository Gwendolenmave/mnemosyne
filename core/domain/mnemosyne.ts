/**
 * Mnemosyne governance overlay: the append-only event vocabulary for the
 * dimensions the transplanted kernel deliberately does not model —
 * classification attributes, approval, sealing, expiry, retrieval
 * permission, and House Prior versions.
 *
 * Discipline mirrors the kernel exactly (M1.1a correction #4): events are
 * the only truth, current state is fold-derived, and there is no parallel
 * mutable history anywhere. Governance events live in the SAME SQLite
 * events table under subject_kind 'governance' / 'prior'.
 *
 * Actor rule (acceptance: "the agent cannot promote or edit priors"):
 * confirming, sealing, unsealing, retrieval overrides, and prior
 * approvals REQUIRE a human actor (owner | companion). 'system' may only
 * propose attributes, expiry metadata, and prior drafts.
 */

import type { AuthorityRole } from "./principals.js";

/** Canonical role persisted in events; deployment identities bind via PrincipalRegistry. */
export type MnemosyneActor = AuthorityRole;
export type MnemosyneScope = "global" | "relationship" | "project" | "au" | "session";
export type MnemosyneSensitivity = "normal" | "sensitive" | "intimate";
export type PriorKey = "identity" | "relationship" | "household_now" | "project_now";

/** Orthogonal evidence axis written by current proposal/governance writers. */
export type CanonicalSourceBasis = "explicit" | "observed" | "inferred" | "imported";

/**
 * Historical conflated workflow/evidence values. They remain readable so
 * append-only history can be folded, but new writers should use the canonical
 * evidence axis plus ProposalOrigin instead of creating new conflated values.
 */
export type LegacySourceBasis =
  | "user_stated"
  | "owner_requested"
  | "companion_self"
  | "muse_suggestion";

/** Orthogonal workflow axis: which path initiated the proposal. */
export type ProposalOrigin = "companion_self" | "owner_request" | "muse_signal" | "backfill";

export interface AttributesSetEvent {
  type: "attributes_set";
  memoryId: string;
  title: string;
  tags: string[];
  scope: MnemosyneScope;
  auId?: string;
  sensitivity: MnemosyneSensitivity;
  importance: 1 | 2 | 3;
  /** `derived` is accepted only as historical compatibility input. */
  sourceBasis?: CanonicalSourceBasis | "derived";
}

export interface ConfirmedEvent {
  type: "confirmed";
  memoryId: string;
  by: "owner" | "companion" | "both";
}

/**
 * Workflow provenance roles (three-paths directive). Descriptive
 * metadata about who discovered/requested/proposed/authored/reviewed/
 * edited a card — authority still lives in confirmed/attributes actors,
 * and confirmed_by is deliberately NOT representable here (it derives
 * from confirmed events only; the axes never merge).
 */
export interface ProvenanceRoles {
  source_basis?: CanonicalSourceBasis | LegacySourceBasis;
  discovered_by?: "muse" | "owner" | "companion";
  requested_by?: "owner" | "companion";
  proposed_by?: "owner" | "companion";
  authored_by?: "owner" | "companion";
  reviewed_by?: "owner" | "companion";
  edited_by?: "owner" | "companion";
  /**
   * D0 orthogonal origin axis: which workflow started the proposal.
   * Legacy cards carry only source_basis; deriveProvenanceAxes maps them
   * without rewriting history.
   */
  proposal_origin?: ProposalOrigin;
}

/**
 * D0 compatibility reader: derive the orthogonal (evidence basis ×
 * proposal origin) axes from stored roles, mapping legacy conflated
 * source_basis values. Historical events are NEVER rewritten; unknown
 * stays null (never invented).
 */
export function deriveProvenanceAxes(roles: ProvenanceRoles | null): {
  evidenceBasis: CanonicalSourceBasis | null;
  proposalOrigin: ProposalOrigin | null;
} {
  if (roles === null) {
    return { evidenceBasis: null, proposalOrigin: null };
  }
  const sourceBasis = roles.source_basis;
  const origin =
    roles.proposal_origin ??
    (sourceBasis === "owner_requested"
      ? "owner_request"
      : sourceBasis === "companion_self"
        ? "companion_self"
        : sourceBasis === "muse_suggestion"
          ? "muse_signal"
          : sourceBasis === "user_stated"
            ? (roles.requested_by === "owner" ? "owner_request" : "companion_self")
            : null);
  const basis: CanonicalSourceBasis | null =
    sourceBasis === "explicit" ||
    sourceBasis === "observed" ||
    sourceBasis === "inferred" ||
    sourceBasis === "imported"
      ? sourceBasis
      : sourceBasis === "user_stated"
        ? "explicit"
        : null;
  return { evidenceBasis: basis, proposalOrigin: origin };
}

export interface ProvenanceSetEvent {
  type: "provenance_set";
  memoryId: string;
  roles: ProvenanceRoles;
}

export interface SealedEvent {
  type: "sealed";
  memoryId: string;
}

export interface UnsealedEvent {
  type: "unsealed";
  memoryId: string;
}

export interface ExpirySetEvent {
  type: "expiry_set";
  memoryId: string;
  expiresAt: string | null;
}

export interface RetrievalSetEvent {
  type: "retrieval_set";
  memoryId: string;
  enabled: boolean;
}

/**
 * Owner-policy activation: a distinct
 * retrieval-eligible state that never claims individual confirmation.
 * Actor is the executing system; the authority is the referenced owner
 * policy, and confirmed_by stays NULL by construction (only confirmed
 * events set it — the axes never merge).
 */
export interface PolicyActivatedEvent {
  type: "policy_activated";
  memoryId: string;
  policyId: string;
  activationBasis: "owner_policy";
  /** Evidence character under the D0 axes (inferred never activates). */
  sourceBasis: "explicit" | "observed";
  /** Verified generator/model identity that authored the card. */
  generator: string;
}

/**
 * Immutable metadata-only receipt for one reviewed policy-card revision.
 * It is appended atomically with the revision and deliberately has no fold
 * effect. Durable history can therefore resolve exact replay before creating
 * timestamps/UUIDs or touching projections/backups/audit sinks.
 */
export interface PolicyRevisionRecordedEvent {
  type: "policy_revision_recorded";
  memoryId: string;
  decisionId: string;
  targetDigest: string;
  sourceSha256: string;
  preconditionDigest: string;
}

/**
 * Durable owner policy (work order §5.1): stored as governance authority
 * in the event stream, not inferred from an environment flag. The actor
 * is "system" recording a standing owner ruling; authorityRef pins the
 * exact owner order (sha256) so nothing claims a hand Owner never moved.
 */
export interface OwnerPolicySetEvent {
  type: "owner_policy_set";
  policyId: string;
  authority: "owner_global_policy";
  effectiveFrom: string;
  manualPerCardApprovalRequired: boolean;
  ownerCanViewEditRevoke: boolean;
  authorityRef: string;
}

export interface PriorProposedEvent {
  type: "prior_proposed";
  key: PriorKey;
  body: string;
  tokenEst: number;
  changelog: string;
  expiresAt?: string | null;
}

export interface PriorApprovedEvent {
  type: "prior_approved";
  key: PriorKey;
  by: "owner" | "companion" | "both";
}

export type MnemosyneEvent =
  | AttributesSetEvent
  | ConfirmedEvent
  | ProvenanceSetEvent
  | SealedEvent
  | UnsealedEvent
  | ExpirySetEvent
  | RetrievalSetEvent
  | PolicyActivatedEvent
  | PolicyRevisionRecordedEvent
  | OwnerPolicySetEvent
  | PriorProposedEvent
  | PriorApprovedEvent;

export interface MnemosyneEnvelope {
  eventId: string;
  occurredAt: string;
  actor: MnemosyneActor;
  event: MnemosyneEvent;
}

export interface MnemosyneIssue {
  path: string;
  message: string;
}

const SCOPES: readonly string[] = ["global", "relationship", "project", "au", "session"];
const SENSITIVITIES: readonly string[] = ["normal", "sensitive", "intimate"];
const PRIOR_KEYS: readonly string[] = ["identity", "relationship", "household_now", "project_now"];
const SOURCE_BASES: readonly string[] = ["explicit", "observed", "inferred", "imported", "derived"];
const PROVENANCE_SOURCE_BASES: readonly string[] = [
  "explicit",
  "observed",
  "inferred",
  "imported",
  "user_stated",
  "owner_requested",
  "companion_self",
  "muse_suggestion",
];
const HUMAN_ONLY_TYPES: readonly string[] = [
  "confirmed",
  "sealed",
  "unsealed",
  "retrieval_set",
  "prior_approved",
];
const SHA256_RE = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural + policy validation of one governance stream (untrusted). */
export function validateMnemosyneStream(
  input: unknown,
): { ok: true; value: MnemosyneEnvelope[] } | { ok: false; issues: MnemosyneIssue[] } {
  const issues: MnemosyneIssue[] = [];
  if (!Array.isArray(input)) {
    return { ok: false, issues: [{ path: "$", message: "stream must be an array" }] };
  }
  const seenEventIds = new Set<string>();
  input.forEach((raw, index) => {
    const path = `$[${index}]`;
    if (!isRecord(raw)) {
      issues.push({ path, message: "envelope must be an object" });
      return;
    }
    if (typeof raw.eventId !== "string" || raw.eventId.length === 0) {
      issues.push({ path: `${path}.eventId`, message: "eventId required" });
    } else if (seenEventIds.has(raw.eventId)) {
      issues.push({ path: `${path}.eventId`, message: "duplicate eventId" });
    } else {
      seenEventIds.add(raw.eventId);
    }
    if (typeof raw.occurredAt !== "string") {
      issues.push({ path: `${path}.occurredAt`, message: "occurredAt required" });
    }
    const actor = raw.actor;
    if (actor !== "owner" && actor !== "companion" && actor !== "system") {
      issues.push({ path: `${path}.actor`, message: "actor must be owner|companion|system" });
    }
    const event = raw.event;
    if (!isRecord(event) || typeof event.type !== "string") {
      issues.push({ path: `${path}.event`, message: "event with a type is required" });
      return;
    }
    if (HUMAN_ONLY_TYPES.includes(event.type) && actor === "system") {
      issues.push({
        path: `${path}.actor`,
        message: `${event.type} requires a human actor (owner or companion); the agent cannot promote`,
      });
    }
    switch (event.type) {
      case "attributes_set": {
        if (typeof event.memoryId !== "string") issues.push({ path, message: "memoryId required" });
        if (typeof event.title !== "string" || event.title.length === 0)
          issues.push({ path: `${path}.title`, message: "title required" });
        if (!Array.isArray(event.tags) || event.tags.some((t) => typeof t !== "string"))
          issues.push({ path: `${path}.tags`, message: "tags must be string[]" });
        if (!SCOPES.includes(event.scope as string))
          issues.push({ path: `${path}.scope`, message: "invalid scope" });
        if (event.scope === "au" && typeof event.auId !== "string")
          issues.push({ path: `${path}.auId`, message: "au scope requires auId" });
        if (!SENSITIVITIES.includes(event.sensitivity as string))
          issues.push({ path: `${path}.sensitivity`, message: "invalid sensitivity" });
        if (![1, 2, 3].includes(event.importance as number))
          issues.push({ path: `${path}.importance`, message: "importance must be 1..3" });
        if (event.sourceBasis !== undefined && !SOURCE_BASES.includes(event.sourceBasis as string))
          issues.push({ path: `${path}.sourceBasis`, message: "invalid sourceBasis" });
        break;
      }
      case "confirmed":
      case "prior_approved": {
        if (!["owner", "companion", "both"].includes((event as { by?: unknown }).by as string))
          issues.push({ path: `${path}.by`, message: "by must be owner|companion|both" });
        break;
      }
      case "sealed":
      case "unsealed":
      case "expiry_set":
      case "retrieval_set":
        if (typeof (event as { memoryId?: unknown }).memoryId !== "string")
          issues.push({ path: `${path}.memoryId`, message: "memoryId required" });
        break;
      case "policy_activated": {
        const e = event as Partial<PolicyActivatedEvent>;
        if (typeof e.memoryId !== "string")
          issues.push({ path: `${path}.memoryId`, message: "memoryId required" });
        if (typeof e.policyId !== "string" || e.policyId.length === 0)
          issues.push({ path: `${path}.policyId`, message: "policyId required" });
        if (e.activationBasis !== "owner_policy")
          issues.push({ path: `${path}.activationBasis`, message: "activationBasis must be owner_policy" });
        if (e.sourceBasis !== "explicit" && e.sourceBasis !== "observed")
          issues.push({ path: `${path}.sourceBasis`, message: "sourceBasis must be explicit|observed" });
        if (typeof e.generator !== "string" || e.generator.length === 0)
          issues.push({ path: `${path}.generator`, message: "generator identity required" });
        break;
      }
      case "policy_revision_recorded": {
        const e = event as Partial<PolicyRevisionRecordedEvent>;
        if (typeof e.memoryId !== "string" || e.memoryId.length === 0)
          issues.push({ path: `${path}.memoryId`, message: "memoryId required" });
        if (
          typeof e.decisionId !== "string" ||
          e.decisionId.length === 0 ||
          e.decisionId.length > 200 ||
          e.decisionId !== e.decisionId.trim()
        ) {
          issues.push({ path: `${path}.decisionId`, message: "decisionId must be a trimmed 1..200 char string" });
        }
        if (typeof e.targetDigest !== "string" || !SHA256_RE.test(e.targetDigest))
          issues.push({ path: `${path}.targetDigest`, message: "targetDigest must be lowercase sha256 hex" });
        if (typeof e.sourceSha256 !== "string" || !SHA256_RE.test(e.sourceSha256))
          issues.push({ path: `${path}.sourceSha256`, message: "sourceSha256 must be lowercase sha256 hex" });
        if (typeof e.preconditionDigest !== "string" || !SHA256_RE.test(e.preconditionDigest))
          issues.push({ path: `${path}.preconditionDigest`, message: "preconditionDigest must be lowercase sha256 hex" });
        break;
      }
      case "owner_policy_set": {
        const e = event as Partial<OwnerPolicySetEvent>;
        if (typeof e.policyId !== "string" || e.policyId.length === 0)
          issues.push({ path: `${path}.policyId`, message: "policyId required" });
        if (e.authority !== "owner_global_policy")
          issues.push({ path: `${path}.authority`, message: "authority must be owner_global_policy" });
        if (typeof e.effectiveFrom !== "string")
          issues.push({ path: `${path}.effectiveFrom`, message: "effectiveFrom required" });
        if (typeof e.manualPerCardApprovalRequired !== "boolean")
          issues.push({ path: `${path}.manualPerCardApprovalRequired`, message: "boolean required" });
        if (typeof e.ownerCanViewEditRevoke !== "boolean")
          issues.push({ path: `${path}.ownerCanViewEditRevoke`, message: "boolean required" });
        if (typeof e.authorityRef !== "string" || e.authorityRef.length === 0)
          issues.push({ path: `${path}.authorityRef`, message: "authorityRef required" });
        break;
      }
      case "provenance_set": {
        if (typeof (event as { memoryId?: unknown }).memoryId !== "string")
          issues.push({ path: `${path}.memoryId`, message: "memoryId required" });
        const roles = (event as { roles?: unknown }).roles;
        if (!isRecord(roles)) {
          issues.push({ path: `${path}.roles`, message: "roles object required" });
          break;
        }
        const allowed: Record<string, readonly string[]> = {
          source_basis: PROVENANCE_SOURCE_BASES,
          discovered_by: ["muse", "owner", "companion"],
          requested_by: ["owner", "companion"],
          proposed_by: ["owner", "companion"],
          authored_by: ["owner", "companion"],
          reviewed_by: ["owner", "companion"],
          edited_by: ["owner", "companion"],
          proposal_origin: ["companion_self", "owner_request", "muse_signal", "backfill"],
        };
        for (const [key, value] of Object.entries(roles)) {
          const values = allowed[key];
          if (values === undefined) {
            // confirmed_by lands here on purpose: that axis only ever
            // derives from confirmed events and can never be set here.
            issues.push({ path: `${path}.roles.${key}`, message: "unknown provenance role" });
          } else if (typeof value !== "string" || !values.includes(value)) {
            issues.push({ path: `${path}.roles.${key}`, message: "invalid provenance value" });
          }
        }
        break;
      }
      case "prior_proposed": {
        if (!PRIOR_KEYS.includes((event as { key?: unknown }).key as string))
          issues.push({ path: `${path}.key`, message: "invalid prior key" });
        if (typeof (event as { body?: unknown }).body !== "string")
          issues.push({ path: `${path}.body`, message: "body required" });
        break;
      }
      default:
        issues.push({ path: `${path}.event.type`, message: `unknown event type ${event.type}` });
    }
    if (event.type === "prior_approved" && !PRIOR_KEYS.includes((event as { key?: unknown }).key as string)) {
      issues.push({ path: `${path}.key`, message: "invalid prior key" });
    }
  });
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: structuredClone(input) as MnemosyneEnvelope[] };
}

export interface MnemosyneItemOverlay {
  title: string | null;
  tags: string[];
  scope: MnemosyneScope;
  auId: string | null;
  sensitivity: MnemosyneSensitivity;
  importance: 1 | 2 | 3;
  sourceBasis: string | null;
  approvalState: "candidate" | "confirmed" | "policy_activated";
  confirmedBy: string | null;
  sealState: "unsealed" | "sealed";
  expiresAt: string | null;
  /** null = policy default (sensitivity-driven); explicit override otherwise. */
  retrievalOverride: boolean | null;
  /** Workflow provenance roles; null = legacy/unknown (never invented). */
  provenance: ProvenanceRoles | null;
  /** D0 owner-policy activation record; null = never policy-activated. */
  activation: { policyId: string; sourceBasis: "explicit" | "observed"; generator: string } | null;
}

/** Current state of one durable owner policy (fold-derived). */
export interface OwnerPolicyCurrent {
  policyId: string;
  authority: "owner_global_policy";
  effectiveFrom: string;
  manualPerCardApprovalRequired: boolean;
  ownerCanViewEditRevoke: boolean;
  authorityRef: string;
}

export interface PriorCurrent {
  key: PriorKey;
  version: number;
  body: string;
  tokenEst: number;
  approvedBy: string;
  changelog: string;
  expiresAt: string | null;
}

export interface MnemosyneFoldState {
  overlays: Map<string, MnemosyneItemOverlay>;
  priors: Map<PriorKey, PriorCurrent>;
  policies: Map<string, OwnerPolicyCurrent>;
}

function defaultOverlay(): MnemosyneItemOverlay {
  return {
    title: null,
    tags: [],
    scope: "global",
    auId: null,
    sensitivity: "normal",
    importance: 1,
    sourceBasis: null,
    approvalState: "candidate",
    confirmedBy: null,
    sealState: "unsealed",
    expiresAt: null,
    retrievalOverride: null,
    provenance: null,
    activation: null,
  };
}

/** Pure fold; refuses unvalidated input, mirroring the kernel fold. */
export function foldMnemosyneEvents(stream: readonly unknown[]): MnemosyneFoldState {
  const validated = validateMnemosyneStream([...stream]);
  if (!validated.ok) {
    const first = validated.issues[0];
    throw new Error(
      `refusing to fold an invalid mnemosyne stream (${validated.issues.length} issues` +
        `${first ? `; first: ${first.path} — ${first.message}` : ""})`,
    );
  }
  const overlays = new Map<string, MnemosyneItemOverlay>();
  const priors = new Map<PriorKey, PriorCurrent>();
  const policies = new Map<string, OwnerPolicyCurrent>();
  const pendingPrior = new Map<PriorKey, PriorProposedEvent>();
  const priorVersions = new Map<PriorKey, number>();
  const overlay = (memoryId: string): MnemosyneItemOverlay => {
    let existing = overlays.get(memoryId);
    if (existing === undefined) {
      existing = defaultOverlay();
      overlays.set(memoryId, existing);
    }
    return existing;
  };
  for (const envelope of validated.value) {
    const event = envelope.event;
    switch (event.type) {
      case "attributes_set": {
        const o = overlay(event.memoryId);
        o.title = event.title;
        o.tags = [...event.tags];
        o.scope = event.scope;
        o.auId = event.auId ?? null;
        o.sensitivity = event.sensitivity;
        o.importance = event.importance;
        o.sourceBasis = event.sourceBasis ?? null;
        break;
      }
      case "confirmed": {
        const o = overlay(event.memoryId);
        o.approvalState = "confirmed";
        o.confirmedBy = event.by;
        break;
      }
      case "sealed":
        overlay(event.memoryId).sealState = "sealed";
        break;
      case "unsealed":
        overlay(event.memoryId).sealState = "unsealed";
        break;
      case "expiry_set":
        overlay(event.memoryId).expiresAt = event.expiresAt;
        break;
      case "retrieval_set":
        overlay(event.memoryId).retrievalOverride = event.enabled;
        break;
      case "provenance_set": {
        const o = overlay(event.memoryId);
        // Shallow merge: later events refine or add roles; axes are
        // never silently cleared (history shows every step anyway).
        o.provenance = { ...(o.provenance ?? {}), ...event.roles };
        break;
      }
      case "policy_activated": {
        const o = overlay(event.memoryId);
        // Individual confirmation always outranks policy activation:
        // a confirmed card never downgrades, and confirmed_by is never
        // touched here (it derives ONLY from confirmed events).
        if (o.approvalState === "candidate") {
          o.approvalState = "policy_activated";
        }
        // Policy activation is the later authoritative evidence-axis statement
        // for a policy-activated card. A rebuild must not revive a stale
        // attributes_set source basis from earlier history.
        o.sourceBasis = event.sourceBasis;
        o.activation = {
          policyId: event.policyId,
          sourceBasis: event.sourceBasis,
          generator: event.generator,
        };
        break;
      }
      case "policy_revision_recorded":
        // Metadata-only durable replay receipt; never changes projection.
        break;
      case "owner_policy_set":
        policies.set(event.policyId, {
          policyId: event.policyId,
          authority: event.authority,
          effectiveFrom: event.effectiveFrom,
          manualPerCardApprovalRequired: event.manualPerCardApprovalRequired,
          ownerCanViewEditRevoke: event.ownerCanViewEditRevoke,
          authorityRef: event.authorityRef,
        });
        break;
      case "prior_proposed":
        pendingPrior.set(event.key, event);
        break;
      case "prior_approved": {
        const proposal = pendingPrior.get(event.key);
        if (proposal !== undefined) {
          const version = (priorVersions.get(event.key) ?? 0) + 1;
          priorVersions.set(event.key, version);
          priors.set(event.key, {
            key: event.key,
            version,
            body: proposal.body,
            tokenEst: proposal.tokenEst,
            approvedBy: event.by,
            changelog: proposal.changelog,
            expiresAt: proposal.expiresAt ?? null,
          });
        }
        break;
      }
    }
  }
  return { overlays, priors, policies };
}
