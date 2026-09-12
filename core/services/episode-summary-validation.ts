/**
 * L1-T03 Pass2 deterministic post-validators V0–V13 (03R2 §3.3). PURE: no DB,
 * filesystem, model, port, log, clock, or env — only the parsed model output
 * plus this episode's synthetic original text (the V6/V8/V12 whitelist touch,
 * §3.2) and injected bundle/metadata. Validators NEVER mutate their input;
 * soft transforms return NEW objects. Issues carry only a stable code, a field
 * path, and counts — NEVER original text, a hit word, the raw model output, or
 * an exception message. Issues are ordered by (validatorId, fieldPath,
 * stableCode). hard fail / soft prune / warn / annotate follow §3.3 exactly.
 *
 * This module does NOT build the candidate payload and does NOT reuse or
 * duplicate the T01 payload validator — final candidate validation is the T01
 * validator, wired by the P5 orchestrator (a later step).
 */

import { localParts } from "./time-labels.js";
import { DOMAIN_SUGGESTIONS } from "./episode-summary-input.js";
import { CLAIM_KINDS, isSensitivity, MODEL_UNCERTAIN_FLAGS, maxSensitivity, type Domain, type Sensitivity } from "../domain/episode.js";
import type {
  ChunkModelOutput,
  EpisodeModelOutput,
  EpisodeMetaHeader,
  ModelClaim,
  ModelTemporalHint,
  SummaryBundle,
  TemporalNormalizerRule,
  ValidatorIssue,
} from "../domain/episode-pass2.js";

// ---------------------------------------------------------------------------
// Parse + context
// ---------------------------------------------------------------------------

export type ParseResult = { ok: true; value: unknown } | { ok: false; code: "malformed_output" };

/** Strict JSON parse of raw model output. Never leaks the raw text or the exception. */
export function parseModelJson(raw: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, code: "malformed_output" };
  }
}

export interface ValidatorContext {
  kind: "episode" | "chunk" | "assembly";
  header: EpisodeMetaHeader;
  /** bare message_ids that are legal evidence for this episode / block. */
  memberIds: ReadonlySet<string>;
  /**
   * V8 entity-whitelist base (closure-review A): the text ACTUALLY VISIBLE in
   * this validation unit — for a chunk, only the chunk's own units' content; for
   * episode/assembly, the whole member text. An entity must appear in what the
   * model was shown.
   */
  visibleText: ReadonlyMap<string, string>;
  /**
   * V6 + V12 base (closure-review A): the WHOLE message `contentNfc` for each
   * bare message this unit touches — NEVER a chunk-local fragment. 03R2 §3.3 V12
   * fixes the hint-substring base to the whole message; slices are only an input
   * presentation unit. This is separate from `visibleText` on purpose.
   */
  fullMessageText: ReadonlyMap<string, string>;
  /** message_id → archive UTC timestamp (V12 relative-time recompute). */
  memberTimestamps: ReadonlyMap<string, string>;
  /** message_id → its REAL deterministic slice ordinal set (V12 slice-suffix check;
   *  the whole message's slice set even for chunk kind, per 03R2 V12). */
  sliceOrdinals: ReadonlyMap<string, ReadonlySet<number>>;
  /**
   * Chunk kind ONLY (G1A Erratum 1): the EXACT evidence refs the current chunk
   * owns — a whole message contributes its bare id, a slice contributes
   * `message_id#slice_<n>`. V11's chunk variant accepts nothing outside this
   * set, so a bare id cannot stand in for a sliced message and another chunk's
   * ordinal is illegal here. null for episode/assembly.
   */
  legalRefs: ReadonlySet<string> | null;
  /** metadata label strings an entity may match (V8 whitelist). */
  metadataLabels: readonly string[];
  bundle: SummaryBundle;
  /** override-replayed effective Pass1 domain (V10). */
  pass1Domain: Domain;
  /** assembly-only: union of evidence ids across the validated chunk claims (V11 assembly variant). */
  assemblyEvidenceUnion: ReadonlySet<string> | null;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const isString = (v: unknown): v is string => typeof v === "string";
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const codePoints = (s: string): number => [...s].length;

const issue = (validatorId: string, fieldPath: string, stableCode: string, severity: ValidatorIssue["severity"]): ValidatorIssue => ({
  validatorId,
  fieldPath,
  stableCode,
  severity,
});

/** Order: validator number, then field path, then stable code (§ requirement 3). */
export function sortIssues(issues: readonly ValidatorIssue[]): ValidatorIssue[] {
  return [...issues].sort((a, b) => {
    const na = Number(a.validatorId.slice(1));
    const nb = Number(b.validatorId.slice(1));
    if (na !== nb) return na - nb;
    if (a.fieldPath !== b.fieldPath) return a.fieldPath < b.fieldPath ? -1 : 1;
    return a.stableCode < b.stableCode ? -1 : a.stableCode > b.stableCode ? 1 : 0;
  });
}

/** Strip an optional `#slice_<n>` suffix; returns [bareId, ordinal|null]. */
function splitSliceRef(ref: string): { bare: string; ordinal: number | null } {
  const m = /^(.*)#slice_(\d+)$/.exec(ref);
  if (m === null) return { bare: ref, ordinal: null };
  return { bare: m[1]!, ordinal: Number(m[2]) };
}

/** Count sentence terminators (。！？.!?), ellipsis counting as one. */
function countSentences(text: string): number {
  const norm = text.replace(/…+/g, "。").replace(/\.{2,}/g, "。");
  const m = norm.match(/[。！？.!?]/g);
  return m ? m.length : 0;
}

/** Does `text` contain the folded needle as a plain substring (V-scan use). */
function contains(text: string, needle: string): boolean {
  return needle.length > 0 && text.includes(needle);
}

// ---------------------------------------------------------------------------
// V0 — strict schema (◆ block variant). If V0 fails the shape is untrustworthy.
// ---------------------------------------------------------------------------

const EPISODE_KEYS = new Set(["title", "summary", "claims", "entities", "temporal_hints", "domain_suggestion", "sensitivity", "confidence", "uncertain_flags"]);
const CHUNK_KEYS = new Set(["claims", "entities", "temporal_hints", "confidence", "uncertain_flags"]);

function checkClaimShape(c: unknown, path: string, issues: ValidatorIssue[]): void {
  if (typeof c !== "object" || c === null || Array.isArray(c)) {
    issues.push(issue("V0", path, "claim_not_object", "hard"));
    return;
  }
  const o = c as Record<string, unknown>;
  const keys = Object.keys(o);
  // P7 major fix: a model-output key name is raw model output — never echo it
  // into a ValidatorIssue. A stable placeholder path is used instead.
  for (const k of keys) if (!["text", "kind", "evidence_message_ids"].includes(k)) issues.push(issue("V0", `${path}.<unknown>`, "unknown_field", "hard"));
  if (!isString(o["text"])) issues.push(issue("V0", `${path}.text`, "type_error", "hard"));
  if (!isString(o["kind"]) || !CLAIM_KINDS.includes(o["kind"] as (typeof CLAIM_KINDS)[number])) issues.push(issue("V0", `${path}.kind`, "illegal_enum", "hard"));
  if (!Array.isArray(o["evidence_message_ids"]) || !o["evidence_message_ids"].every(isString)) issues.push(issue("V0", `${path}.evidence_message_ids`, "type_error", "hard"));
}

function checkHintShape(h: unknown, path: string, issues: ValidatorIssue[]): void {
  if (typeof h !== "object" || h === null || Array.isArray(h)) {
    issues.push(issue("V0", path, "hint_not_object", "hard"));
    return;
  }
  const o = h as Record<string, unknown>;
  // P7 major fix: never echo a model-supplied key name (raw model output).
  for (const k of Object.keys(o)) if (!["text", "message_id", "normalized_range", "confidence"].includes(k)) issues.push(issue("V0", `${path}.<unknown>`, "unknown_field", "hard"));
  if (!isString(o["text"])) issues.push(issue("V0", `${path}.text`, "type_error", "hard"));
  if (!isString(o["message_id"])) issues.push(issue("V0", `${path}.message_id`, "type_error", "hard"));
  if (!(o["normalized_range"] === null || isString(o["normalized_range"]))) issues.push(issue("V0", `${path}.normalized_range`, "type_error", "hard"));
  if (!isFiniteNum(o["confidence"])) issues.push(issue("V0", `${path}.confidence`, "type_error", "hard"));
  // G1A Erratum 4B: a finite hint confidence must lie in [0,1]
  else if ((o["confidence"] as number) < 0 || (o["confidence"] as number) > 1) issues.push(issue("V0", `${path}.confidence`, "out_of_range", "hard"));
}

export function v0Schema(value: unknown, ctx: ValidatorContext): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [issue("V0", "$", "not_object", "hard")];
  const o = value as Record<string, unknown>;
  const allowed = ctx.kind === "chunk" ? CHUNK_KEYS : EPISODE_KEYS;
  // P7 major fix: an unknown top-level key (provenance / extras land here) is
  // raw model output — report a stable placeholder path, never the key itself.
  for (const k of Object.keys(o)) if (!allowed.has(k)) issues.push(issue("V0", "$.<unknown>", "unknown_field", "hard"));
  for (const k of allowed) if (!(k in o)) issues.push(issue("V0", k, "missing_field", "hard"));

  if (ctx.kind !== "chunk") {
    if ("title" in o && !isString(o["title"])) issues.push(issue("V0", "title", "type_error", "hard"));
    if ("summary" in o && !isString(o["summary"])) issues.push(issue("V0", "summary", "type_error", "hard"));
    if ("domain_suggestion" in o && !(o["domain_suggestion"] === null || isString(o["domain_suggestion"]))) issues.push(issue("V0", "domain_suggestion", "type_error", "hard"));
    // G1A Erratum 4B: the enum is enforced at V0 from the SHARED constant
    // (seven domains + conflict) — an unknown domain never reaches downstream.
    else if (isString(o["domain_suggestion"]) && !DOMAIN_SUGGESTIONS.includes(o["domain_suggestion"])) issues.push(issue("V0", "domain_suggestion", "illegal_enum", "hard"));
    if ("sensitivity" in o && !(isString(o["sensitivity"]) && isSensitivity(o["sensitivity"]))) issues.push(issue("V0", "sensitivity", "illegal_enum", "hard"));
  }
  if ("confidence" in o && !(o["confidence"] === null || isFiniteNum(o["confidence"]))) issues.push(issue("V0", "confidence", "type_error", "hard"));
  // G1A Erratum 4B: a finite model confidence must lie in [0,1] — enforced at V0
  // for BOTH the episode/assembly and the chunk variant (a chunk confidence
  // would otherwise reach assembly before any payload_schema check).
  else if ("confidence" in o && isFiniteNum(o["confidence"]) && ((o["confidence"] as number) < 0 || (o["confidence"] as number) > 1)) issues.push(issue("V0", "confidence", "out_of_range", "hard"));
  if ("entities" in o && !(Array.isArray(o["entities"]) && o["entities"].every(isString))) issues.push(issue("V0", "entities", "type_error", "hard"));
  if ("uncertain_flags" in o) {
    const f = o["uncertain_flags"];
    if (!Array.isArray(f) || !f.every(isString)) issues.push(issue("V0", "uncertain_flags", "type_error", "hard"));
    else for (let i = 0; i < f.length; i += 1) if (!MODEL_UNCERTAIN_FLAGS.includes(f[i] as (typeof MODEL_UNCERTAIN_FLAGS)[number])) issues.push(issue("V0", `uncertain_flags[${i}]`, "illegal_flag", "hard"));
  }
  if ("claims" in o) {
    if (!Array.isArray(o["claims"])) issues.push(issue("V0", "claims", "type_error", "hard"));
    else o["claims"].forEach((c, i) => checkClaimShape(c, `claims[${i}]`, issues));
  }
  if ("temporal_hints" in o) {
    if (!Array.isArray(o["temporal_hints"])) issues.push(issue("V0", "temporal_hints", "type_error", "hard"));
    else o["temporal_hints"].forEach((h, i) => checkHintShape(h, `temporal_hints[${i}]`, issues));
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Text-scanning validators (V1/V5/V13) operate on title+summary+claims
// ---------------------------------------------------------------------------

/** V1 — forbid 用户/助手 (and word-boundary user/assistant). */
export function v1Persona(out: EpisodeModelOutput | ChunkModelOutput, ctx: ValidatorContext): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const cjk = ["用户", "助手"];
  const en = /\b(user|assistant)\b/i;
  const scan = (text: string, path: string): void => {
    if (cjk.some((w) => contains(text, w)) || en.test(text)) issues.push(issue("V1", path, "persona_token", "hard"));
  };
  if (ctx.kind !== "chunk") {
    const e = out as EpisodeModelOutput;
    scan(e.title, "title");
    scan(e.summary, "summary");
  }
  out.claims.forEach((c, i) => scan(c.text, `claims[${i}].text`));
  return issues;
}

/** V5 — prediction-wording blacklist scan on title+summary+claims. */
export function v5Prediction(out: EpisodeModelOutput | ChunkModelOutput, ctx: ValidatorContext): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const hit = (text: string): boolean => ctx.bundle.predictionBlacklist.some((w) => contains(text, w));
  if (ctx.kind !== "chunk") {
    const e = out as EpisodeModelOutput;
    if (hit(e.title)) issues.push(issue("V5", "title", "prediction_wording", "hard"));
    if (hit(e.summary)) issues.push(issue("V5", "summary", "prediction_wording", "hard"));
  }
  out.claims.forEach((c, i) => {
    if (hit(c.text)) issues.push(issue("V5", `claims[${i}].text`, "prediction_wording", "hard"));
  });
  return issues;
}

/** V13 — relative-time words are forbidden in summary body (episode/assembly). */
export function v13SummaryRelativeTime(out: EpisodeModelOutput, ctx: ValidatorContext): ValidatorIssue[] {
  const hit = ctx.bundle.temporalHintLexicon.some((t) => contains(out.summary, t.term));
  return hit ? [issue("V13", "summary", "relative_time_in_summary", "hard")] : [];
}

// ---------------------------------------------------------------------------
// Summary structure (V2/V3/V4) — episode/assembly only
// ---------------------------------------------------------------------------

function afterTimePrefix(summary: string, timeString: string): string | null {
  return summary.startsWith(timeString) ? summary.slice(timeString.length) : null;
}

/** V3 — summary must byte-start with the metadata time string. */
export function v3AbsoluteTime(out: EpisodeModelOutput, ctx: ValidatorContext): ValidatorIssue[] {
  return afterTimePrefix(out.summary, ctx.header.timeString) === null ? [issue("V3", "summary", "missing_time_prefix", "hard")] : [];
}

/** V2 — after stripping time prefix + realm sentence, the body has 2–3 sentences. */
export function v2SentenceCount(out: EpisodeModelOutput, ctx: ValidatorContext): ValidatorIssue[] {
  const after = afterTimePrefix(out.summary, ctx.header.timeString);
  if (after === null) return []; // V3 already reports the missing prefix
  const dot = after.indexOf("。");
  if (dot < 0) return [issue("V2", "summary", "no_realm_sentence", "hard")];
  const body = after.slice(dot + 1);
  const n = countSentences(body);
  // G2 ruling 0c5028e8 §3 (narrow T03 erratum): the floor moves 2 -> 1 so a
  // genuinely single-fact episode can be stated in ONE honest sentence
  // instead of being padded with meta-commentary about the transcript.
  // Boundary constants only — no other V2 behaviour changes.
  return n >= 1 && n <= 3 ? [] : [issue("V2", "summary", "sentence_count_out_of_range", "hard")];
}

/** V4 — the realm sentence must carry the realm display word; uncertain has extra rules. */
export function v4RealmAnnotation(out: EpisodeModelOutput, ctx: ValidatorContext): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const after = afterTimePrefix(out.summary, ctx.header.timeString);
  if (after === null) return [];
  const dot = after.indexOf("。");
  const realmSentence = dot < 0 ? after : after.slice(0, dot);
  if (!contains(realmSentence, ctx.header.realmDisplay)) issues.push(issue("V4", "summary", "missing_realm_display", "hard"));
  if (ctx.header.realm === "uncertain") {
    if (!out.uncertain_flags.includes("scope")) issues.push(issue("V4", "uncertain_flags", "missing_scope_flag", "hard"));
    // G1A Erratum 5 + closure-review B: an uncertain summary must not carry ANY
    // AU marker. The scan base is the SAME single canonical `au_id → label`
    // mapping used for display resolution — both a key (au_id) and its value
    // (display label) count as markers. (An uncertain row's own au_id is always
    // null, so header.auId can never be the scan source.)
    for (const [auId, label] of Object.entries(ctx.bundle.auDisplayById)) {
      if (contains(out.summary, auId) || contains(out.summary, label)) {
        issues.push(issue("V4", "summary", "au_label_in_uncertain", "hard"));
        break;
      }
    }
  }
  return issues;
}

/** V9 — model title non-empty, ≤20 code points, and passes V1/V5 (episode/assembly). */
export function v9Title(out: EpisodeModelOutput, ctx: ValidatorContext): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  if (out.title.length === 0) issues.push(issue("V9", "title", "empty_title", "hard"));
  if (codePoints(out.title) > 20) issues.push(issue("V9", "title", "title_too_long", "hard"));
  const cjk = ["用户", "助手"];
  if (cjk.some((w) => contains(out.title, w)) || /\b(user|assistant)\b/i.test(out.title)) issues.push(issue("V9", "title", "persona_token", "hard"));
  if (ctx.bundle.predictionBlacklist.some((w) => contains(out.title, w))) issues.push(issue("V9", "title", "prediction_wording", "hard"));
  return issues;
}

// ---------------------------------------------------------------------------
// V6 sensitivity (hard) + effective value
// ---------------------------------------------------------------------------

/** True iff the sensitivity lexicon hits ANY member's WHOLE original text (V6). */
export function lexiconIntimate(ctx: ValidatorContext): boolean {
  for (const text of ctx.fullMessageText.values()) {
    if (ctx.bundle.sensitivityLexicon.some((w) => contains(text, w))) return true;
  }
  return false;
}

/** V6 — from-strict intimate: a lexicon hit REQUIRES sensitivity=intimate (episode/assembly). */
export function v6Sensitivity(out: EpisodeModelOutput, ctx: ValidatorContext): ValidatorIssue[] {
  return lexiconIntimate(ctx) && out.sensitivity !== "intimate" ? [issue("V6", "sensitivity", "sensitivity_underclassified", "hard")] : [];
}

/** Effective sensitivity for the candidate = max(model, lexicon) — from strict, never down. */
export function effectiveSensitivity(out: EpisodeModelOutput, ctx: ValidatorContext): Sensitivity {
  const model: Sensitivity = isSensitivity(out.sensitivity) ? out.sensitivity : "normal";
  return maxSensitivity(model, lexiconIntimate(ctx) ? "intimate" : "normal");
}

// ---------------------------------------------------------------------------
// V11 claims evidence (hard, ◆)
// ---------------------------------------------------------------------------

export function v11ClaimsEvidence(out: EpisodeModelOutput | ChunkModelOutput, ctx: ValidatorContext): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  if (out.claims.length === 0) return [issue("V11", "claims", "claims_empty", "hard")];
  out.claims.forEach((c, i) => {
    if (c.evidence_message_ids.length === 0) {
      issues.push(issue("V11", `claims[${i}].evidence_message_ids`, "evidence_empty", "hard"));
      return;
    }
    c.evidence_message_ids.forEach((ref, j) => {
      const { bare, ordinal } = splitSliceRef(ref);
      const path = `claims[${i}].evidence_message_ids[${j}]`;
      if (ctx.kind === "assembly") {
        if (ctx.assemblyEvidenceUnion === null || !ctx.assemblyEvidenceUnion.has(ref)) issues.push(issue("V11", path, "evidence_not_in_chunk_union", "hard"));
        return;
      }
      if (ctx.kind === "chunk") {
        // G1A Erratum 1: exact-ref boundary — only a ref the CURRENT chunk
        // actually owns is legal evidence here. A bare id for a message this
        // chunk holds as slices, and another chunk's (globally valid) ordinal,
        // both fail; only this chunk's own refs pass into the assembly union.
        if (ctx.legalRefs !== null && ctx.legalRefs.has(ref)) return;
        issues.push(issue("V11", path, ctx.memberIds.has(bare) ? "evidence_bad_slice" : "evidence_not_member", "hard"));
        return;
      }
      if (!ctx.memberIds.has(bare)) issues.push(issue("V11", path, "evidence_not_member", "hard"));
      else if (ordinal !== null && !(ctx.sliceOrdinals.get(bare)?.has(ordinal) ?? false)) issues.push(issue("V11", path, "evidence_bad_slice", "hard"));
    });
  });
  return issues;
}

// ---------------------------------------------------------------------------
// V8 entities whitelist (soft prune, ◆) — returns kept entities + pruned count
// ---------------------------------------------------------------------------

export interface EntityPrune {
  kept: string[];
  issues: ValidatorIssue[];
}

export function v8Entities(out: EpisodeModelOutput | ChunkModelOutput, ctx: ValidatorContext): EntityPrune {
  const issues: ValidatorIssue[] = [];
  // closure-review A: V8's whitelist is the VISIBLE text (chunk-local for a
  // chunk) plus metadata labels — an entity must be in what the model was shown.
  const originals = [...ctx.visibleText.values(), ...ctx.metadataLabels];
  const isRelTime = (e: string): boolean => ctx.bundle.temporalHintLexicon.some((t) => contains(e, t.term));
  const kept: string[] = [];
  out.entities.forEach((e, i) => {
    if (isRelTime(e)) {
      issues.push(issue("V8", `entities[${i}]`, "relative_time_entity_pruned", "soft"));
      return;
    }
    if (!originals.some((src) => contains(src, e))) {
      issues.push(issue("V8", `entities[${i}]`, "entity_not_in_source_pruned", "soft"));
      return;
    }
    kept.push(e);
  });
  return { kept, issues };
}

// ---------------------------------------------------------------------------
// V12 temporal_hints (soft prune / warn, ◆) — R1 typed rewrite: the model NEVER
// computes calendar ranges. A recognized hint's range is machine-derived from
// its typed asset rule + the evidence message's archive timestamp, fixed
// Asia/Shanghai; a model-provided non-null string is structurally discarded
// (never parsed, never compared, never repaired) with a content-free warn.
// ---------------------------------------------------------------------------

/** Frozen archive-range grammar (self-check on MACHINE output only; model strings are never inspected). */
const ARCHIVE_RANGE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} – \d{4}-\d{2}-\d{2} \d{2}:\d{2} \+08:00$/;

const DAY_MS = 86400000;
const pad2 = (n: number): string => String(n).padStart(2, "0");
const minuteToHHmm = (min: number): string => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

/**
 * Local +08 calendar date of an archive UTC instant, or null on invalid input.
 * R1 §4.4 hardening (P3.5 finding M1): an offset-less ISO string would fall
 * into the ES local-time parse fallback — a hidden host-timezone dependence —
 * so an explicit UTC designator or numeric offset is REQUIRED; anything else
 * fails closed to null (→ the existing `hint_normalize_failed_pruned` path).
 */
function localDateOf(timestampUtc: string): string | null {
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(timestampUtc)) return null;
  const p = localParts(timestampUtc);
  return p === null ? null : p.localDate;
}

/** Shift a "YYYY-MM-DD" date by whole days via UTC-ms integer math (no local TZ, no locale). */
function shiftDate(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Monday-based weekday index (Mon=0 … Sun=6) of a "YYYY-MM-DD" date. */
function weekdayMonday0(localDate: string): number {
  return (new Date(Date.parse(`${localDate}T00:00:00Z`)).getUTCDay() + 6) % 7;
}

const isLeap = (y: number): boolean => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysInMonth = (y: number, m: number): number =>
  m === 2 ? (isLeap(y) ? 29 : 28) : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

/**
 * R1 §4.4/§4.5 — the ONLY calendar interpreter. Pure integer math over the
 * typed rule + the message's archive UTC timestamp; fixed +08:00; inclusive
 * endpoints; minute precision; EN DASH with single spaces; single trailing
 * offset. Term semantics live ONLY in the hashed asset rule — this function is
 * a generic interpreter and contains no per-term knowledge.
 */
export function computeNormalizedRange(rule: TemporalNormalizerRule, timestampUtc: string): string | null {
  const anchor = localDateOf(timestampUtc);
  if (anchor === null) return null;
  let out: string;
  if (rule.kind === "day") {
    const d = shiftDate(anchor, rule.offset_days);
    out = `${d} ${minuteToHHmm(rule.start_minute)} – ${d} ${minuteToHHmm(rule.end_minute)} +08:00`;
  } else if (rule.kind === "week") {
    const monday = shiftDate(anchor, -weekdayMonday0(anchor) + rule.offset_weeks * 7);
    out = `${monday} 00:00 – ${shiftDate(monday, 6)} 23:59 +08:00`;
  } else if (rule.kind === "month") {
    const y0 = Number(anchor.slice(0, 4));
    const m0 = Number(anchor.slice(5, 7)) - 1 + rule.offset_months;
    const y = y0 + Math.floor(m0 / 12);
    const m = ((m0 % 12) + 12) % 12 + 1;
    out = `${y}-${pad2(m)}-01 00:00 – ${y}-${pad2(m)}-${pad2(daysInMonth(y, m))} 23:59 +08:00`;
  } else {
    const y = Number(anchor.slice(0, 4)) + rule.offset_years;
    out = `${y}-01-01 00:00 – ${y}-12-31 23:59 +08:00`;
  }
  return ARCHIVE_RANGE.test(out) ? out : null;
}

/**
 * Longest-match-first source scan (R1 §4.3): terms ordered by code-point
 * length desc, then code-point lexical asc; at any position only the longest
 * term matches and consumes its span, so a four-char term never also yields
 * its own two-char prefix. Generic over whatever terms the asset provides.
 */
export function scanSourceTerms(text: string, terms: readonly string[]): ReadonlySet<string> {
  // P3.5 minor: CODE-POINT length per R1 §4.3 (tie-break stays code-unit
  // lexical — byte-identical for the frozen all-BMP asset, noted in review).
  const ordered = [...terms].sort((a, b) => ([...b].length - [...a].length) || (a < b ? -1 : a > b ? 1 : 0));
  const found = new Set<string>();
  for (let i = 0; i < text.length; ) {
    const hit = ordered.find((t) => text.startsWith(t, i));
    if (hit === undefined) { i += 1; continue; }
    found.add(hit);
    i += hit.length;
  }
  return found;
}

export interface HintPrune {
  kept: ModelTemporalHint[];
  issues: ValidatorIssue[];
}

export function v12TemporalHints(out: EpisodeModelOutput | ChunkModelOutput, ctx: ValidatorContext): HintPrune {
  const issues: ValidatorIssue[] = [];
  const kept: ModelTemporalHint[] = [];
  out.temporal_hints.forEach((h, i) => {
    const path = `temporal_hints[${i}]`;
    const { bare, ordinal } = splitSliceRef(h.message_id);
    if (!ctx.memberIds.has(bare)) {
      issues.push(issue("V12", path, "hint_not_member_pruned", "soft"));
      return;
    }
    if (ordinal !== null && !(ctx.sliceOrdinals.get(bare)?.has(ordinal) ?? false)) {
      issues.push(issue("V12", path, "hint_bad_slice_pruned", "soft"));
      return;
    }
    // closure-review A: the hint-text substring base is the WHOLE message
    // (03R2 §3.3 V12), never the chunk-local visible fragment.
    const text = ctx.fullMessageText.get(bare) ?? "";
    if (!contains(text, h.text)) {
      issues.push(issue("V12", path, "hint_text_not_substring_pruned", "soft"));
      return;
    }
    // R1 §4.3 — a hint's text must EXACTLY equal a registered C9 term; no fuzzy
    // matching, no alias guessing, no substring classing.
    const entry = ctx.bundle.temporalHintLexicon.find((t) => t.term === h.text);
    if (entry === undefined) {
      issues.push(issue("V12", path, "hint_term_unregistered_pruned", "soft"));
      return;
    }
    // R1 §4.6 — `normalized_range` is a PIPELINE-DERIVED field from this
    // version on. A model-provided non-null string is discarded structurally:
    // never parsed, never grammar-checked, never compared to the machine value.
    if (h.normalized_range !== null) {
      issues.push(issue("V12", path, "model_range_discarded_warn", "annotate"));
    }
    if (entry.normalizer !== null) {
      const range = computeNormalizedRange(entry.normalizer, ctx.memberTimestamps.get(bare) ?? "");
      if (range === null) {
        issues.push(issue("V12", path, "hint_normalize_failed_pruned", "soft"));
        return;
      }
      kept.push({ text: h.text, message_id: h.message_id, normalized_range: range, confidence: 1.0 });
    } else {
      // A null-rule term keeps an honest internal null (§ Erratum B). The
      // candidate builder omits null-range hints from the T01 payload (T01
      // requires a non-empty range); emit a warn so the deterministic omission
      // stays observable — stable code/field/count only, never the hint text.
      issues.push(issue("V12", path, "hint_unresolved_range_warn", "annotate"));
      kept.push({ text: h.text, message_id: h.message_id, normalized_range: null, confidence: h.confidence });
    }
  });
  // warn: an input-side term present in the WHOLE message text but not recorded
  // in any hint (no fail). Longest-match-first scan (R1 §4.3): a longer term
  // in the source never also reports its unrecorded shorter prefix.
  const recorded = new Set(out.temporal_hints.map((h) => h.text));
  const present = new Set<string>();
  for (const txt of ctx.fullMessageText.values()) {
    for (const term of scanSourceTerms(txt, ctx.bundle.temporalHintLexicon.map((t) => t.term))) present.add(term);
  }
  for (const term of [...present].sort()) {
    if (!recorded.has(term)) issues.push(issue("V12", "temporal_hints", "hint_not_recorded_warn", "annotate"));
  }
  return { kept, issues };
}

// ---------------------------------------------------------------------------
// V7 confidence cap (transform) + V10 domain suggestion (annotate)
// ---------------------------------------------------------------------------

/** V7 — uncertain_flags non-empty → summary_confidence = min(model, 0.5). */
export function v7ConfidenceCap(out: EpisodeModelOutput): { confidence: number | null; issues: ValidatorIssue[] } {
  if (out.uncertain_flags.length === 0) return { confidence: out.confidence, issues: [] };
  const capped = out.confidence === null ? null : Math.min(out.confidence, 0.5);
  const changed = capped !== out.confidence;
  return { confidence: capped, issues: changed ? [issue("V7", "summary_confidence", "confidence_capped", "annotate")] : [] };
}

/** V10 — domain_suggestion ≠ effective Pass1 domain → append type_mismatch (only appendable flag). */
export function v10DomainSuggestion(out: EpisodeModelOutput, ctx: ValidatorContext): { flags: string[]; issues: ValidatorIssue[] } {
  const mismatch = out.domain_suggestion !== null && out.domain_suggestion !== ctx.pass1Domain;
  if (!mismatch) return { flags: [...out.uncertain_flags], issues: [] };
  const flags = out.uncertain_flags.includes("type_mismatch") ? [...out.uncertain_flags] : [...out.uncertain_flags, "type_mismatch"];
  return { flags, issues: [issue("V10", "domain_suggestion", "domain_suggestion_mismatch", "annotate")] };
}

// ---------------------------------------------------------------------------
// Orchestration of the validators (still pure; no candidate build, no T01 call)
// ---------------------------------------------------------------------------

export interface RunDiagnostics {
  prunedEntities: number;
  prunedHints: number;
  warns: number;
  appendedFlags: string[];
}

export type ValidationRun =
  | { verdict: "hard_fail"; firstHardValidatorId: string; issues: ValidatorIssue[]; diagnostics: RunDiagnostics }
  | {
      verdict: "pass";
      issues: ValidatorIssue[];
      output: EpisodeModelOutput | ChunkModelOutput;
      effectiveSensitivity: Sensitivity | null;
      diagnostics: RunDiagnostics;
    };

const EMPTY_DIAG: RunDiagnostics = { prunedEntities: 0, prunedHints: 0, warns: 0, appendedFlags: [] };

function firstHard(issues: readonly ValidatorIssue[]): string | null {
  const hard = issues.filter((i) => i.severity === "hard");
  if (hard.length === 0) return null;
  return sortIssues(hard)[0]!.validatorId;
}

/**
 * Run the applicable validators for `ctx.kind` over a PARSED model output.
 * Pure: returns sorted issues, and on pass a NEW transformed output (input
 * never mutated). Chunk variant runs V0◆/V1/V5/V8◆/V11◆/V12◆; episode/assembly
 * run the full V0–V13 with the V11 assembly variant.
 */
export function runValidators(parsed: unknown, ctx: ValidatorContext): ValidationRun {
  // V0 first: a bad shape cannot be trusted by any downstream validator.
  const v0 = v0Schema(parsed, ctx);
  if (v0.length > 0) return { verdict: "hard_fail", firstHardValidatorId: "V0", issues: sortIssues(v0), diagnostics: EMPTY_DIAG };

  const isEpisode = ctx.kind !== "chunk";
  const out = parsed as EpisodeModelOutput & ChunkModelOutput;
  const allIssues: ValidatorIssue[] = [];

  // hard checks
  allIssues.push(...v1Persona(out, ctx), ...v5Prediction(out, ctx), ...v11ClaimsEvidence(out, ctx));
  if (isEpisode) {
    allIssues.push(...v3AbsoluteTime(out, ctx), ...v2SentenceCount(out, ctx), ...v4RealmAnnotation(out, ctx), ...v6Sensitivity(out, ctx), ...v9Title(out, ctx), ...v13SummaryRelativeTime(out, ctx));
  }

  // soft prunes (V8/V12) — issues + kept transforms
  const entityPrune = v8Entities(out, ctx);
  const hintPrune = v12TemporalHints(out, ctx);
  allIssues.push(...entityPrune.issues, ...hintPrune.issues);

  // annotate transforms (V7/V10) — computed regardless of hard failure so the
  // issue set is complete (a hard fail still reports its soft/annotate context).
  let confidence = out.confidence;
  let flags = [...out.uncertain_flags];
  let effSens: Sensitivity | null = null;
  if (isEpisode) {
    const v7 = v7ConfidenceCap(out);
    confidence = v7.confidence;
    allIssues.push(...v7.issues);
    const v10 = v10DomainSuggestion(out, ctx);
    flags = v10.flags;
    allIssues.push(...v10.issues);
    effSens = effectiveSensitivity(out, ctx);
  }

  const sorted = sortIssues(allIssues);
  const appended = flags.filter((f) => !out.uncertain_flags.includes(f));
  const diagnostics: RunDiagnostics = {
    prunedEntities: out.entities.length - entityPrune.kept.length,
    prunedHints: out.temporal_hints.length - hintPrune.kept.length,
    warns: allIssues.filter((i) => i.stableCode.endsWith("_warn")).length,
    appendedFlags: appended,
  };

  const hardId = firstHard(allIssues);
  if (hardId !== null) return { verdict: "hard_fail", firstHardValidatorId: hardId, issues: sorted, diagnostics };

  const transformed: EpisodeModelOutput | ChunkModelOutput = isEpisode
    ? {
        title: out.title,
        summary: out.summary,
        claims: out.claims.map((c) => ({ ...c, evidence_message_ids: [...c.evidence_message_ids] })),
        entities: entityPrune.kept,
        temporal_hints: hintPrune.kept,
        domain_suggestion: out.domain_suggestion,
        sensitivity: effSens ?? out.sensitivity,
        confidence,
        uncertain_flags: flags,
      }
    : {
        claims: out.claims.map((c) => ({ ...c, evidence_message_ids: [...c.evidence_message_ids] })),
        entities: entityPrune.kept,
        temporal_hints: hintPrune.kept,
        confidence,
        uncertain_flags: flags,
      };

  return { verdict: "pass", issues: sorted, output: transformed, effectiveSensitivity: effSens, diagnostics };
}
