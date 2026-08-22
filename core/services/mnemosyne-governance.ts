/**
 * Mnemosyne governance service: the ONLY runtime write path into the
 * memory house, and it only moves on explicit human decisions.
 *
 * UI-independent by construction: Telegram (or any later surface) is an
 * adapter that calls these operations; every rule lives here. The
 * ordinary chat runtime never holds a reference to this service, so
 * model output structurally cannot reach a write.
 *
 * Vocabulary mapping (existing kernel + governance events only — no
 * second source of truth):
 *   propose   = memory_created + attributes_set            (unconfirmed)
 *   approve   = confirmed{by: owner|companion|both}            (human only)
 *   edit      = memory_revised(amendment)                  (stays unconfirmed)
 *   revise    = memory_revised(correction) + confirmed{by} (one transaction)
 *   reject    = retrieval_set{false, human} + memory_deactivated
 *   revoke    = retrieval_set{false, human} + memory_deactivated
 * Reject/revoke keep full history and a TYPED human actor (the
 * retrieval_set event is human-only in the domain); nothing is ever
 * deleted or overwritten in place.
 *
 * Admission quarantine runs at proposal time: directive-like or
 * structural-injection text is refused outright, exactly as retrieval
 * would refuse it later. Muse and the model may SUGGEST, but no code
 * path here accepts a non-human confirmation actor.
 */

import { randomUUID } from "node:crypto";
import type { MemoryEventEnvelope } from "../domain/memory.js";
import type {
  MnemosyneEnvelope,
  OwnerPolicyCurrent,
  ProvenanceRoles,
} from "../domain/mnemosyne.js";
import { assessUntrustedBody, estimateTokens } from "./anamnesis.js";

export type HumanActor = "owner" | "companion" | "both";

export interface GovernanceIssue {
  path: string;
  message: string;
}

/** Structural store surface; the SQLite MnemosyneStore satisfies it. */
export interface GovernanceStore {
  appendJoint(
    kernel: readonly MemoryEventEnvelope[],
    governance: readonly MnemosyneEnvelope[],
  ):
    | { status: "appended"; kernel: number; governance: number }
    | { status: "rejected"; issues: GovernanceIssue[] };
  rebuildProjections(): Promise<{ items: number; priors: number }>;
  getItem(id: string): GovernanceItemView | undefined;
  listItems(): GovernanceItemView[];
  ftsSearch(query: string, limit: number): Array<{ itemId: string; rank: number }>;
  listSources(subjectKind: string, subjectId: string): Array<{ kind: string; pointer: string }>;
  /** D0: current durable owner policies (fold-derived from events). */
  currentPolicies(): Map<string, OwnerPolicyCurrent>;
}

export interface GovernanceItemView {
  id: string;
  title: string;
  body: string;
  scope: string;
  au_id: string | null;
  sensitivity: string;
  importance: number;
  approval_state: string;
  lifecycle_state: string;
  confirmed_by: string | null;
  retrieval: string;
  tags_text: string;
  created_at: string;
  updated_at: string;
  /** Workflow provenance JSON (v2 column); null = legacy/unknown. */
  provenance: string | null;
}

/** Safe parse of an item's provenance column. */
export function parseProvenance(item: GovernanceItemView): ProvenanceRoles | null {
  if (item.provenance === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(item.provenance);
    return parsed !== null && typeof parsed === "object" ? (parsed as ProvenanceRoles) : null;
  } catch {
    return null;
  }
}

/** Where a proposal's text is grounded. */
export type ProposalEvidence =
  | {
      kind: "transcript";
      conversationId: string;
      turnId: string;
      messageId: string;
      /** Optional transport annotation (e.g. telegram message id). */
      externalKey?: string;
    }
  | { kind: "manual"; note?: string };

export interface ProposeInput {
  body: string;
  title?: string;
  tags?: string[];
  scope: "global" | "relationship" | "project" | "au";
  auId?: string;
  sensitivity: "normal" | "sensitive" | "intimate";
  importance: 1 | 2 | 3;
  evidence: ProposalEvidence;
  /**
   * Logical proposer. NON-AUTHORITATIVE (review clarification #3):
   * authorship truth lives ONLY in provenance_set.authored_by, and
   * confirmation authority ONLY in confirmed events. This value feeds
   * the attributes_set actor unless executionActor overrides it.
   */
  proposedBy: "owner" | "companion";
  /**
   * The process executing the governed transaction (e.g. "system" for
   * the async Companion proposal pass). Defaults to proposedBy. Equally
   * non-authoritative; never affects retrieval eligibility.
   */
  executionActor?: "owner" | "companion" | "system";
  /** Workflow provenance roles, written as provenance_set in the SAME transaction. */
  provenance?: ProvenanceRoles;
}

export type GovernanceOutcome<T> =
  | ({ status: "ok" } & T)
  | { status: "refused"; issues: GovernanceIssue[] }
  | { status: "already"; detail: string };

export interface GovernanceWriteReceipt {
  memoryId: string;
  eventIds: string[];
  /** The events are durably committed (always true on status "ok"). */
  committed: true;
  backup: { ok: boolean; detail: string };
  /**
   * Retrying is safe and means retrying the BACKUP only — the memory
   * write itself is committed and must never be submitted again.
   */
  retrySafe: true;
}

export interface MnemosyneGovernanceOptions {
  store: GovernanceStore;
  /** Verified backup hook; throws on failure. Called after each write. */
  backup: (label: string) => { path: string };
  /** Metadata-only audit sink. NEVER receives bodies. */
  audit: (event: Record<string, unknown>) => void;
  now?: () => Date;
}

const MAX_BODY_CHARS = 2000;
const MAX_TITLE_CHARS = 120;

export class MnemosyneGovernanceService {
  private readonly store: GovernanceStore;
  private readonly backup: (label: string) => { path: string };
  private readonly audit: (event: Record<string, unknown>) => void;
  private readonly now: () => Date;

  constructor(options: MnemosyneGovernanceOptions) {
    this.store = options.store;
    this.backup = options.backup;
    this.audit = options.audit;
    this.now = options.now ?? (() => new Date());
  }

  // ---- proposals -------------------------------------------------------

  async propose(input: ProposeInput): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const issues: GovernanceIssue[] = [];
    const body = input.body.trim();
    const title = (input.title ?? body.slice(0, 60)).trim();
    if (body.length === 0) {
      issues.push({ path: "body", message: "memory text is required" });
    }
    if (body.length > MAX_BODY_CHARS) {
      issues.push({ path: "body", message: `memory text over ${MAX_BODY_CHARS} chars` });
    }
    if (title.length > MAX_TITLE_CHARS) {
      issues.push({ path: "title", message: `title over ${MAX_TITLE_CHARS} chars` });
    }
    if (input.scope === "au" && (input.auId === undefined || input.auId.length === 0)) {
      issues.push({ path: "auId", message: "au scope requires an AU id" });
    }
    for (const [field, text] of [
      ["body", body],
      ["title", title],
    ] as const) {
      if (text.length > 0) {
        const admission = assessUntrustedBody(text);
        if (!admission.ok) {
          issues.push({ path: field, message: admission.reason });
        }
      }
    }
    if (issues.length > 0) {
      return { status: "refused", issues };
    }

    const memoryId = randomUUID();
    const evidence =
      input.evidence.kind === "transcript"
        ? {
            kind: "user_statement" as const,
            source: {
              kind: "conversation_message" as const,
              conversationId: input.evidence.conversationId,
              turnId: input.evidence.turnId,
              messageId: input.evidence.messageId,
              role: "user" as const,
              ...(input.evidence.externalKey !== undefined
                ? { external: { source: "telegram", externalTurnKey: input.evidence.externalKey } }
                : {}),
            },
          }
        : {
            kind: "user_statement" as const,
            source: { kind: "manual_entry" as const, manualEntryId: randomUUID() },
          };

    const created = {
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      event: {
        type: "memory_created",
        memoryId,
        content: body,
        evidence,
        scope: { kind: "shared" },
      },
    } as unknown as MemoryEventEnvelope;
    const attributes: MnemosyneEnvelope = {
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      actor: input.executionActor ?? input.proposedBy,
      event: {
        type: "attributes_set",
        memoryId,
        title,
        tags: [...(input.tags ?? [])],
        scope: input.scope,
        ...(input.scope === "au" ? { auId: input.auId! } : {}),
        sensitivity: input.sensitivity,
        importance: input.importance,
        sourceBasis: "explicit",
      },
    };
    const governance: MnemosyneEnvelope[] = [attributes];
    if (input.provenance !== undefined && Object.keys(input.provenance).length > 0) {
      // Same transaction: a proposal never exists without its workflow
      // provenance. The event actor is the executing process; authorship
      // truth is the roles payload itself.
      governance.push({
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        actor: input.executionActor ?? input.proposedBy,
        event: { type: "provenance_set", memoryId, roles: { ...input.provenance } },
      });
    }
    return this.commit("propose", memoryId, [created], governance, {
      scope: input.scope,
      sensitivity: input.sensitivity,
      evidence_kind: input.evidence.kind,
      proposed_by: input.proposedBy,
      ...(input.provenance !== undefined ? { provenance_roles: { ...input.provenance } } : {}),
      token_estimate: estimateTokens(body),
    });
  }

  // ---- D0 owner-policy activation --------------------------------------

  /**
   * Idempotently register a durable owner policy (D0 §5.1). The event is
   * written once; re-running with identical fields is a no-op. The actor
   * is "system" recording a standing owner ruling pinned by authorityRef —
   * nothing here claims a per-card human action.
   */
  async ensureOwnerPolicy(
    policy: OwnerPolicyCurrent,
  ): Promise<GovernanceOutcome<{ registered: boolean }>> {
    const existing = this.store.currentPolicies().get(policy.policyId);
    if (existing !== undefined) {
      if (
        existing.effectiveFrom === policy.effectiveFrom &&
        existing.manualPerCardApprovalRequired === policy.manualPerCardApprovalRequired &&
        existing.ownerCanViewEditRevoke === policy.ownerCanViewEditRevoke &&
        existing.authorityRef === policy.authorityRef
      ) {
        return { status: "already", detail: "policy already registered — nothing was written" };
      }
      return {
        status: "refused",
        issues: [
          {
            path: "policyId",
            message:
              "a different policy with this id already exists; policy history is append-only — mint a new policy id",
          },
        ],
      };
    }
    const envelope: MnemosyneEnvelope = {
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      actor: "system",
      event: {
        type: "owner_policy_set",
        policyId: policy.policyId,
        authority: policy.authority,
        effectiveFrom: policy.effectiveFrom,
        manualPerCardApprovalRequired: policy.manualPerCardApprovalRequired,
        ownerCanViewEditRevoke: policy.ownerCanViewEditRevoke,
        authorityRef: policy.authorityRef,
      },
    };
    const outcome = this.store.appendJoint([], [envelope]);
    if (outcome.status !== "appended") {
      return { status: "refused", issues: outcome.issues };
    }
    await this.store.rebuildProjections();
    let backupResult: { ok: boolean; detail: string };
    try {
      const report = this.backup("owner_policy");
      backupResult = { ok: true, detail: report.path };
    } catch (error) {
      backupResult = {
        ok: false,
        detail: `write persisted but backup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.audit({
        type: "governance_backup_failed",
        op: "owner_policy",
        policy_id: policy.policyId,
        committed: true,
        retry_safe: true,
      });
    }
    this.audit({
      type: "owner_policy_registered",
      policy_id: policy.policyId,
      authority_ref: policy.authorityRef,
      backup_ok: backupResult.ok,
    });
    return { status: "ok", registered: true };
  }

  /** The active D0 policy, or null when none is durably registered. */
  ownerPolicy(policyId: string): OwnerPolicyCurrent | null {
    return this.store.currentPolicies().get(policyId) ?? null;
  }

  /**
   * D0 §5.2/§5.3: create a card AND activate it under a durable owner
   * policy in ONE transaction (memory_created + attributes_set +
   * provenance_set + policy_activated [+ expiry_set] [+ supersession]).
   * confirmed_by is structurally untouched. Refuses when the policy is
   * not durably registered or requires manual approval (fail-closed).
   */
  async proposeUnderPolicy(
    input: ProposeInput & {
      activation: {
        policyId: string;
        sourceBasis: "explicit" | "observed";
        generator: string;
      };
      /** Lethe TTL for temporal observed state (ISO), validated upstream. */
      expiresAt?: string;
      /** Explicit supersession of an older card (same transaction). */
      supersedes?: { memoryId: string; reason: string };
    },
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const policy = this.store.currentPolicies().get(input.activation.policyId);
    if (policy === undefined) {
      return {
        status: "refused",
        issues: [
          { path: "activation.policyId", message: "owner policy not durably registered — activation refused" },
        ],
      };
    }
    if (policy.manualPerCardApprovalRequired) {
      return {
        status: "refused",
        issues: [
          { path: "activation.policyId", message: "policy requires manual per-card approval — cannot auto-activate" },
        ],
      };
    }
    if (input.supersedes !== undefined) {
      const old = this.store.getItem(input.supersedes.memoryId);
      if (old === undefined || old.lifecycle_state !== "active") {
        return {
          status: "refused",
          issues: [{ path: "supersedes.memoryId", message: "no active card to supersede" }],
        };
      }
    }

    const issues: GovernanceIssue[] = [];
    const body = input.body.trim();
    const title = (input.title ?? body.slice(0, 60)).trim();
    if (body.length === 0) issues.push({ path: "body", message: "memory text is required" });
    if (body.length > MAX_BODY_CHARS)
      issues.push({ path: "body", message: `memory text over ${MAX_BODY_CHARS} chars` });
    if (title.length > MAX_TITLE_CHARS)
      issues.push({ path: "title", message: `title over ${MAX_TITLE_CHARS} chars` });
    if (input.scope === "au" && (input.auId === undefined || input.auId.length === 0))
      issues.push({ path: "auId", message: "au scope requires an AU id" });
    for (const [field, text] of [
      ["body", body],
      ["title", title],
    ] as const) {
      if (text.length > 0) {
        const admission = assessUntrustedBody(text);
        if (!admission.ok) issues.push({ path: field, message: admission.reason });
      }
    }
    if (issues.length > 0) {
      return { status: "refused", issues };
    }

    const memoryId = randomUUID();
    const evidence =
      input.evidence.kind === "transcript"
        ? {
            kind: "user_statement" as const,
            source: {
              kind: "conversation_message" as const,
              conversationId: input.evidence.conversationId,
              turnId: input.evidence.turnId,
              messageId: input.evidence.messageId,
              role: "user" as const,
              ...(input.evidence.externalKey !== undefined
                ? { external: { source: "telegram", externalTurnKey: input.evidence.externalKey } }
                : {}),
            },
          }
        : {
            kind: "user_statement" as const,
            source: { kind: "manual_entry" as const, manualEntryId: randomUUID() },
          };
    const kernel: MemoryEventEnvelope[] = [
      {
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        event: {
          type: "memory_created",
          memoryId,
          content: body,
          evidence,
          scope: { kind: "shared" },
        },
      } as unknown as MemoryEventEnvelope,
    ];
    if (input.supersedes !== undefined) {
      kernel.push({
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        event: {
          type: "memory_superseded",
          memoryId: input.supersedes.memoryId,
          supersededByMemoryId: memoryId,
          reason: input.supersedes.reason.slice(0, 200),
        },
      } as unknown as MemoryEventEnvelope);
    }
    const governance: MnemosyneEnvelope[] = [
      {
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        actor: input.executionActor ?? "system",
        event: {
          type: "attributes_set",
          memoryId,
          title,
          tags: [...(input.tags ?? [])],
          scope: input.scope,
          ...(input.scope === "au" ? { auId: input.auId! } : {}),
          sensitivity: input.sensitivity,
          importance: input.importance,
          sourceBasis: input.activation.sourceBasis,
        },
      },
    ];
    if (input.provenance !== undefined && Object.keys(input.provenance).length > 0) {
      governance.push({
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        actor: input.executionActor ?? "system",
        event: { type: "provenance_set", memoryId, roles: { ...input.provenance } },
      });
    }
    governance.push({
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      actor: "system",
      event: {
        type: "policy_activated",
        memoryId,
        policyId: input.activation.policyId,
        activationBasis: "owner_policy",
        sourceBasis: input.activation.sourceBasis,
        generator: input.activation.generator,
      },
    });
    if (input.expiresAt !== undefined) {
      governance.push({
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        actor: "system",
        event: { type: "expiry_set", memoryId, expiresAt: input.expiresAt },
      });
    }
    return this.commit("propose_under_policy", memoryId, kernel, governance, {
      scope: input.scope,
      sensitivity: input.sensitivity,
      evidence_kind: input.evidence.kind,
      activation_policy_id: input.activation.policyId,
      activation_source_basis: input.activation.sourceBasis,
      generator: input.activation.generator,
      ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes.memoryId } : {}),
      ...(input.provenance !== undefined ? { provenance_roles: { ...input.provenance } } : {}),
      token_estimate: estimateTokens(body),
    });
  }

  /**
   * D0 §6.3: activate an EXISTING active candidate under the owner
   * policy (five-pending reconciliation). Optionally sets a Lethe TTL in
   * the same transaction. Never touches confirmed cards.
   */
  async activateExistingUnderPolicy(
    memoryId: string,
    activation: { policyId: string; sourceBasis: "explicit" | "observed"; generator: string },
    expiresAt?: string,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const policy = this.store.currentPolicies().get(activation.policyId);
    if (policy === undefined || policy.manualPerCardApprovalRequired) {
      return {
        status: "refused",
        issues: [
          { path: "activation.policyId", message: "owner policy not registered or requires manual approval" },
        ],
      };
    }
    const item = this.store.getItem(memoryId);
    if (item === undefined || item.lifecycle_state !== "active") {
      return { status: "refused", issues: [{ path: "memoryId", message: "no active card" }] };
    }
    if (item.approval_state === "confirmed") {
      return { status: "already", detail: "already individually confirmed — outranks policy activation" };
    }
    if (item.approval_state === "policy_activated") {
      return { status: "already", detail: "already policy-activated" };
    }
    const governance: MnemosyneEnvelope[] = [
      {
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        actor: "system",
        event: {
          type: "policy_activated",
          memoryId,
          policyId: activation.policyId,
          activationBasis: "owner_policy",
          sourceBasis: activation.sourceBasis,
          generator: activation.generator,
        },
      },
    ];
    if (expiresAt !== undefined) {
      governance.push({
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        actor: "system",
        event: { type: "expiry_set", memoryId, expiresAt },
      });
    }
    return this.commit("activate_under_policy", memoryId, [], governance, {
      activation_policy_id: activation.policyId,
      activation_source_basis: activation.sourceBasis,
      generator: activation.generator,
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    });
  }

  // ---- approval --------------------------------------------------------

  async approve(
    memoryId: string,
    by: HumanActor,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const item = this.store.getItem(memoryId);
    if (item === undefined) {
      return { status: "refused", issues: [{ path: "memoryId", message: "no such card" }] };
    }
    if (item.lifecycle_state !== "active") {
      return { status: "refused", issues: [{ path: "memoryId", message: `card is ${item.lifecycle_state}` }] };
    }
    if (item.approval_state === "confirmed") {
      return { status: "already", detail: "already confirmed — nothing was written again" };
    }
    const confirmed: MnemosyneEnvelope = {
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      actor: by === "both" ? "owner" : by,
      event: { type: "confirmed", memoryId, by },
    };
    return this.commit("approve", memoryId, [], [confirmed], { by });
  }

  // ---- edit (pending) / revise (confirmed) ----------------------------

  async editPending(
    memoryId: string,
    newBody: string,
    editedBy: "owner" | "companion",
    newTitle?: string,
    provenanceDelta?: ProvenanceRoles,
    attrs?: {
      scope: "global" | "relationship" | "project" | "au";
      auId?: string;
      sensitivity?: "normal" | "sensitive" | "intimate";
    },
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const item = this.store.getItem(memoryId);
    if (item === undefined || item.lifecycle_state !== "active") {
      return { status: "refused", issues: [{ path: "memoryId", message: "no active card" }] };
    }
    if (item.approval_state === "confirmed") {
      return {
        status: "refused",
        issues: [{ path: "memoryId", message: "card is confirmed — use revise instead" }],
      };
    }
    return this.reviseKernel("edit", item, newBody, editedBy, newTitle, null, provenanceDelta, attrs);
  }

  async reviseConfirmed(
    memoryId: string,
    newBody: string,
    by: HumanActor,
    newTitle?: string,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const item = this.store.getItem(memoryId);
    if (item === undefined || item.lifecycle_state !== "active") {
      return { status: "refused", issues: [{ path: "memoryId", message: "no active card" }] };
    }
    if (item.approval_state !== "confirmed") {
      return {
        status: "refused",
        issues: [{ path: "memoryId", message: "card is not confirmed — use edit instead" }],
      };
    }
    return this.reviseKernel("revise", item, newBody, by === "both" ? "owner" : by, newTitle, by);
  }

  /** Shared revision path; confirmWith re-anchors approval atomically. */
  private async reviseKernel(
    op: "edit" | "revise",
    item: GovernanceItemView,
    newBody: string,
    humanAuthor: "owner" | "companion",
    newTitle: string | undefined,
    confirmWith: HumanActor | null,
    provenanceDelta?: ProvenanceRoles,
    attrs?: {
      scope: "global" | "relationship" | "project" | "au";
      auId?: string;
      sensitivity?: "normal" | "sensitive" | "intimate";
    },
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const body = newBody.trim();
    if (body.length === 0 || body.length > MAX_BODY_CHARS) {
      return {
        status: "refused",
        issues: [{ path: "body", message: `replacement text must be 1..${MAX_BODY_CHARS} chars` }],
      };
    }
    const admission = assessUntrustedBody(body);
    if (!admission.ok) {
      return { status: "refused", issues: [{ path: "body", message: admission.reason }] };
    }
    const revised = {
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      event: {
        type: "memory_revised",
        memoryId: item.id,
        revisionId: randomUUID(),
        revisionKind: op === "revise" ? "correction" : "amendment",
        content: body,
        evidence: {
          kind: "user_statement",
          source: { kind: "manual_entry", manualEntryId: randomUUID() },
        },
        scope: { kind: "shared" },
      },
    } as unknown as MemoryEventEnvelope;
    const governance: MnemosyneEnvelope[] = [];
    if ((newTitle !== undefined && newTitle.trim().length > 0) || attrs !== undefined) {
      if (newTitle !== undefined) {
        const titleAdmission = assessUntrustedBody(newTitle);
        if (!titleAdmission.ok) {
          return { status: "refused", issues: [{ path: "title", message: titleAdmission.reason }] };
        }
      }
      const scope = attrs?.scope ?? (item.scope as "global" | "relationship" | "project" | "au");
      const auId = attrs !== undefined ? attrs.auId : (item.au_id ?? undefined);
      if (scope === "au" && (auId === undefined || auId.length === 0)) {
        return { status: "refused", issues: [{ path: "auId", message: "au scope requires an AU id" }] };
      }
      governance.push({
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        actor: humanAuthor,
        event: {
          type: "attributes_set",
          memoryId: item.id,
          title:
            newTitle !== undefined && newTitle.trim().length > 0
              ? newTitle.trim().slice(0, MAX_TITLE_CHARS)
              : item.title,
          tags: item.tags_text.split(" ").filter((t) => t.length > 0),
          scope,
          ...(scope === "au" && auId !== undefined ? { auId } : {}),
          sensitivity:
            attrs?.sensitivity ?? (item.sensitivity as "normal" | "sensitive" | "intimate"),
          importance: item.importance as 1 | 2 | 3,
          sourceBasis: "explicit",
        },
      });
    }
    if (confirmWith !== null) {
      governance.push({
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        actor: confirmWith === "both" ? "owner" : confirmWith,
        event: { type: "confirmed", memoryId: item.id, by: confirmWith },
      });
    }
    if (provenanceDelta !== undefined && Object.keys(provenanceDelta).length > 0) {
      governance.push({
        eventId: randomUUID(),
        occurredAt: this.now().toISOString(),
        actor: humanAuthor,
        event: { type: "provenance_set", memoryId: item.id, roles: { ...provenanceDelta } },
      });
    }
    return this.commit(op, item.id, [revised], governance, {
      re_confirmed: confirmWith !== null,
      ...(provenanceDelta !== undefined ? { provenance_roles: { ...provenanceDelta } } : {}),
      token_estimate: estimateTokens(body),
    });
  }

  // ---- reject / revoke -------------------------------------------------

  async reject(
    memoryId: string,
    by: "owner" | "companion",
    reason: string,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    return this.terminate("reject", memoryId, by, reason, ["candidate"]);
  }

  /**
   * Owner revoke right (D0 §5.1): covers individually confirmed AND
   * policy-activated cards — automation can never place a card beyond
   * the owner's reach.
   */
  async revoke(
    memoryId: string,
    by: "owner" | "companion",
    reason: string,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    return this.terminate("revoke", memoryId, by, reason, ["confirmed", "policy_activated"]);
  }

  private async terminate(
    op: "reject" | "revoke",
    memoryId: string,
    by: "owner" | "companion",
    reason: string,
    requiredApproval: readonly string[],
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const item = this.store.getItem(memoryId);
    if (item === undefined) {
      return { status: "refused", issues: [{ path: "memoryId", message: "no such card" }] };
    }
    if (item.lifecycle_state !== "active") {
      return { status: "already", detail: `already ${item.lifecycle_state} — history preserved` };
    }
    if (!requiredApproval.includes(item.approval_state)) {
      return {
        status: "refused",
        issues: [
          {
            path: "memoryId",
            message: `${op} applies to ${requiredApproval.join("|")} cards; this one is ${item.approval_state}`,
          },
        ],
      };
    }
    const retrievalOff: MnemosyneEnvelope = {
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      actor: by,
      event: { type: "retrieval_set", memoryId, enabled: false },
    };
    const deactivated = {
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: this.now().toISOString(),
      event: {
        type: "memory_deactivated",
        memoryId,
        reason: `${op} by ${by} via governance channel: ${reason.slice(0, 200)}`,
      },
    } as unknown as MemoryEventEnvelope;
    return this.commit(op, memoryId, [deactivated], [retrievalOff], { by });
  }

  // ---- reads -----------------------------------------------------------

  listPending(): GovernanceItemView[] {
    return this.store
      .listItems()
      .filter((item) => item.approval_state === "candidate" && item.lifecycle_state === "active")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  /**
   * Owner search over the retrieval-eligible set: individually confirmed
   * AND policy-activated cards (D0 §5.4 — the owner's view right covers
   * everything automation activated). Candidates stay out.
   */
  searchConfirmed(query: string, limit: number): GovernanceItemView[] {
    const hits = this.store.ftsSearch(query, Math.max(limit * 4, 12));
    const out: GovernanceItemView[] = [];
    for (const hit of hits) {
      const item = this.store.getItem(hit.itemId);
      if (
        item !== undefined &&
        (item.approval_state === "confirmed" || item.approval_state === "policy_activated") &&
        item.lifecycle_state === "active"
      ) {
        out.push(item);
        if (out.length >= limit) {
          break;
        }
      }
    }
    return out;
  }

  getCard(memoryId: string): GovernanceItemView | undefined {
    return this.store.getItem(memoryId);
  }

  /**
   * At-most-one-decision-per-source-turn support: any card (pending or
   * confirmed, active or terminal) whose evidence pointer carries this
   * turnId blocks a second proposal from the same turn.
   */
  /**
   * D0 continuous-completion ruling item 9: only an ACTIVE card blocks a
   * new decision for its source turn. A revoked or superseded card was
   * explicitly retired by the owner/system — its turn is re-decidable
   * through the normal governed worker (correct replacements), while its
   * own history stays preserved and non-retrievable.
   */
  findActiveBySourceTurn(turnId: string): GovernanceItemView | undefined {
    if (turnId.length < 8) {
      return undefined;
    }
    for (const item of this.store.listItems()) {
      if (item.lifecycle_state !== "active") {
        continue;
      }
      const pointer = this.store.listSources("memory", item.id)[0]?.pointer ?? "";
      if (pointer.includes(turnId)) {
        return item;
      }
    }
    return undefined;
  }

  findBySourceTurn(turnId: string): GovernanceItemView | undefined {
    if (turnId.length < 8) {
      return undefined;
    }
    for (const item of this.store.listItems()) {
      const pointer = this.store.listSources("memory", item.id)[0]?.pointer ?? "";
      if (pointer.includes(turnId)) {
        return item;
      }
    }
    return undefined;
  }

  /** Prefix match for owner convenience; unique match or nothing. */
  findByIdPrefix(prefix: string): GovernanceItemView | undefined {
    const clean = prefix.toLowerCase();
    if (clean.length < 6) {
      return undefined;
    }
    const matches = this.store.listItems().filter((item) => item.id.startsWith(clean));
    return matches.length === 1 ? matches[0] : undefined;
  }

  sourcePointer(memoryId: string): string | null {
    return this.store.listSources("memory", memoryId)[0]?.pointer ?? null;
  }

  // ---- commit helper ----------------------------------------------------

  private async commit(
    op: string,
    memoryId: string,
    kernel: MemoryEventEnvelope[],
    governance: MnemosyneEnvelope[],
    auditExtra: Record<string, unknown>,
  ): Promise<GovernanceOutcome<GovernanceWriteReceipt>> {
    const outcome = this.store.appendJoint(kernel, governance);
    if (outcome.status !== "appended") {
      this.audit({
        type: "governance_write_rejected",
        op,
        memory_id: memoryId,
        issue_count: outcome.issues.length,
      });
      return { status: "refused", issues: outcome.issues };
    }
    await this.store.rebuildProjections();
    const eventIds = [...kernel.map((e) => e.eventId), ...governance.map((e) => e.eventId)];
    let backup: { ok: boolean; detail: string };
    try {
      const report = this.backup(op);
      backup = { ok: true, detail: report.path };
    } catch (error) {
      backup = {
        ok: false,
        detail: `write persisted but backup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      // Amendment 2: explicit metadata-only evidence that a COMMITTED
      // transaction is temporarily missing its verified backup.
      this.audit({
        type: "governance_backup_failed",
        op,
        memory_id: memoryId,
        event_ids: eventIds,
        committed: true,
        retry_safe: true,
      });
    }
    this.audit({
      type: "governance_write",
      op,
      memory_id: memoryId,
      event_ids: eventIds,
      committed: true,
      backup_ok: backup.ok,
      ...auditExtra,
    });
    return { status: "ok", memoryId, eventIds, committed: true, backup, retrySafe: true };
  }

  /**
   * Safe backup retry (amendment 2): re-runs the verified backup only.
   * No events are appended; the committed memory is never duplicated.
   */
  retryBackup(): { ok: boolean; detail: string } {
    try {
      const report = this.backup("retry");
      this.audit({ type: "governance_backup_retry", ok: true });
      return { ok: true, detail: report.path };
    } catch (error) {
      this.audit({ type: "governance_backup_retry", ok: false });
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
