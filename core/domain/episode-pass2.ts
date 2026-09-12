/**
 * L1-T03 Pass2 Offline Pure Core — deterministic contracts (03R2 §3).
 *
 * Authoritative spec: DELOS-L1-EPISODE-PROJECTION-DESIGN-03R2 §3 (SHA-256
 * 4355d114…f547afb240). This file is the single definition site for the Pass2
 * pure-core TYPES: the injected config, the versioned summary bundle + its
 * manifest, the three-kind summary call union (episode / chunk / assembly),
 * the model-output shapes (episode/assembly 9 fields, chunk 5 fields; §3.1.1 /
 * §3.1.2), the deterministic cache identities, and the candidate/pending
 * result with its SAFE (content-free) diagnostics.
 *
 * It reuses — never forks — the T01 payload domain (core/domain/episode.ts)
 * and the T02 Pass1 output types (core/domain/episode-pass1.ts). Everything is
 * pure and injected: NO real model, NO real transcript, NO DB, NO Date.now /
 * locale / random, NO provider/CLI/model-id literal. Behavioural logic lives in
 * the services layer; this file is contracts only.
 */

import type { Domain, Realm, Sensitivity } from "./episode.js";

// ---------------------------------------------------------------------------
// Injected config (§2.1 item 5) — no production defaults; every value explicit.
// ---------------------------------------------------------------------------

export interface Pass2Config {
  /** Rendered-length ceiling (code points) for one chunk. Positive int; no default. */
  chunkMax: number;
  /** Explosion guard: max chunks before a whole-episode pending. Positive int; no default. */
  maxChunks: number;
  /** Payload structure version — must equal T01 PAYLOAD_VERSION at build time. */
  payloadVersion: string;
  /** Pass2 prompt bundle version (e.g. sum-synthetic-v0). */
  summaryVersion: string;
  /** Opaque configured SUMMARY_MODEL value — core never inspects it. */
  modelId: string;
  /** Pass1 algorithm generation; provenance.projection_version ≡ this. */
  indexVersion: string;
  /** Strict Asia/Shanghai ISO instant with literal +08:00 (injected clock). */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Versioned summary bundle (§5.2 / §3.5) — nine defining components. Content is
// synthetic in T03; the pipeline accepts injection so vetted content needs no
// code change. The canonical hash is order-independent for object keys and
// changes on any one-byte component change.
// ---------------------------------------------------------------------------

/**
 * LEGACY bundle-v1 relative-time hint term shape (sum-v1..sum-v3 assets).
 * Kept ONLY so retired v1 assets remain readable byte-identical for
 * identity/immutability proofs (R1 §5.1); the production pipeline consumes
 * `TemporalHintTermV2` exclusively from bundle-v2 onward. Never migrated.
 */
export interface TemporalHintTerm {
  term: string;
  normalizable: boolean;
}

/**
 * R1 §3.1 typed calendar normalizer — a CLOSED union. The rule is semantic
 * CONTENT (lives only in the hashed asset, never as a code table); code is a
 * generic interpreter. All offsets/minutes are bounded finite domains so an
 * asset cannot smuggle open-ended behavior through the schema.
 */
export type TemporalNormalizerRule =
  | Readonly<{ kind: "day"; offset_days: -2 | -1 | 0 | 1 | 2; start_minute: number; end_minute: number }>
  | Readonly<{ kind: "week"; offset_weeks: -1 | 0 | 1; week_start: "monday" }>
  | Readonly<{ kind: "month"; offset_months: -1 | 0 | 1 }>
  | Readonly<{ kind: "year"; offset_years: -1 | 0 | 1 }>;

/** bundle-v2 relative-time hint term: content-owned rule or explicit null (non-normalizable). */
export interface TemporalHintTermV2 {
  readonly term: string;
  readonly normalizer: TemporalNormalizerRule | null;
}

export interface SummaryBundle {
  bundleSchemaVersion: string;
  summaryVersion: string;
  episodePrompt: string;
  chunkPrompt: string;
  assemblyPrompt: string;
  fewShots: readonly string[];
  /** V5 prediction-wording blacklist. */
  predictionBlacklist: readonly string[];
  /** V6 sensitivity lexicon (scans ORIGINAL text). */
  sensitivityLexicon: readonly string[];
  /** Version carrier of the AU lexicon (structure/content owned by T02/§2). */
  auLexiconVersion: string;
  /** Version carrier of the typed fiction lexicon. */
  fictionLexiconVersion: string;
  /**
   * V12/V13 relative-time hint lexicon. bundle-v2 typed shape (R1): each term
   * carries its own calendar rule or an explicit null. (bundle-v1 assets keep
   * the legacy `{term, normalizable}` shape on disk and are readable only via
   * the legacy identity loader — never through the production pipeline.)
   */
  temporalHintLexicon: readonly TemporalHintTermV2[];
  /**
   * The SINGLE canonical `au_id → display label` mapping (G1A Erratum 5 +
   * closure-review B). It is the ONE source for the realm=au display word
   * everywhere (`buildMetaHeader`, the prompt first line, V4's exact display
   * comparison, `metadataLabels`) AND for the uncertain AU-marker scan (both a
   * key and its value are AU markers). A `Record` gives unique ids by
   * construction (no duplicates) and, via `canonicalJson`, an order-independent
   * hash: a one-byte label change moves the bundle hash, key insertion order
   * does not — no hand-synced version string.
   */
  auDisplayById: Readonly<Record<string, string>>;
}

/**
 * LEGACY bundle-v1 in-memory shape (sum-v1..sum-v3): identical to
 * `SummaryBundle` except the lexicon keeps the retired `{term, normalizable}`
 * entries. Readable ONLY via the legacy identity loader for immutability /
 * hash proofs; never enters the production pipeline (R1 §5.1: v1 assets must
 * not masquerade as v2, and no migrator may reinterpret them).
 */
export type SummaryBundleV1 = Omit<SummaryBundle, "temporalHintLexicon"> & {
  readonly temporalHintLexicon: readonly TemporalHintTerm[];
};

/** Governance-registered `(summaryVersion, summaryBundleHash)` for drift detection. */
export interface SummaryBundleManifest {
  summaryVersion: string;
  /** `sha256:` + 64 hex over the canonical bundle bytes. */
  summaryBundleHash: string;
}

// ---------------------------------------------------------------------------
// Metadata header (§3.2.1) — deterministic from the Pass1 row. Shared by the
// episode and assembly inputs; carries NO original message content.
// ---------------------------------------------------------------------------

export interface EpisodeMetaHeader {
  /** The +08 start–end time string that a valid summary must byte-start with (V3). */
  timeString: string;
  /** realm display word: 现实 / <AU name> / 层面未定 (V4 compare base). */
  realmDisplay: string;
  realm: Realm;
  auId: string | null;
  participants: readonly string[];
  /** domain suggestion enum table = the seven domains + `conflict` (archive-only). */
  domainSuggestions: readonly string[];
}

// ---------------------------------------------------------------------------
// Rendered units carry synthetic ORIGINAL content — present ONLY in the episode
// and chunk inputs, never in the assembly input (§6.2 structural guarantee).
// ---------------------------------------------------------------------------

export interface RenderedUnit {
  /** Evidence reference: `message_id`, or `message_id#slice_<n>` for a slice. */
  refId: string;
  bareMessageId: string;
  /** 1-based slice ordinal, or null for a whole message. */
  sliceOrdinal: number | null;
  /** Total slices for this message (k), or null for a whole message. */
  sliceTotal: number | null;
  /** Fully rendered line, e.g. `[m-1] [09:07] Owner: …` / `[m-2] [09:08] Companion(主动消息): …`. */
  line: string;
  /** Rendered-length (code points) used by the greedy packer — includes the prefix. */
  renderedLength: number;
  /** Archive UTC timestamp of the source message — a chunk_hash input (§3.2.2). */
  timestampUtc: string;
  /** Source role — a chunk_hash input. */
  role: string;
  /** RAW content this unit carries (whole message contentNfc, or the slice's text) — chunk_hash input. */
  content: string;
}

/** Model output for a validated chunk summary — the assembly input's only payload (§3.1.1, 5 fields). */
export interface ChunkModelOutput {
  claims: ModelClaim[];
  entities: string[];
  temporal_hints: ModelTemporalHint[];
  confidence: number | null;
  uncertain_flags: string[];
}

// ---------------------------------------------------------------------------
// Three-kind structured call (§5.1). The assembly variant has NO units/content
// field — the type itself forbids original text from entering assembly.
// ---------------------------------------------------------------------------

export type SummaryCall =
  | { kind: "episode"; header: EpisodeMetaHeader; units: readonly RenderedUnit[] }
  | {
      kind: "chunk";
      ordinal: number;
      total: number;
      chunkHash: string;
      /** +08 start–end span of THIS block (first→last unit archive UTC via time-labels; §3.1.1 c02). */
      timeSpan: string;
      units: readonly RenderedUnit[];
    }
  | {
      kind: "assembly";
      header: EpisodeMetaHeader;
      n: number;
      /** Validated chunk-summary JSON, in chunk order — NO original text. */
      chunkSummaries: readonly ChunkModelOutput[];
      /** Canonical fingerprint of the chunk-summary set (§3.5). */
      inputFingerprint: string;
    };

// ---------------------------------------------------------------------------
// Raw model-output shapes (§3.1 / §3.1.1). Parsing yields `unknown`; V0
// validates and narrows to these. episode/assembly = 9 fields, chunk = 5.
// ---------------------------------------------------------------------------

export interface ModelClaim {
  text: string;
  kind: string;
  evidence_message_ids: string[];
}

export interface ModelTemporalHint {
  text: string;
  message_id: string;
  normalized_range: string | null;
  confidence: number;
}

export interface EpisodeModelOutput {
  title: string;
  summary: string;
  claims: ModelClaim[];
  entities: string[];
  temporal_hints: ModelTemporalHint[];
  domain_suggestion: string | null;
  sensitivity: string;
  confidence: number | null;
  uncertain_flags: string[];
}

/** The nine model-output keys (episode/assembly) — V0 unknown-field gate uses this exact set. */
export const EPISODE_MODEL_KEYS = [
  "title",
  "summary",
  "claims",
  "entities",
  "temporal_hints",
  "domain_suggestion",
  "sensitivity",
  "confidence",
  "uncertain_flags",
] as const;

/** The five model-output keys (chunk variant) — V0 block variant uses this exact set. */
export const CHUNK_MODEL_KEYS = ["claims", "entities", "temporal_hints", "confidence", "uncertain_flags"] as const;

// ---------------------------------------------------------------------------
// Deterministic cache identities (§3.5) — structured, unambiguous encodings
// (null ≠ empty string), NOT string concatenation.
// ---------------------------------------------------------------------------

/** Episode/assembly six-component key (§3.5). */
export interface EpisodeCacheKey {
  source_hash: string;
  summary_version: string;
  model: string;
  effective_realm: Realm;
  effective_au_id: string | null;
  effective_domain: Domain;
}

/** Chunk three-component key (§3.5) — realm/au/domain-independent. */
export interface ChunkCacheKey {
  chunk_hash: string;
  summary_version: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Result + SAFE diagnostics (§5.4). SafeDetail/SafeDiagnostics NEVER carry
// original text, model output, prompts, or raw exception messages — only
// V-ids, stable categories, chunk i/N, counts and hash prefixes.
// ---------------------------------------------------------------------------

/** One safe locator: a stable code plus optional metadata-only location/count. */
export interface SafeDetail {
  /** V-id ("V3"), a stable category ("chunking_overflow"), or a port error kind. */
  code: string;
  /** Metadata-only location, e.g. "chunk:2/5" or "assembly". */
  location?: string;
  /** Metadata-only count (e.g. sentence count), never text. */
  count?: number;
}

/** Content-free diagnostics bag returned with every result. */
export interface SafeDiagnostics {
  chunkCount: number;
  prunedEntities: number;
  prunedHints: number;
  /** Stable warn codes (e.g. "hint_not_recorded"). */
  warns: string[];
  /** Pipeline-appended uncertain flags (only ever "type_mismatch"). */
  appendedFlags: string[];
  /** Ordered validator issue codes that fired (metadata only), e.g. "V8:entity_pruned". */
  notes: string[];
}

export type Pass2PendingReason = "validation_failed" | "model_error";

export type Pass2CoreResult =
  | { status: "candidate"; payload: import("./episode.js").EpisodePayload; diagnostics: SafeDiagnostics }
  | { status: "pending"; reason: Pass2PendingReason; detail: SafeDetail; diagnostics: SafeDiagnostics };

// ---------------------------------------------------------------------------
// Validator wiring (§8 / §3.3). Issues sort by (validatorId, fieldPath,
// stableCode); validators are pure and return typed issues.
// ---------------------------------------------------------------------------

export type ValidatorSeverity = "hard" | "soft" | "annotate";

export interface ValidatorIssue {
  /** e.g. "V3". */
  validatorId: string;
  /** JSON-ish path of the offending field, e.g. "summary" / "claims[2].evidence_message_ids". */
  fieldPath: string;
  /** Stable machine code, e.g. "missing_time_prefix". NEVER content. */
  stableCode: string;
  severity: ValidatorSeverity;
}

export type EpisodeOrAssemblyKind = "episode" | "assembly";

/** Small helpers re-exported so services/tests share one guard source. */
export type { Domain, Realm, Sensitivity };
