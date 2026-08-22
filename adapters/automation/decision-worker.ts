/**
 * Durable decision worker: drains the no-drop backlog through the governed
 * decision backlog through the governed Companion drafting lane and lands
 * eligible cards as policy-activated memories under the durable owner
 * policy — no per-card owner approval, no false confirmation claims.
 *
 * Verification discipline is identical to the three-paths pass: the ONLY
 * text source is the frozen transcript archive, re-read and hash-verified
 * at execution time; a miss or mismatch is a typed fail-closed terminal
 * state, never a guess. Classification (explicit/observed/inferred) comes
 * from the model per the owner order §5.3; deterministic gates enforce
 * dedup, AU pinning, verbatim-overlap, temporal validity, and the
 * raise-only sensitivity guard. Quarantine never injects and never
 * creates owner work.
 */

import { randomUUID } from "node:crypto";
import type { ModelProvider } from "../../core/ports/model-provider.js";
import type { CompanionProposalSink } from "../../core/services/companion-proposal-sink.js";
import type { ProvenanceRoles } from "../../core/domain/mnemosyne.js";
import type { TurnSnapshot } from "../transcripts/local/transcript-query.js";
import {
  buildLanePrompt,
  checkSourceBudget,
  isUserOriginatedTurn,
  parseProposalDecision,
  turnContentHash,
  validateClaimEvidence,
  verbatimOverlap,
  VERBATIM_OVERLAP_THRESHOLD,
  type CompanionDraftQueueEntry,
} from "./companion-proposals.js";
import {
  DecisionBacklog,
  type BacklogItemRow,
  type BacklogOrigin,
  type FrozenCardRefRecord,
} from "./decision-backlog.js";

export type DecisionMode = "enqueue-only" | "full";

export interface OwnerAutoMemoryPolicyDefinition {
  policyId: string;
  authority: "owner_global_policy";
  effectiveFrom: string;
  manualPerCardApprovalRequired: boolean;
  ownerCanViewEditRevoke: boolean;
  /** Deployment-owned authority artifact digest, never bundled in this package. */
  authorityRef: `sha256:${string}`;
}

/** A deployment must provide its own policy id and authority digest. */
export function defineOwnerAutoMemoryPolicy(
  input: OwnerAutoMemoryPolicyDefinition,
): Readonly<OwnerAutoMemoryPolicyDefinition> {
  if (input.policyId.trim().length === 0) throw new TypeError("policyId is required");
  if (!/^sha256:[0-9a-f]{64}$/i.test(input.authorityRef)) {
    throw new TypeError("authorityRef must be a full sha256 digest");
  }
  if (!Number.isFinite(Date.parse(input.effectiveFrom))) {
    throw new TypeError("effectiveFrom must be an ISO-compatible timestamp");
  }
  return Object.freeze({ ...input });
}

export interface DecisionWorkerBudget {
  /** Provider calls per rolling hour (reserve-before-call ledger). */
  maxPerHour: number;
  /** Provider calls per rolling 24h. */
  maxPerDay: number;
  breakerAfterFailures: number;
  breakerMinutes: number;
  /** Attempts before a retryable failure becomes terminal. */
  maxAttempts: number;
  /** Retry backoff base (ms), doubled per attempt, capped at 6h. */
  retryBaseMs: number;
  /** Owner warning: oldest deferred item age SLO (seconds). */
  deferredSloSeconds: number;
  /** Owner warning: minimum seconds between warnings. */
  warnIntervalSeconds: number;
}

export const DECISION_WORKER_DEFAULT_BUDGET: DecisionWorkerBudget = {
  maxPerHour: 6,
  maxPerDay: 48,
  breakerAfterFailures: 3,
  breakerMinutes: 30,
  maxAttempts: 3,
  retryBaseMs: 5 * 60_000,
  deferredSloSeconds: 6 * 3600,
  warnIntervalSeconds: 24 * 3600,
};

const RETRY_MAX_MS = 6 * 3600_000;

/**
 * Policy-activation classification block appended to the proposal drafting
 * prompt. Mechanism transcribed from the owner work order §5.3 — the
 * card-writing voice guidance above it is not touched.
 */
export const POLICY_ACTIVATION_CLASSIFICATION_BLOCK = [
  "",
  "--- Governance classification fields ---",
  "When proposing a card, include:",
  '· "basis": "explicit" for a directly stated fact, "observed" for directly visible state, or "inferred" when interpretation is required. Use "inferred" when uncertain.',
  '· "claims": one entry per factual assertion: {"claim_text":"assertion","basis":"explicit|observed|inferred","evidence_side":"user|assistant","evidence_excerpt":"short exact support from the frozen source"}.',
  "Every assertion must have source support. Any inferred claim makes the whole card inferred.",
  '· Optional "valid_until": ISO 8601 with timezone only for a temporary state.',
  '· Optional "supersedes": a complete selected-card id only when the source explicitly updates it.',
  "Explicit or observed cards may activate under a registered owner policy; inferred cards are quarantined for review.",
].join("\n");

/**
 * Migrate legacy JSON-queue entries into the durable backlog (upgrade
 * path): pointers/hashes only, idempotent, then the JSON queue is
 * retired empty. Exported for direct testing; composition calls it once
 * at startup.
 */
export function migrateLegacyQueue(
  store: {
    loadCompanionPass: () => import("./companion-proposals.js").CompanionPassState;
    saveCompanionPass: (state: import("./companion-proposals.js").CompanionPassState) => void;
  },
  backlog: DecisionBacklog,
  policyId: string,
  audit: (event: Record<string, unknown>) => void,
): number {
  const passState = store.loadCompanionPass();
  const selfEntries = passState.queue.filter((entry) => entry.kind === "self");
  if (selfEntries.length === 0) {
    return 0;
  }
  for (const entry of selfEntries) {
    backlog.enqueue({
      conversationId: entry.conversation_id,
      turnId: entry.turn_id,
      userMessageId: entry.user_message_id,
      contentSha256: entry.content_sha256,
      variantSha256: entry.variant_sha256,
      sceneMode: entry.scene.mode,
      sceneAuId: entry.scene.au_id ?? null,
      origin: "live",
      policyVersion: policyId,
      selectedRefs: entry.selected_memories,
      priorVersions: entry.prior_versions,
      sourceTime: entry.queued_at,
    });
  }
  passState.queue = passState.queue.filter((entry) => entry.kind !== "self");
  store.saveCompanionPass(passState);
  audit({
    type: "decision_backlog",
    outcome: "legacy_queue_migrated",
    migrated: selfEntries.length,
  });
  return selfEntries.length;
}

export interface DecisionWorkerOptions {
  backlog: DecisionBacklog;
  sink: CompanionProposalSink;
  provider: Pick<ModelProvider, "generate">;
  persona: { staticPrefix: string; sha256: string };
  /** Deep frozen-evidence read (full transcript scan; backfill-capable). */
  snapshotByTurn: (turnId: string) => TurnSnapshot | null;
  /** Execution-time historical reconstruction + prior-version checks. */
  frozenVerifier: {
    cardSha: (memoryId: string, anchorEventId: string) => string | null;
    priorKnown: (key: string, version: number) => boolean;
  };
  /** Current sensitivity of a card (raise-only guard input). */
  cardSensitivity: (memoryId: string) => string | null;
  /** True when the card is active (supersession hint validation). */
  cardActive: (memoryId: string) => boolean;
  /**
   * Pre-call dedup (§6.1/§6.2): any existing card grounded in this turn
   * closes the receipt WITHOUT spending a provider call. Also the
   * crash-resume guarantee: a card committed before the completion
   * receipt reconciles here instead of re-dialing.
   */
  existingCardForTurn: (turnId: string) => { id: string } | undefined;
  /**
   * Target policy id CONSTANT — the identity namespace for enqueued
   * decisions. Stable across registration state so an item enqueued
   * before registration is the same decision after it.
   */
  policyId: string;
  /** Durable owner policy gate: null = not registered → activation refuses. */
  policy: () => { policyId: string; manualPerCardApprovalRequired: boolean } | null;
  mode: DecisionMode;
  /**
   * Lane bridge to the owner-initiated pass: the worker defers when an
   * owner request is waiting/in flight, shares the single-flight mutex
   * (one provider call across ALL lanes), and respects the lane-agnostic
   * provider-health breaker.
   */
  flight?: {
    ownerBusy: () => boolean;
    acquire: () => Promise<() => void>;
    externalBreakerOpen: () => boolean;
  };
  /** Metadata-only audit sink; never receives bodies. */
  audit: (event: Record<string, unknown>) => void;
  /** Bounded owner-visible warning sink (one line, rate-limited). */
  warn?: (text: string) => Promise<void>;
  budget?: Partial<DecisionWorkerBudget>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface DecisionEnqueueOptions {
  backlog: DecisionBacklog;
  policyId: string;
  audit: (event: Record<string, unknown>) => void;
}

/**
 * Provider-free no-drop ingress. Keeping this outside DecisionWorker lets an
 * unselected/disabled memory model continue to accumulate durable receipts
 * without constructing, authenticating, or accidentally calling a chat model.
 */
export function enqueueDecisionTurn(
  options: DecisionEnqueueOptions,
  snapshot: TurnSnapshot,
  origin: BacklogOrigin,
  context: {
    selectedRefs: FrozenCardRefRecord[];
    priorVersions: Record<string, number>;
    sourceTime: string | null;
  },
): { identity: string; enqueued: boolean } | null {
  if (!isUserOriginatedTurn(snapshot)) {
    options.audit({
      type: "decision_backlog",
      outcome: "skipped_non_user_turn",
      turn_id: snapshot.turnId,
    });
    return null;
  }
  const contentSha256 = turnContentHash(snapshot.userText, snapshot.assistantText);
  const sceneMode = snapshot.variantSha256 !== null ? "ordinary" : "unknown";
  const result = options.backlog.enqueue({
    conversationId: snapshot.conversationId,
    turnId: snapshot.turnId,
    userMessageId: snapshot.userMessageId,
    contentSha256,
    variantSha256: snapshot.variantSha256,
    sceneMode,
    sceneAuId: null,
    origin,
    policyVersion: options.policyId,
    selectedRefs: context.selectedRefs,
    priorVersions: context.priorVersions,
    sourceTime: context.sourceTime,
  });
  if (result.enqueued) {
    options.audit({
      type: "decision_backlog",
      outcome: "deferred",
      origin,
      identity: result.identity.slice(0, 16),
      turn_id: snapshot.turnId,
      content_sha256: contentSha256.slice(0, 16),
      variant_sha256: snapshot.variantSha256?.slice(0, 12) ?? null,
    });
  }
  return result;
}

/** Deterministic raise-only sensitivity guard (D0 §5.3). */
export function raiseOnlySensitivity(
  proposed: "normal" | "sensitive" | "intimate",
  selectedRefs: readonly FrozenCardRefRecord[],
  cardSensitivity: (memoryId: string) => string | null,
): "normal" | "sensitive" | "intimate" {
  const order = { normal: 0, sensitive: 1, intimate: 2 } as const;
  let floor: keyof typeof order = "normal";
  for (const ref of selectedRefs) {
    const sensitivity = cardSensitivity(ref.id);
    if (sensitivity === "intimate" || sensitivity === "sensitive") {
      // Intimate context floors at "sensitive" — the guard raises, and
      // full intimate classification stays the model/owner's call.
      floor = "sensitive";
    }
  }
  return order[proposed] >= order[floor] ? proposed : floor;
}

export class DecisionWorker {
  private readonly options: DecisionWorkerOptions;
  private readonly budget: DecisionWorkerBudget;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private inFlight = false;

  constructor(options: DecisionWorkerOptions) {
    this.options = options;
    this.budget = { ...DECISION_WORKER_DEFAULT_BUDGET, ...(options.budget ?? {}) };
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Durable no-drop enqueue of a completed turn (§4.1). Runs in EVERY
   * mode — the no-drop property never depends on a flag. Texts are
   * hashed and discarded; only pointers/hashes persist.
   */
  enqueueTurn(
    snapshot: TurnSnapshot,
    origin: BacklogOrigin,
    context: {
      selectedRefs: FrozenCardRefRecord[];
      priorVersions: Record<string, number>;
      sourceTime: string | null;
    },
  ): { identity: string; enqueued: boolean } | null {
    return enqueueDecisionTurn(
      {
        backlog: this.options.backlog,
        policyId: this.options.policyId,
        audit: this.options.audit,
      },
      snapshot,
      origin,
      context,
    );
  }

  /** One bounded drain step; at most one provider decision per call. */
  async tick(): Promise<void> {
    if (this.inFlight || this.options.mode !== "full") {
      return;
    }
    // Owner priority (§2): never start autonomous work while an
    // owner-initiated request is waiting or in flight.
    if (this.options.flight?.ownerBusy() === true) {
      return;
    }
    if (this.options.flight?.externalBreakerOpen() === true) {
      return; // provider health is lane-agnostic
    }
    const policy = this.options.policy();
    if (policy === null || policy.manualPerCardApprovalRequired) {
      return; // activation is fail-closed without the durable policy
    }
    const nowMs = this.now().getTime();
    const breakerUntil = this.options.backlog.getMeta("worker_breaker_until");
    if (breakerUntil !== null && breakerUntil !== "" && nowMs < Date.parse(breakerUntil)) {
      return;
    }
    const hourAgo = new Date(nowMs - 3_600_000).toISOString();
    const dayAgo = new Date(nowMs - 86_400_000).toISOString();
    if (
      this.options.backlog.callsReservedSince(hourAgo) >= this.budget.maxPerHour ||
      this.options.backlog.callsReservedSince(dayAgo) >= this.budget.maxPerDay
    ) {
      return; // budget exhausted → items simply stay deferred
    }
    const claimed = this.options.backlog.claimNext(this.now().toISOString());
    if (claimed === null) {
      return;
    }
    this.inFlight = true;
    try {
      await this.processItem(claimed, policy.policyId);
    } catch (error) {
      // Belt-and-braces: a bug in processing must never strand the item
      // in 'processing' or take down the poll loop.
      const detail = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
      try {
        this.settleRetryable(claimed, `worker_exception: ${detail}`);
      } catch {
        this.log(`decision worker settle failed after exception: ${detail}`);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private settleRetryable(item: BacklogItemRow, detail: string): void {
    if (item.attempts >= this.budget.maxAttempts) {
      this.options.backlog.settle(item.identity, "failed_terminal", {
        detail: `exhausted_retries: ${detail}`,
      });
      this.auditOutcome(item, "failed_terminal", detail);
      return;
    }
    const backoff = Math.min(RETRY_MAX_MS, this.budget.retryBaseMs * 2 ** (item.attempts - 1));
    this.options.backlog.settle(item.identity, "failed_retryable", {
      detail,
      nextAttemptAt: new Date(this.now().getTime() + backoff).toISOString(),
    });
    this.auditOutcome(item, "failed_retryable", detail);
  }

  private recordProviderFailure(): void {
    const raw = this.options.backlog.getMeta("worker_consecutive_failures");
    const count = (raw === null ? 0 : Number.parseInt(raw, 10)) + 1;
    this.options.backlog.setMeta("worker_consecutive_failures", String(count));
    if (count >= this.budget.breakerAfterFailures) {
      this.options.backlog.setMeta(
        "worker_breaker_until",
        new Date(this.now().getTime() + this.budget.breakerMinutes * 60_000).toISOString(),
      );
    }
  }

  private clearProviderFailures(): void {
    this.options.backlog.setMeta("worker_consecutive_failures", "0");
    this.options.backlog.setMeta("worker_breaker_until", "");
  }

  private async processItem(item: BacklogItemRow, policyId: string): Promise<void> {
    // 1. Frozen-evidence verified read — the ONLY source of text.
    const snapshot = this.options.snapshotByTurn(item.turn_id);
    if (snapshot === null) {
      this.options.backlog.settle(item.identity, "failed_terminal", { detail: "missing_source" });
      this.auditOutcome(item, "failed_terminal", "missing_source");
      return;
    }
    if (turnContentHash(snapshot.userText, snapshot.assistantText) !== item.content_sha256) {
      this.options.backlog.settle(item.identity, "failed_terminal", { detail: "hash_mismatch" });
      this.auditOutcome(item, "failed_terminal", "hash_mismatch");
      return;
    }
    if (!isUserOriginatedTurn(snapshot)) {
      this.options.backlog.settle(item.identity, "failed_terminal", { detail: "non_user_turn" });
      this.auditOutcome(item, "failed_terminal", "non_user_turn");
      return;
    }
    // Source budget (correction A §4.5): full text or durable deferral.
    const budgetResult = checkSourceBudget({
      userText: snapshot.userText!,
      assistantText: snapshot.assistantText!,
      contentSha256: item.content_sha256,
      totalChars: (snapshot.userText?.length ?? 0) + (snapshot.assistantText?.length ?? 0),
    });
    if (!budgetResult.fits) {
      const detail = `oversize_source:user=${budgetResult.userChars}/assistant=${budgetResult.assistantChars}/budget=${budgetResult.budgetPerSide}`;
      this.options.backlog.deferOversize(item.identity, detail);
      this.auditOutcome(item, "deferred", detail);
      return;
    }
    // Ambiguous source scope never silently becomes ordinary memory.
    if (item.scene_mode === "unknown" || (item.scene_mode === "au" && item.scene_au_id === null)) {
      this.options.backlog.settle(item.identity, "quarantined", { detail: "ambiguous_scene" });
      this.auditOutcome(item, "quarantined", "ambiguous_scene");
      return;
    }
    // 2. Frozen card-version + prior-version verification.
    const selectedRefs = JSON.parse(item.selected_refs) as FrozenCardRefRecord[];
    for (const ref of selectedRefs) {
      const historical =
        ref.anchor_event_id === "unavailable"
          ? null
          : this.options.frozenVerifier.cardSha(ref.id, ref.anchor_event_id);
      if (historical === null || historical !== ref.content_sha256) {
        this.options.backlog.settle(item.identity, "failed_terminal", {
          detail: `card_version:${ref.id.slice(0, 8)}`,
        });
        this.auditOutcome(item, "failed_terminal", `card_version:${ref.id.slice(0, 8)}`);
        return;
      }
    }
    const priorVersions = JSON.parse(item.prior_versions) as Record<string, number>;
    for (const [key, version] of Object.entries(priorVersions)) {
      if (!this.options.frozenVerifier.priorKnown(key, version)) {
        this.options.backlog.settle(item.identity, "failed_terminal", {
          detail: `prior_version:${key}`,
        });
        this.auditOutcome(item, "failed_terminal", `prior_version:${key}`);
        return;
      }
    }
    // 3. Pre-call dedup: an existing decision for this turn closes the
    //    receipt WITHOUT spending a provider call (backfill economy and
    //    the crash-after-card-commit resume path).
    const existing = this.options.existingCardForTurn(item.turn_id);
    if (existing !== undefined) {
      this.options.backlog.settle(item.identity, "duplicate", {
        memoryId: existing.id,
        detail: "existing_decision_for_turn",
      });
      this.auditOutcome(item, "duplicate", "pre_call_dedup", existing.id);
      return;
    }
    const entry: CompanionDraftQueueEntry = {
      queued_at: item.queued_at,
      kind: "self",
      conversation_id: item.conversation_id,
      turn_id: item.turn_id,
      user_message_id: item.user_message_id,
      content_sha256: item.content_sha256,
      variant_sha256: item.variant_sha256,
      selected_memories: selectedRefs,
      prior_versions: priorVersions,
      scene:
        item.scene_mode === "au"
          ? { mode: "au", au_id: item.scene_au_id! }
          : { mode: "ordinary" },
    };

    // 4. Provider call under reserve-before-call accounting, holding the
    //    cross-lane single-flight mutex (one call in flight, all lanes).
    const callId = randomUUID();
    this.options.backlog.reserveCall(item.identity, callId);
    let generated;
    const release = this.options.flight !== undefined ? await this.options.flight.acquire() : null;
    try {
      generated = await this.options.provider.generate({
        conversationId: `gov-decision-${randomUUID()}`,
        turnId: randomUUID(),
        systemPrompt: this.options.persona.staticPrefix,
        dynamicPrompt: buildLanePrompt(entry, snapshot) + "\n" + POLICY_ACTIVATION_CLASSIFICATION_BLOCK,
      });
    } catch (error) {
      this.options.backlog.settleCall(callId, "threw", null);
      this.recordProviderFailure();
      this.settleRetryable(
        item,
        `provider_threw: ${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}`,
      );
      return;
    } finally {
      release?.();
    }
    if (!generated.ok) {
      this.options.backlog.settleCall(callId, `error:${generated.errorKind}`, null);
      this.recordProviderFailure();
      this.settleRetryable(item, `${generated.errorKind}: ${generated.detail.slice(0, 120)}`);
      return;
    }
    const servedModel = generated.servedModel ?? null;
    this.options.backlog.settleCall(callId, "ok", servedModel);
    this.clearProviderFailures();
    const generator = servedModel ?? "unverified-model";

    const parsed = parseProposalDecision(generated.text);
    if (parsed === null) {
      this.settleRetryable(item, "malformed_decision");
      return;
    }
    if (parsed.decision === "decline") {
      // The decline note is model-authored content ABOUT the turn; the
      // operational backlog stays pointers-and-hashes only (§4.1), so
      // only the typed outcome is recorded — never the note text.
      this.options.backlog.settle(item.identity, "declined");
      this.auditOutcome(item, "declined");
      return;
    }

    // 5. Deterministic governance gates (§5.3).
    const overlap = verbatimOverlap(
      parsed.body,
      `${snapshot.userText ?? ""}\n${snapshot.assistantText ?? ""}`,
    );
    if (overlap >= VERBATIM_OVERLAP_THRESHOLD) {
      this.options.backlog.settle(item.identity, "quarantined", {
        detail: `verbatim_overlap:${Math.round(overlap * 100)}`,
      });
      this.auditOutcome(item, "quarantined", `verbatim_overlap:${Math.round(overlap * 100)}`);
      return;
    }
    const basis = parsed.basis ?? "inferred";
    if (basis === "inferred") {
      this.options.backlog.settle(item.identity, "quarantined", { detail: "inferred_basis" });
      this.auditOutcome(item, "quarantined", "inferred_basis");
      return;
    }
    // Claim-level evidence validation (correction B §5).
    const claimResult = validateClaimEvidence(
      parsed.claims,
      basis,
      snapshot.userText!,
      snapshot.assistantText!,
    );
    if (!claimResult.valid) {
      this.options.backlog.settle(item.identity, "quarantined", {
        detail: `claim_evidence:${claimResult.reason}`,
      });
      this.auditOutcome(item, "quarantined", `claim_evidence:${claimResult.reason}`);
      return;
    }
    let expiresAt: string | undefined;
    if (parsed.validUntil !== undefined) {
      const parsedMs = Date.parse(parsed.validUntil);
      if (!Number.isFinite(parsedMs) || parsedMs <= this.now().getTime()) {
        this.options.backlog.settle(item.identity, "quarantined", { detail: "temporal_invalid" });
        this.auditOutcome(item, "quarantined", "temporal_invalid");
        return;
      }
      expiresAt = new Date(parsedMs).toISOString();
    }
    let supersedes: { memoryId: string; reason: string } | undefined;
    let supersedeNote: string | undefined;
    if (parsed.supersedes !== undefined) {
      const hinted = parsed.supersedes;
      const servedThisTurn = selectedRefs.some((ref) => ref.id === hinted);
      if (servedThisTurn && this.options.cardActive(hinted)) {
        supersedes = { memoryId: hinted, reason: "explicit new state from source turn" };
      } else {
        supersedeNote = "supersedes_ignored:unverifiable";
      }
    }
    const sensitivity = raiseOnlySensitivity(
      parsed.sensitivity ?? "normal",
      selectedRefs,
      this.options.cardSensitivity,
    );
    const scope = entry.scene.mode === "au" ? ("au" as const) : (parsed.scope ?? ("relationship" as const));
    const provenance: ProvenanceRoles = {
      source_basis: basis === "explicit" ? "user_stated" : "companion_self",
      proposal_origin: item.origin === "backfill" ? "backfill" : "companion_self",
      authored_by: "companion",
    };

    // 6. One-transaction propose + policy activation.
    const outcome = await this.options.sink.proposeActivated({
      body: parsed.body,
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.tags !== undefined && parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
      scope,
      ...(entry.scene.mode === "au" ? { auId: entry.scene.au_id! } : {}),
      sensitivity,
      evidence:
        snapshot.userMessageId !== null
          ? {
              kind: "transcript",
              conversationId: item.conversation_id,
              turnId: item.turn_id,
              messageId: snapshot.userMessageId,
            }
          : { kind: "manual" },
      provenance,
      activation: { policyId, sourceBasis: basis, generator },
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
    });
    if (outcome.status === "ok") {
      this.options.backlog.settle(item.identity, "policy_activated", {
        memoryId: outcome.memoryId,
        ...(supersedeNote !== undefined ? { detail: supersedeNote } : {}),
      });
      this.auditOutcome(item, "policy_activated", undefined, outcome.memoryId, {
        basis,
        generator,
        ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
        ...(supersedes !== undefined ? { superseded: supersedes.memoryId } : {}),
      });
      return;
    }
    if (outcome.status === "duplicate") {
      this.options.backlog.settle(item.identity, "duplicate", {
        memoryId: outcome.existingId,
        detail: "existing_decision_for_turn",
      });
      this.auditOutcome(item, "duplicate", undefined, outcome.existingId);
      return;
    }
    // Admission-quarantine refusals are content quarantine (§5.3 class 3/6);
    // anything else is a typed terminal failure.
    if (outcome.detail.includes("quarantined:")) {
      this.options.backlog.settle(item.identity, "quarantined", {
        detail: `admission:${outcome.detail.slice(0, 120)}`,
      });
      this.auditOutcome(item, "quarantined", "admission_refused");
      return;
    }
    this.options.backlog.settle(item.identity, "failed_terminal", {
      detail: `sink_refused:${outcome.detail.slice(0, 120)}`,
    });
    this.auditOutcome(item, "failed_terminal", `sink_refused`);
  }

  /**
   * Bounded owner-visible liveness warning (§4.2): ONE line when the
   * oldest deferred item exceeds the SLO, at most once per interval.
   */
  async maybeWarn(): Promise<void> {
    if (this.options.warn === undefined) {
      return;
    }
    const counters = this.options.backlog.counters();
    if (counters.oldest_deferred_at === null) {
      return;
    }
    const ageSeconds = (this.now().getTime() - Date.parse(counters.oldest_deferred_at)) / 1000;
    if (ageSeconds < this.budget.deferredSloSeconds) {
      return;
    }
    const lastWarned = this.options.backlog.getMeta("last_warning_at");
    if (
      lastWarned !== null &&
      lastWarned !== "" &&
      this.now().getTime() - Date.parse(lastWarned) < this.budget.warnIntervalSeconds * 1000
    ) {
      return;
    }
    this.options.backlog.setMeta("last_warning_at", this.now().toISOString());
    const pending = counters.deferred_total + counters.retryable_failed_total;
    await this.options.warn(
      `Memory decision backlog: oldest pending item is ${Math.floor(ageSeconds / 3600)} hour(s) old; ${pending} item(s) remain. Processing continues automatically.`,
    );
    this.options.audit({ type: "decision_backlog_warning", pending, oldest: counters.oldest_deferred_at });
  }

  status(): Record<string, unknown> {
    const counters = this.options.backlog.counters();
    const nowMs = this.now().getTime();
    return {
      mode: this.options.mode,
      policy: this.options.policy()?.policyId ?? null,
      ...counters,
      calls_last_hour: this.options.backlog.callsReservedSince(new Date(nowMs - 3_600_000).toISOString()),
      calls_last_day: this.options.backlog.callsReservedSince(new Date(nowMs - 86_400_000).toISOString()),
      budget_per_hour: this.budget.maxPerHour,
      budget_per_day: this.budget.maxPerDay,
      breaker_until: this.options.backlog.getMeta("worker_breaker_until"),
    };
  }

  private auditOutcome(
    item: BacklogItemRow,
    outcome: string,
    detail?: string,
    memoryId?: string,
    extra?: Record<string, unknown>,
  ): void {
    this.options.audit({
      type: "decision_backlog",
      outcome,
      origin: item.origin,
      identity: item.identity.slice(0, 16),
      turn_id: item.turn_id,
      content_sha256: item.content_sha256.slice(0, 16),
      ...(detail !== undefined ? { detail } : {}),
      ...(memoryId !== undefined ? { memory_id: memoryId } : {}),
      ...(extra ?? {}),
    });
  }
}
