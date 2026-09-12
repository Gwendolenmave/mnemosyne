/**
 * L1 Episode Projection — canonical domain vocabulary (offline foundation).
 *
 * Authoritative construction spec: DELOS-L1-EPISODE-PROJECTION-DESIGN-03R2
 * (SHA-256 4355d114…f547afb240). This file is the single definition site
 * for the Episode Projection's closed enums, the versioned payload
 * container (§1.1.2), the human-override event shapes (§1.4.2), the
 * deterministic episode_id (§1.2), and the small format primitives shared
 * by the validators and the harness (strict +08:00 time, ULID override ids).
 * It is a projection domain, entirely separate from the Mnemosyne memory
 * domain (core/domain/memory.ts): it references no transport, provider,
 * backend, model id, or delos-memory.db.
 *
 * T01 scope: types + closed-enum guards only. The Pass1 segmentation that
 * PRODUCES these rows, the Pass2 pipeline that fills payloads, and the
 * override replay that mutates them are later tickets and live nowhere in
 * this file.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// episode_id (§1.2) — deterministic, ≥128-bit
// ---------------------------------------------------------------------------

type Brand<T extends string> = string & { readonly __delosBrand: T };

/** `ep-` + first 32 lowercase hex of sha256(conversation_id + ":" + first member message_id). */
export type EpisodeId = Brand<"EpisodeId">;

const EPISODE_ID = /^ep-[0-9a-f]{32}$/;

/** Exactly the `ep-<32 lowercase hex>` form this projection mints (§1.2). */
export const isEpisodeId = (value: string): boolean => EPISODE_ID.test(value);

/**
 * The one algorithm (§1.2): id depends only on the conversation and the
 * episode's FIRST member message, so appending to an open tail never
 * changes it. Input is UTF-8; output is lowercase hex truncated to 32
 * chars (128 bits). Byte-deterministic — the same inputs always yield the
 * same id, which is what makes two rebuilds stable.
 */
export function episodeIdFor(conversationId: string, firstMemberMessageId: string): EpisodeId {
  const hex = createHash("sha256")
    .update(`${conversationId}:${firstMemberMessageId}`, "utf8")
    .digest("hex");
  return `ep-${hex.slice(0, 32)}` as EpisodeId;
}

/** Checked constructor: a plain string becomes an EpisodeId only if well-formed. */
export const asEpisodeId = (value: string): EpisodeId => {
  if (!isEpisodeId(value)) {
    throw new Error(`EpisodeId must match ^ep-[0-9a-f]{32}$, got "${value}"`);
  }
  return value as EpisodeId;
};

// ---------------------------------------------------------------------------
// Format primitives shared by validators and the harness.
// ---------------------------------------------------------------------------

const SHANGHAI_ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+08:00$/;

/**
 * Strict Asia/Shanghai ISO instant (§1.1.1 field 5 / time-labels discipline):
 * exactly `YYYY-MM-DDTHH:MM:SS(.mmm)?+08:00` with a LITERAL `+08:00` offset,
 * and a real calendar date/time (verified by a UTC reparse round-trip). A
 * `Z` suffix, a naive datetime with no offset, any other offset, and rolled-
 * over dates (e.g. 2099-02-30) are all rejected. Naive UTC is banned from
 * every model-facing render, so the projection's own timestamps must carry
 * the explicit local offset.
 */
export function isShanghaiIso(value: string): boolean {
  if (!SHANGHAI_ISO.test(value)) return false;
  const wall = value.slice(0, -6); // strip "+08:00"
  const parsed = new Date(`${wall}Z`);
  if (!Number.isFinite(parsed.getTime())) return false;
  const expected = `${wall.length === 23 ? wall : `${wall}.000`}Z`;
  return parsed.toISOString() === expected;
}

// ULID: 26-char Crockford base32 (excludes I, L, O, U), first char 0-7.
const OVERRIDE_ID = /^ov-[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Override id = `ov-` + a full canonical ULID (§1.4.2 event envelope). */
export const isOverrideId = (value: string): boolean => OVERRIDE_ID.test(value);

// ---------------------------------------------------------------------------
// Closed enums (§1.1.1–§1.1.6). Each is a `readonly` array (runtime domain)
// plus a derived union type and a guard. A new value is a spec change, never
// an ad-hoc string; retired vocabulary (scope / episode_type / active /
// reopened / published_at / ACTIVE_TTL_H / set_field summary) simply has no
// entry here and is rejected as an unknown field by the validators.
// ---------------------------------------------------------------------------

const member = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

/** World layer: reality, an architected universe, or undetermined (§1.1.1 field 3). */
export const REALMS = ["reality", "au", "uncertain"] as const;
export type Realm = (typeof REALMS)[number];
export const isRealm = (v: string): v is Realm => member(REALMS, v);

/** Deterministic evidence class behind the realm judgment (§1.1.1 field 3b, NB1). */
export const REALM_BASES = [
  "configured_prior",
  "au_lexicon",
  "fiction_signal",
  "continuation_link",
  "no_evidence",
] as const;
export type RealmBasis = (typeof REALM_BASES)[number];
export const isRealmBasis = (v: string): v is RealmBasis => member(REALM_BASES, v);

/** Content domain, orthogonal to realm; episode_type is folded in here (§1.1.1 field 3). */
export const DOMAINS = [
  "relationship",
  "project",
  "planning",
  "daily",
  "scene",
  "proactive",
  "uncertain",
] as const;
export type Domain = (typeof DOMAINS)[number];
export const isDomain = (v: string): v is Domain => member(DOMAINS, v);

/** Pure historical-projection status — NO wall-clock / TTL (§1.1.3 field 11). */
export const EPISODE_STATUSES = ["closed", "open_at_archive_end"] as const;
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];
export const isEpisodeStatus = (v: string): v is EpisodeStatus => member(EPISODE_STATUSES, v);

/** Sensitivity ladder, shared with Mnemosyne vocabulary (§1.1.4 field 16). */
export const SENSITIVITIES = ["normal", "sensitive", "intimate"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
export const isSensitivity = (v: string): v is Sensitivity => member(SENSITIVITIES, v);

/** Order for the max() rules in §1.1.4 field 16 and §1.4.5 (normal < sensitive < intimate). */
const SENSITIVITY_RANK: Record<Sensitivity, number> = { normal: 0, sensitive: 1, intimate: 2 };

/** Deterministic ladder-max used by the (future) row/owner sensitivity rules. */
export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b;
}

/** First-turn initiator (§1.1.5). */
export const INITIATORS = ["owner", "companion", "companion_proactive"] as const;
export type Initiator = (typeof INITIATORS)[number];
export const isInitiator = (v: string): v is Initiator => member(INITIATORS, v);

/** Conversation participants; a non-empty subset of this set (§1.1.2 field 6). */
export const PARTICIPANTS = ["owner", "companion"] as const;
export type Participant = (typeof PARTICIPANTS)[number];
export const isParticipant = (v: string): v is Participant => member(PARTICIPANTS, v);

/** Six-value pending reason; NULL row-side means terminal (§1.1.2 field 10 / §1.1.6). */
export const GENERATED_PENDING_REASONS = [
  "not_run",
  "quota_exhausted",
  "validation_failed",
  "model_error",
  "interrupted",
  "model_unverified",
] as const;
export type GeneratedPendingReason = (typeof GENERATED_PENDING_REASONS)[number];
export const isGeneratedPendingReason = (v: string): v is GeneratedPendingReason =>
  member(GENERATED_PENDING_REASONS, v);

/** Claim kind — model packages require it; owner packages may omit it (§1.1.2). */
export const CLAIM_KINDS = ["event", "decision", "unfinished"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const isClaimKind = (v: string): v is ClaimKind => member(CLAIM_KINDS, v);

/** Owner-package evidence coverage, replacing the old boolean (§1.1.2, Errata 1). */
export const MESSAGE_EVIDENCE_COVERAGES = ["complete", "partial", "none"] as const;
export type MessageEvidenceCoverage = (typeof MESSAGE_EVIDENCE_COVERAGES)[number];
export const isMessageEvidenceCoverage = (v: string): v is MessageEvidenceCoverage =>
  member(MESSAGE_EVIDENCE_COVERAGES, v);

/**
 * Closed `uncertain_flags` vocabulary for a PERSISTED payload (§1.1.2 /
 * §3 V-flags). `truncated_input` exists only for backward compatibility
 * with historical data — the current pipeline must never produce it (NB5);
 * `type_mismatch` is produced only by the pipeline validator. Any unknown
 * string is rejected by the persisted-payload validator.
 */
export const UNCERTAIN_FLAGS = [
  "scope",
  "reality",
  "referent",
  "time",
  "continuation",
  "source_conflict",
  "truncated_input",
  "type_mismatch",
] as const;
export type UncertainFlag = (typeof UNCERTAIN_FLAGS)[number];
export const isUncertainFlag = (v: string): v is UncertainFlag => member(UNCERTAIN_FLAGS, v);

/**
 * The six-value subset a model is allowed to emit (Pass2 boundary). The two
 * excluded values are not model-producible: `truncated_input` (compat only)
 * and `type_mismatch` (pipeline-validator only). Enforcement of this subset
 * on raw model output belongs to the Pass2 validator (a later ticket); this
 * constant fixes the type boundary now.
 */
export const MODEL_UNCERTAIN_FLAGS = [
  "scope",
  "reality",
  "referent",
  "time",
  "continuation",
  "source_conflict",
] as const;
export type ModelUncertainFlag = (typeof MODEL_UNCERTAIN_FLAGS)[number];
export const isModelUncertainFlag = (v: string): v is ModelUncertainFlag =>
  member(MODEL_UNCERTAIN_FLAGS, v);

/** Where a payload's authority comes from (§1.1.2). */
export const PAYLOAD_SOURCE_BASES = ["model", "owner_override"] as const;
export type PayloadSourceBasis = (typeof PAYLOAD_SOURCE_BASES)[number];
export const isPayloadSourceBasis = (v: string): v is PayloadSourceBasis =>
  member(PAYLOAD_SOURCE_BASES, v);

/** history_payloads retirement reasons (§1.1.6). */
export const SUPERSEDED_REASONS = [
  "source_changed",
  "semantics_changed",
  "version_upgrade",
  "owner_override",
] as const;
export type SupersededReason = (typeof SUPERSEDED_REASONS)[number];
export const isSupersededReason = (v: string): v is SupersededReason =>
  member(SUPERSEDED_REASONS, v);

/** Override taxonomy (§1.4). */
export const OVERRIDE_KINDS = ["field", "boundary"] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];
export const isOverrideKind = (v: string): v is OverrideKind => member(OVERRIDE_KINDS, v);

export const OVERRIDE_OPS = [
  "set_field",
  "replace_summary",
  "split_before_message",
  "merge_adjacent",
  "link_continuation",
  "unlink_continuation",
] as const;
export type OverrideOp = (typeof OVERRIDE_OPS)[number];
export const isOverrideOp = (v: string): v is OverrideOp => member(OVERRIDE_OPS, v);

/** Per-generation override application state, for the overrides_applied ledger (§1.1.6). */
export const OVERRIDE_STATES = [
  "applied",
  "reanchored",
  "needs_review",
  "unmatched",
  "no_op",
] as const;
export type OverrideState = (typeof OVERRIDE_STATES)[number];
export const isOverrideState = (v: string): v is OverrideState => member(OVERRIDE_STATES, v);

/**
 * Override authorship vocabulary. `owner` is the ONLY author enabled in v1;
 * `companion` is a reserved value that is NOT enabled (decided item D10) and is
 * rejected by the event validators at runtime. Keeping it in the vocabulary
 * distinguishes "reserved but not yet enabled" from "unknown author".
 */
export const OVERRIDE_AUTHORS = ["owner", "companion"] as const;
export type OverrideAuthor = (typeof OVERRIDE_AUTHORS)[number];
export const isOverrideAuthor = (v: string): v is OverrideAuthor => member(OVERRIDE_AUTHORS, v);

/** Authors actually enabled to apply overrides in v1 (a reserved value must not be here). */
export const ENABLED_OVERRIDE_AUTHORS = ["owner"] as const;
export type EnabledOverrideAuthor = (typeof ENABLED_OVERRIDE_AUTHORS)[number];
export const isEnabledOverrideAuthor = (v: string): v is EnabledOverrideAuthor =>
  member(ENABLED_OVERRIDE_AUTHORS, v);

/** Boundary ops that carry a link_target (§1.4.3). */
export const LINK_OPS: readonly OverrideOp[] = ["link_continuation", "unlink_continuation"];

/** Display-title character ceiling for the materialized column (§1.1.2 field 7). */
export const TITLE_MAX_CHARS = 40;

/** Character (code-point) count, so a 40-字 CJK ceiling counts characters, not UTF-16 units. */
export const titleCharCount = (title: string): number => [...title].length;

// ---------------------------------------------------------------------------
// Payload container (§1.1.2). generated / published / history are the SAME
// self-describing versioned JSON whole — there are no loose scalar summary
// columns. `sensitivity` is a top-level member of every payload (Errata 2).
// ---------------------------------------------------------------------------

/** Current payload structure version (structure evolution == value change). */
export const PAYLOAD_VERSION = "pl-v1";

export interface EpisodeClaim {
  text: string;
  /** Required on model packages; omittable on owner packages (§1.1.2). */
  kind?: ClaimKind;
  /** `message_id` or `message_id#slice_n`; membership is judged on the bare id (§1.1.2). */
  evidence_message_ids?: string[];
}

export interface TemporalHint {
  text: string;
  message_id: string;
  normalized_range: string;
  confidence: number;
}

export interface PayloadGenerator {
  /** Opaque configured SUMMARY_MODEL value; core carries it, never a literal (§3.4). */
  model: string;
  summary_version: string;
  /** projection_version ≡ index_version (§1.1.4 field 14). */
  projection_version: string;
}

export interface EpisodeProvenance {
  /** `sha256:` + full 64-hex digest of the canonical member serialization. */
  source_hash: string;
  effective_realm: Realm;
  effective_au_id: string | null;
  effective_domain: Domain;
  /** Model packages carry a generator; owner packages carry null (§1.1.2). */
  generator: PayloadGenerator | null;
  /** Strict Asia/Shanghai ISO instant with literal +08:00 (§1.1.2). */
  created_at: string;
  source_basis: PayloadSourceBasis;
}

export interface EpisodePayload {
  payload_version: string;
  /** Materialized display title (≤40 chars), or null on an owner package that omitted it. */
  title: string | null;
  summary: string;
  claims: EpisodeClaim[];
  temporal_hints: TemporalHint[];
  entities_model: string[];
  /** Closed persisted vocabulary (§1.1.2); unknown strings are rejected. */
  uncertain_flags: UncertainFlag[];
  summary_confidence: number | null;
  domain_suggestion: string | null;
  /** Top-level, required on ALL three payload types (Errata 2). */
  sensitivity: Sensitivity;
  provenance: EpisodeProvenance;
  /** Owner packages only (source_basis=owner_override); forbidden on model packages. */
  message_evidence_coverage?: MessageEvidenceCoverage;
}

// ---------------------------------------------------------------------------
// Human override events (§1.4.2). The append-only episode-overrides.jsonl is
// the true source; these are its record shapes. T01 defines and validates the
// shapes; the replay that applies them is a later ticket.
// ---------------------------------------------------------------------------

export interface OverrideSpan {
  conversation_id: string;
  start_message_id: string;
  end_message_id: string;
}

export interface FieldTarget {
  episode_id: string;
  span: OverrideSpan;
}

/** set_field allowed keys (§1.4.2): NO summary, NO realm_basis, NO continuation_links. */
export interface SetFieldFields {
  title?: string;
  realm?: Realm;
  au_id?: string;
  domain?: Domain;
  sensitivity?: Sensitivity;
  /** status key accepts `closed` only (open_at_archive_end is Pass1-only). */
  status?: "closed";
}

export interface SetFieldEvent {
  override_id: string;
  created_at: string;
  author: OverrideAuthor;
  kind: "field";
  op: "set_field";
  target: FieldTarget;
  fields: SetFieldFields;
  reason?: string;
  base: { index_version: string; source_hash: string };
}

export interface ReplaceSummaryReplacement {
  title?: string;
  summary: string;
  claims?: EpisodeClaim[];
  supporting_message_ids?: string[];
}

export interface ReplaceSummaryEvent {
  override_id: string;
  created_at: string;
  author: OverrideAuthor;
  kind: "field";
  op: "replace_summary";
  target: FieldTarget;
  replacement: ReplaceSummaryReplacement;
  reason?: string;
  /**
   * base carries the REQUIRED `sensitivity_at_write` true-source snapshot
   * (closure ruling A): the governance write-gate auto-copies the then-
   * effective row.sensitivity here so a bare rebuild (projection + cache
   * deleted) recovers the owner ladder deterministically. There is NO path
   * that recovers it from a surviving projection.
   */
  base: { index_version: string; source_hash: string; sensitivity_at_write: Sensitivity };
}

export interface BoundaryEvent {
  override_id: string;
  created_at: string;
  author: OverrideAuthor;
  kind: "boundary";
  op: "split_before_message" | "merge_adjacent" | "link_continuation" | "unlink_continuation";
  anchor: { conversation_id: string; message_id: string };
  /** Only link_continuation / unlink_continuation use this. */
  link_target?: { conversation_id: string; message_id: string };
  reason?: string;
  base: { index_version: string; episode_id_at_write: string };
}
