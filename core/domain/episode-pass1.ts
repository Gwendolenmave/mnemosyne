/**
 * L1-T02 Pass1 — deterministic offline segmentation contracts.
 *
 * Authoritative spec: DELOS-L1-EPISODE-PROJECTION-DESIGN-03R2 §2 (SHA-256
 * 4355d114…f547afb240). This file is the single definition site for the
 * Pass1 domain types (normalized message, atomic turn, injected versioned
 * config + lexicons, and the Pass1 output rows), the canonical
 * serializer used for byte-stable export and the config fingerprint, and
 * the deterministic config validators. It reuses — never forks — the T01
 * episode domain (core/domain/episode.ts).
 *
 * Everything here is pure and injected: NO production defaults, NO
 * Date.now/random/locale, NO model, NO real transcript. Segmentation logic
 * lives in the services layer; this file is contracts + config integrity.
 */

import { createHash } from "node:crypto";
import type { Domain, Initiator, Participant, Realm, RealmBasis, Sensitivity } from "./episode.js";
import {
  isDomain,
  isEpisodeId,
  isRealm,
  isRealmBasis,
  isSensitivity,
  SENSITIVITIES,
} from "./episode.js";
import type { ValidationIssue, ValidationResult } from "./episode-validation.js";

// ---------------------------------------------------------------------------
// Normalized input message & atomic turn (§5.1 / §5.2)
// ---------------------------------------------------------------------------

/** Pass1 role vocabulary — user→owner, assistant→companion (§5.1). */
export type Pass1Role = "owner" | "companion";

export interface Pass1Message {
  /** Safe relative identifier (never an absolute path). */
  sourceFileId: string;
  sourceLine: number;
  conversationId: string;
  eventType: "user_message_persisted" | "assistant_message_persisted";
  role: Pass1Role;
  messageId: string;
  turnId: string | null;
  /** Archive on-disk canonical UTC ISO `Z`. */
  timestampUtc: string;
  epochMs: number;
  /** Unicode NFC content — MEMORY ONLY, never persisted or reported. */
  contentNfc: string;
  proactive: boolean;
}

export interface Pass1Turn {
  turnKey: string;
  conversationId: string;
  messages: readonly Pass1Message[];
  startedAtEpochMs: number;
  endedAtEpochMs: number;
  proactive: boolean;
  orphanAssistant: boolean;
}

// ---------------------------------------------------------------------------
// Injected versioned lexicon bundle (§5.4). Content is `synthetic-test-v0`
// placeholders in T02; the engine accepts injection so future vetted content
// needs no algorithm change.
// ---------------------------------------------------------------------------

/** Continuation cue terms — matched from message start, exact|prefix, no regex. */
export interface ContinuationLexicon {
  version: string;
  terms: readonly string[];
}

export interface StopwordLexicon {
  version: string;
  words: readonly string[];
}

export interface AuLexiconEntry {
  au_id: string;
  unique_terms: readonly string[];
  shared_terms: readonly string[];
  default_sensitivity: Sensitivity;
}

export interface AuLexicon {
  version: string;
  entries: readonly AuLexiconEntry[];
}

export type FictionMode = "enactment" | "meta" | "exit";
export type FictionStrength = "strong" | "weak";

/** Co-occurrence requirement for a weak fiction entry (§2.5.5). */
export interface FictionCooccur {
  /** "fiction_signal" = another fiction valid hit; "au_term" = any AU term hit. */
  requires: "fiction_signal" | "au_term";
  /** same message, or a fixed window of adjacent turns. */
  window: "same_message" | { adjacentTurns: number };
}

/** Negation context: any of `terms` within `charWindow` code points before term cancels the hit. */
export interface FictionNegctx {
  terms: readonly string[];
  charWindow: number;
}

export interface FictionSignalEntry {
  term: string;
  mode: FictionMode;
  strength: FictionStrength;
  cooccur: FictionCooccur | null;
  negctx: FictionNegctx | null;
}

export interface FictionLexicon {
  version: string;
  entries: readonly FictionSignalEntry[];
}

/** Weighted content lexicon (project / relationship / schedule) — integer scoring, exact|prefix. */
export interface WeightedTerm {
  term: string;
  weight: number;
}

export interface WeightedLexicon {
  version: string;
  terms: readonly WeightedTerm[];
}

export interface SensitivityLexiconEntry {
  term: string;
  level: Sensitivity;
}

export interface SensitivityLexicon {
  version: string;
  entries: readonly SensitivityLexiconEntry[];
}

export interface VersionedPass1LexiconBundle {
  continuation: ContinuationLexicon;
  stopwords: StopwordLexicon;
  au: AuLexicon;
  fiction: FictionLexicon;
  project: WeightedLexicon;
  relationship: WeightedLexicon;
  schedule: WeightedLexicon;
  sensitivity: SensitivityLexicon;
}

/** Per-conversation vetted realm prior (§2.5.1); NO code-level global default. */
export interface DefaultRealmEntry {
  conversation_id: string;
  default_realm: "reality" | "au";
  au_id: string | null;
}

export interface VersionedDefaultRealmConfig {
  version: string;
  entries: readonly DefaultRealmEntry[];
}

// ---------------------------------------------------------------------------
// Pass1 config (§5.3) — everything injected, versioned, fingerprinted.
// ---------------------------------------------------------------------------

export interface Pass1Thresholds {
  gapHardMinutes: number;
  gapSoftMinutes: number;
  windowTurns: number;
  topicJaccardMin: number;
  auAssignMin: number;
  auLeadMin: number;
  /** v1 lead branch closed — MUST be null. */
  continuationLeadMin: null;
}

export interface Pass1Config {
  indexVersion: string;
  /** sha256:<64hex> governance-registered fingerprint of {thresholds,lexicons,defaultRealms}. */
  expectedConfigHash: string;
  summaryVersion: string;
  thresholds: Pass1Thresholds;
  lexicons: VersionedPass1LexiconBundle;
  defaultRealms: VersionedDefaultRealmConfig;
}

// ---------------------------------------------------------------------------
// Pass1 output rows (§2.12 / §8). annotations are typed-trace only — NEVER
// persisted to episodes.db (§8.7).
// ---------------------------------------------------------------------------

export type Pass1AnnotationKind = "continuation_cue" | "fiction_meta" | "fiction_exit" | "topic_shift";

export interface Pass1Annotation {
  kind: Pass1AnnotationKind;
  message_id: string;
  rule_code: string;
}

export interface Pass1ContinuationLink {
  target_episode_id: string;
  relation: "continues";
  evidence: { kind: "explicit_marker" | "manual"; message_id: string };
}

export interface Pass1Membership {
  conversation_id: string;
  message_id: string;
  episode_id: string;
  seq: number;
}

export interface Pass1Episode {
  episode_id: string;
  channel: string;
  thread: string;
  realm: Realm;
  realm_basis: RealmBasis;
  au_id: string | null;
  domain: Domain;
  start_message_id: string;
  end_message_id: string;
  started_at_utc: string;
  ended_at_utc: string;
  started_at_local: string;
  ended_at_local: string;
  participants: readonly Participant[];
  initiator: Initiator;
  title: string;
  entities_lexical: readonly string[];
  status: "closed" | "open_at_archive_end";
  continuation_links: readonly Pass1ContinuationLink[];
  has_continuation: boolean;
  source_hash: string;
  index_version: string;
  summary_version: string;
  confidence: number;
  sensitivity: Sensitivity;
  message_count: number;
  proactive_count: number;
  overrides_applied_ids: readonly string[];
  /** Typed trace only — NOT written to episodes.db (§8.7). */
  annotations: readonly Pass1Annotation[];
}

export type Pass1OverrideState = "applied" | "reanchored" | "needs_review" | "unmatched" | "no_op";

export interface Pass1OverrideRecord {
  override_id: string;
  kind: "field" | "boundary";
  op: string;
  target: string;
  state: Pass1OverrideState;
  detail: string | null;
}

export interface Pass1UnresolvedCandidate {
  episode_id: string;
  score: number;
}

export interface Pass1Report {
  index_version: string;
  summary_version: string;
  pass1_config_hash: string;
  counts: {
    partitions: number;
    messages: number;
    turns: number;
    episodes: number;
    skipped_non_message: number;
    orphan_assistant: number;
    malformed_message: number;
    proactive_messages: number;
    deferred_field_overrides: number;
  };
  uncertain_by_basis: { fiction_signal: number; no_evidence: number };
  unresolved_continuations: ReadonlyArray<{ source_episode_id: string; candidates: readonly Pass1UnresolvedCandidate[] }>;
  low_confidence_episode_ids: readonly string[];
  override_states: Record<Pass1OverrideState, number>;
  realModelCalls: 0;
}

export interface Pass1Result {
  episodes: readonly Pass1Episode[];
  memberships: readonly Pass1Membership[];
  overrides: readonly Pass1OverrideRecord[];
  report: Pass1Report;
}

// ---------------------------------------------------------------------------
// Canonical serializer — recursively sorts object keys, preserves array
// order. Used for the config fingerprint AND byte-stable export compare face.
// ---------------------------------------------------------------------------

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const SHA256_HEX = /^sha256:[0-9a-f]{64}$/;

/**
 * Deterministic Pass1 config fingerprint (§5.3): sha256 over the canonical
 * JSON of {thresholds, lexicons, defaultRealms}. summaryVersion, indexVersion,
 * and expectedConfigHash itself are NOT part of the fingerprint.
 */
export function computePass1ConfigHash(config: Pass1Config): string {
  const canonical = canonicalJson({
    thresholds: config.thresholds,
    lexicons: config.lexicons,
    defaultRealms: config.defaultRealms,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Config validation (§5.3 / §5.4) — versions non-empty, thresholds legal,
// lexicon shapes legal, weak fiction needs cooccur, weak↔weak circular
// forbidden, default_realm↔au_id linkage, and drift (expectedConfigHash must
// equal the recomputed fingerprint).
// ---------------------------------------------------------------------------

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isPositiveNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Fold-identity duplicates (C3): matching is NFC + case-folded, so two terms
 * whose folds coincide (`CAT` vs `cat`) are the SAME matching rule listed
 * twice — they would double-score and desynchronize the fingerprint from the
 * matcher. Rejected as config_invalid.
 */
function checkFoldDuplicates(terms: readonly string[], path: string, issues: ValidationIssue[]): void {
  const seen = new Map<string, number>();
  terms.forEach((t, i) => {
    const folded = t.normalize("NFC").toLowerCase();
    const prev = seen.get(folded);
    if (prev !== undefined) {
      issues.push({ path: `${path}[${i}]`, message: `term duplicates entry ${prev} under case-fold (governance)` });
    } else {
      seen.set(folded, i);
    }
  });
}

/**
 * Governance for a term list (Erratum 1): every entry a non-empty string that
 * is NFC-normalized, with the list deduplicated (including under case-fold,
 * C3) and ascending-sorted so the config fingerprint is canonical w.r.t.
 * lexicon term order.
 */
function governStringList(terms: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(terms)) {
    issues.push({ path, message: "must be an array of strings" });
    return;
  }
  const valid: string[] = [];
  for (let i = 0; i < terms.length; i += 1) {
    const t = terms[i];
    if (!isNonEmptyString(t)) {
      issues.push({ path: `${path}[${i}]`, message: "must be a non-empty string" });
      continue;
    }
    valid.push(t);
    if (t.normalize("NFC") !== t) issues.push({ path: `${path}[${i}]`, message: "term must be NFC-normalized (governance)" });
    if (i > 0) {
      const prev = terms[i - 1];
      if (typeof prev === "string") {
        if (prev === t) issues.push({ path: `${path}[${i}]`, message: `duplicate term (governance: dedup)` });
        else if (prev > t) issues.push({ path: `${path}[${i}]`, message: "terms must be ascending-sorted (governance)" });
      }
    }
  }
  checkFoldDuplicates(valid, path, issues);
}

/** Governance for a keyed entry list: keys NFC-normalized, deduped, ascending-sorted. */
function governKeyedList(keys: readonly string[], path: string, issues: ValidationIssue[]): void {
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i]!;
    if (k.normalize("NFC") !== k) issues.push({ path: `${path}[${i}]`, message: "key must be NFC-normalized (governance)" });
    if (i > 0) {
      const prev = keys[i - 1]!;
      if (prev === k) issues.push({ path: `${path}[${i}]`, message: "duplicate key (governance: dedup)" });
      else if (prev > k) issues.push({ path: `${path}[${i}]`, message: "entries must be ascending-sorted by key (governance)" });
    }
  }
}

function checkVersion(version: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isNonEmptyString(version)) {
    issues.push({ path: `${path}.version`, message: "lexicon/config version must be a non-empty string" });
  }
}

function checkThresholds(t: unknown, issues: ValidationIssue[]): void {
  const p = "$.thresholds";
  if (!isObject(t)) {
    issues.push({ path: p, message: "thresholds must be an object" });
    return;
  }
  if (!isPositiveNumber(t.gapHardMinutes)) issues.push({ path: `${p}.gapHardMinutes`, message: "must be a positive number" });
  if (!isPositiveNumber(t.gapSoftMinutes)) issues.push({ path: `${p}.gapSoftMinutes`, message: "must be a positive number" });
  if (isPositiveNumber(t.gapHardMinutes) && isPositiveNumber(t.gapSoftMinutes) && t.gapSoftMinutes >= t.gapHardMinutes) {
    issues.push({ path: `${p}.gapSoftMinutes`, message: "gapSoftMinutes must be < gapHardMinutes" });
  }
  if (!isPositiveInt(t.windowTurns)) issues.push({ path: `${p}.windowTurns`, message: "must be a positive integer" });
  if (typeof t.topicJaccardMin !== "number" || !(t.topicJaccardMin >= 0 && t.topicJaccardMin <= 1)) {
    issues.push({ path: `${p}.topicJaccardMin`, message: "must be a number in [0,1]" });
  }
  if (!isPositiveInt(t.auAssignMin)) issues.push({ path: `${p}.auAssignMin`, message: "must be a positive integer" });
  if (!isPositiveInt(t.auLeadMin)) issues.push({ path: `${p}.auLeadMin`, message: "must be a positive integer" });
  if (t.continuationLeadMin !== null) {
    issues.push({ path: `${p}.continuationLeadMin`, message: "must be null in v1 (lead branch closed)" });
  }
}

/** Returns the set of legal au_ids in the AU lexicon (for the default_realm linkage check). */
function checkAu(au: unknown, issues: ValidationIssue[]): Set<string> {
  const auIds = new Set<string>();
  if (!isObject(au)) {
    issues.push({ path: "$.lexicons.au", message: "au lexicon must be an object" });
    return auIds;
  }
  checkVersion(au.version, "$.lexicons.au", issues);
  if (!Array.isArray(au.entries)) {
    issues.push({ path: "$.lexicons.au.entries", message: "must be an array" });
    return auIds;
  }
  const idSeq: string[] = [];
  au.entries.forEach((e: unknown, i) => {
    const p = `$.lexicons.au.entries[${i}]`;
    if (!isObject(e)) {
      issues.push({ path: p, message: "entry must be an object" });
      return;
    }
    if (!isNonEmptyString(e.au_id)) issues.push({ path: `${p}.au_id`, message: "au_id must be a non-empty string" });
    else {
      if (auIds.has(e.au_id)) issues.push({ path: `${p}.au_id`, message: `duplicate au_id ${e.au_id}` });
      auIds.add(e.au_id);
      idSeq.push(e.au_id);
    }
    governStringList(e.unique_terms, `${p}.unique_terms`, issues);
    governStringList(e.shared_terms, `${p}.shared_terms`, issues);
    if (typeof e.default_sensitivity !== "string" || !isSensitivity(e.default_sensitivity)) {
      issues.push({ path: `${p}.default_sensitivity`, message: `must be one of ${SENSITIVITIES.join("/")}` });
    }
  });
  governKeyedList(idSeq, "$.lexicons.au.entries.au_id", issues);
  return auIds;
}

function checkFiction(fiction: unknown, issues: ValidationIssue[]): void {
  if (!isObject(fiction)) {
    issues.push({ path: "$.lexicons.fiction", message: "fiction lexicon must be an object" });
    return;
  }
  checkVersion(fiction.version, "$.lexicons.fiction", issues);
  if (!Array.isArray(fiction.entries)) {
    issues.push({ path: "$.lexicons.fiction.entries", message: "must be an array" });
    return;
  }
  const entries = fiction.entries as FictionSignalEntry[];
  // ground set = strong entries OR weak entries grounded by au_term; a weak
  // entry whose cooccur requires "fiction_signal" needs some ground to exist,
  // else the co-occurrence chain is circular (§2.5.5).
  let hasGround = false;
  entries.forEach((e) => {
    if (isObject(e) && e.strength === "strong") hasGround = true;
    else if (isObject(e) && e.cooccur !== null && isObject(e.cooccur) && e.cooccur.requires === "au_term") hasGround = true;
  });
  let hasWeakRequiresFiction = false;
  const termSeq: string[] = [];
  entries.forEach((e: unknown, i) => {
    const p = `$.lexicons.fiction.entries[${i}]`;
    if (!isObject(e)) {
      issues.push({ path: p, message: "entry must be an object" });
      return;
    }
    if (!isNonEmptyString(e.term)) issues.push({ path: `${p}.term`, message: "term must be a non-empty string" });
    else termSeq.push(e.term);
    if (e.mode !== "enactment" && e.mode !== "meta" && e.mode !== "exit") {
      issues.push({ path: `${p}.mode`, message: "mode must be enactment/meta/exit" });
    }
    if (e.strength !== "strong" && e.strength !== "weak") {
      issues.push({ path: `${p}.strength`, message: "strength must be strong/weak" });
    }
    if (e.strength === "weak" && e.cooccur === null) {
      issues.push({ path: `${p}.cooccur`, message: "weak entries must declare a cooccur condition" });
    }
    if (e.cooccur !== null) {
      if (!isObject(e.cooccur)) {
        issues.push({ path: `${p}.cooccur`, message: "cooccur must be an object or null" });
      } else {
        if (e.cooccur.requires !== "fiction_signal" && e.cooccur.requires !== "au_term") {
          issues.push({ path: `${p}.cooccur.requires`, message: "requires must be fiction_signal/au_term" });
        }
        const w = e.cooccur.window;
        const okWindow = w === "same_message" || (isObject(w) && isPositiveInt(w.adjacentTurns));
        if (!okWindow) issues.push({ path: `${p}.cooccur.window`, message: "window must be same_message or {adjacentTurns:+int}" });
        if (e.strength === "weak" && e.cooccur.requires === "fiction_signal") hasWeakRequiresFiction = true;
      }
    }
    if (e.negctx !== null) {
      if (!isObject(e.negctx)) {
        issues.push({ path: `${p}.negctx`, message: "negctx must be an object or null" });
      } else {
        governStringList(e.negctx.terms, `${p}.negctx.terms`, issues);
        if (!isPositiveInt(e.negctx.charWindow)) issues.push({ path: `${p}.negctx.charWindow`, message: "must be a positive integer" });
      }
    }
  });
  governKeyedList(termSeq, "$.lexicons.fiction.entries.term", issues);
  checkFoldDuplicates(termSeq, "$.lexicons.fiction.entries.term", issues);
  if (hasWeakRequiresFiction && !hasGround) {
    issues.push({
      path: "$.lexicons.fiction",
      message: "weak↔weak circular cooccur: a weak entry requires a fiction_signal but no strong/au_term-grounded entry exists to terminate the chain",
    });
  }
}

function checkWeighted(lex: unknown, name: string, issues: ValidationIssue[]): void {
  const base = `$.lexicons.${name}`;
  if (!isObject(lex)) {
    issues.push({ path: base, message: `${name} lexicon must be an object` });
    return;
  }
  checkVersion(lex.version, base, issues);
  if (!Array.isArray(lex.terms)) {
    issues.push({ path: `${base}.terms`, message: "must be an array" });
    return;
  }
  const termSeq: string[] = [];
  lex.terms.forEach((t: unknown, i) => {
    const p = `${base}.terms[${i}]`;
    if (!isObject(t)) {
      issues.push({ path: p, message: "term entry must be an object" });
      return;
    }
    if (!isNonEmptyString(t.term)) issues.push({ path: `${p}.term`, message: "term must be a non-empty string" });
    else termSeq.push(t.term);
    if (!isPositiveInt(t.weight)) issues.push({ path: `${p}.weight`, message: "weight must be a positive integer" });
  });
  governKeyedList(termSeq, `${base}.terms.term`, issues);
  checkFoldDuplicates(termSeq, `${base}.terms.term`, issues);
}

function checkSensitivityLexicon(lex: unknown, issues: ValidationIssue[]): void {
  const base = "$.lexicons.sensitivity";
  if (!isObject(lex)) {
    issues.push({ path: base, message: "sensitivity lexicon must be an object" });
    return;
  }
  checkVersion(lex.version, base, issues);
  if (!Array.isArray(lex.entries)) {
    issues.push({ path: `${base}.entries`, message: "must be an array" });
    return;
  }
  const termSeq: string[] = [];
  lex.entries.forEach((e: unknown, i) => {
    const p = `${base}.entries[${i}]`;
    if (!isObject(e)) {
      issues.push({ path: p, message: "entry must be an object" });
      return;
    }
    if (!isNonEmptyString(e.term)) issues.push({ path: `${p}.term`, message: "must be a non-empty string" });
    else termSeq.push(e.term);
    if (typeof e.level !== "string" || !isSensitivity(e.level)) issues.push({ path: `${p}.level`, message: "invalid sensitivity level" });
  });
  governKeyedList(termSeq, `${base}.entries.term`, issues);
  checkFoldDuplicates(termSeq, `${base}.entries.term`, issues);
}

function checkContinuation(lex: unknown, issues: ValidationIssue[]): void {
  const base = "$.lexicons.continuation";
  if (!isObject(lex)) {
    issues.push({ path: base, message: "continuation lexicon must be an object" });
    return;
  }
  checkVersion(lex.version, base, issues);
  governStringList(lex.terms, `${base}.terms`, issues);
}

function checkStopwords(lex: unknown, issues: ValidationIssue[]): void {
  const base = "$.lexicons.stopwords";
  if (!isObject(lex)) {
    issues.push({ path: base, message: "stopwords lexicon must be an object" });
    return;
  }
  checkVersion(lex.version, base, issues);
  governStringList(lex.words, `${base}.words`, issues);
}

function checkDefaultRealms(cfg: unknown, auIds: ReadonlySet<string>, issues: ValidationIssue[]): void {
  if (!isObject(cfg)) {
    issues.push({ path: "$.defaultRealms", message: "defaultRealms must be an object" });
    return;
  }
  checkVersion(cfg.version, "$.defaultRealms", issues);
  if (!Array.isArray(cfg.entries)) {
    issues.push({ path: "$.defaultRealms.entries", message: "must be an array" });
    return;
  }
  const convSeq: string[] = [];
  cfg.entries.forEach((e: unknown, i) => {
    const p = `$.defaultRealms.entries[${i}]`;
    if (!isObject(e)) {
      issues.push({ path: p, message: "entry must be an object" });
      return;
    }
    if (!isNonEmptyString(e.conversation_id)) issues.push({ path: `${p}.conversation_id`, message: "must be a non-empty string" });
    else convSeq.push(e.conversation_id);
    if (e.default_realm !== "reality" && e.default_realm !== "au") {
      issues.push({ path: `${p}.default_realm`, message: "default_realm must be reality/au" });
    }
    if (e.default_realm === "au") {
      if (!isNonEmptyString(e.au_id)) issues.push({ path: `${p}.au_id`, message: "au_id required (non-empty) when default_realm is au" });
      else if (!auIds.has(e.au_id)) issues.push({ path: `${p}.au_id`, message: `au_id ${e.au_id} must exist in the AU lexicon` });
    }
    if (e.default_realm === "reality" && e.au_id !== null) {
      issues.push({ path: `${p}.au_id`, message: "au_id must be null when default_realm is reality" });
    }
  });
  governKeyedList(convSeq, "$.defaultRealms.entries.conversation_id", issues);
}

/**
 * Validate an injected Pass1 config — fully defensive (Erratum 1: unknown /
 * bad-shape input returns `config_invalid` issues, never throws on a missing
 * nested array), enforcing lexicon governance (NFC/dedup/sort) and the
 * default_realm→AU linkage, INCLUDING the drift check: the recomputed
 * fingerprint over {thresholds,lexicons,defaultRealms} must byte-equal
 * expectedConfigHash. A version that stayed the same while content changed
 * (so expectedConfigHash was not re-registered) fails as `config_bundle_drift`.
 */
export function validatePass1Config(config: unknown): ValidationResult<Pass1Config> {
  const issues: ValidationIssue[] = [];
  if (!isObject(config)) return { ok: false, issues: [{ path: "$", message: "config must be an object" }] };
  if (!isNonEmptyString(config.indexVersion)) issues.push({ path: "$.indexVersion", message: "must be a non-empty string" });
  if (!isNonEmptyString(config.summaryVersion)) issues.push({ path: "$.summaryVersion", message: "must be a non-empty string" });
  if (typeof config.expectedConfigHash !== "string" || !SHA256_HEX.test(config.expectedConfigHash)) {
    issues.push({ path: "$.expectedConfigHash", message: "must be sha256:<64 lowercase hex>" });
  }
  checkThresholds(config.thresholds, issues);
  if (!isObject(config.lexicons)) {
    issues.push({ path: "$.lexicons", message: "lexicons must be an object" });
    return { ok: false, issues };
  }
  const lex = config.lexicons;
  checkContinuation(lex.continuation, issues);
  checkStopwords(lex.stopwords, issues);
  const auIds = checkAu(lex.au, issues);
  checkFiction(lex.fiction, issues);
  checkWeighted(lex.project, "project", issues);
  checkWeighted(lex.relationship, "relationship", issues);
  checkWeighted(lex.schedule, "schedule", issues);
  checkSensitivityLexicon(lex.sensitivity, issues);
  checkDefaultRealms(config.defaultRealms, auIds, issues);

  // Drift gate — only meaningful once the shapes above are structurally sound.
  const cfg = config as unknown as Pass1Config;
  if (issues.length === 0) {
    const actual = computePass1ConfigHash(cfg);
    if (actual !== cfg.expectedConfigHash) {
      issues.push({
        path: "$.expectedConfigHash",
        message: `config_bundle_drift: expected ${cfg.expectedConfigHash} but recomputed ${actual}`,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: cfg };
}

// ---------------------------------------------------------------------------
// Small shared guards re-exported for the services/tests (single source).
// ---------------------------------------------------------------------------

export { isDomain, isEpisodeId, isRealm, isRealmBasis, isSensitivity };
