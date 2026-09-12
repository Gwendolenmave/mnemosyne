/**
 * L1-T03 Pass2 input construction (§3.2.1 / §6). Pure and deterministic. Builds
 * the three-kind structured calls and renders each to a prompt string for the
 * summarizer port. The metadata header comes only from the Pass1 row; message
 * lines come only from THIS episode's ordered members. The assembly input
 * carries validated chunk-summary JSON and NEVER any original text — a property
 * the SummaryCall type also enforces structurally (§6.2).
 *
 * Time is rendered ONLY through core/services/time-labels.ts (+08, never naive
 * UTC). Role words map at this layer (owner→Owner, companion→Companion, proactive→
 * "Companion(主动消息)") so the model never sees user/assistant tokens (V1 at source).
 */

import { localParts } from "./time-labels.js";
import { canonicalJson } from "../domain/episode-pass1.js";
import type { Pass1Episode, Pass1Message } from "../domain/episode-pass1.js";
import { DOMAINS } from "../domain/episode.js";
import type {
  ChunkModelOutput,
  EpisodeMetaHeader,
  RenderedUnit,
  SummaryBundle,
  SummaryCall,
} from "../domain/episode-pass2.js";

/** The domain suggestion enum table shown to the model: the seven domains + `conflict` (§3.2.1). */
export const DOMAIN_SUGGESTIONS: readonly string[] = [...DOMAINS, "conflict"];

/**
 * realm display word (§2.5 / §3.2.1 map, closure-review B): reality→现实,
 * uncertain→层面未定, au→the display label resolved through the bundle's SINGLE
 * `au_id → display label` mapping. realm=au returns null (unresolvable) when the
 * au_id is absent, empty, or maps to an empty label — the caller fails closed
 * before any render/port. The auId is NEVER used directly as a display word.
 */
export function realmDisplayWord(realm: string, auId: string | null, auDisplayById: Readonly<Record<string, string>>): string | null {
  if (realm === "reality") return "现实";
  if (realm === "uncertain") return "层面未定";
  // realm === "au": resolve through the one canonical mapping
  if (auId === null || auId.length === 0) return null;
  const label = auDisplayById[auId];
  return typeof label === "string" && label.length > 0 ? label : null;
}

/**
 * The SINGLE runtime validity gate for the whole `auDisplayById` mapping
 * (closure-02-review B). PURE and it NEVER throws on any runtime `unknown` (a
 * throwing proxy / getter is caught and rejected). The orchestrator runs it
 * before any bundle hash, header render, plan, or port. Rejects: a missing /
 * null / array / primitive value; any own key that is empty or whitespace-only;
 * any value that is not a string, or is empty / whitespace-only. An empty object
 * is a structurally-valid mapping (it simply resolves no AU — no hidden default).
 * "Whole table invalid" is distinct from "this row's au_id does not resolve"
 * (the latter stays `au_display_unresolved`, decided later by buildMetaHeader).
 */
export function validateAuDisplayMapping(mapping: unknown): boolean {
  try {
    if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) return false;
    for (const [k, v] of Object.entries(mapping as Record<string, unknown>)) {
      if (typeof k !== "string" || k.trim().length === 0) return false;
      if (typeof v !== "string" || v.trim().length === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Runtime validity gate for the whole `fewShots` list (G1-B Bundle-02-review
 * Closure A). PURE and it NEVER throws on any runtime `unknown` (a throwing
 * proxy/getter is caught → false). The orchestrator runs it before any plan or
 * port call, so a missing / non-array / empty / non-string / blank-string /
 * malformed `fewShots` fails closed with a stable non-content code and no
 * example bytes ever reach a prompt, a port, or evidence. A valid list is a
 * non-empty array of non-blank strings; the renderer injects it verbatim
 * (episode + assembly) without mutation.
 */
export function validateFewShots(fewShots: unknown): boolean {
  try {
    if (!Array.isArray(fewShots) || fewShots.length === 0) return false;
    for (const s of fewShots) {
      if (typeof s !== "string" || s.trim().length === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Canonical +08 stamp for an archive UTC-Z instant (via time-labels; never naive). */
function shanghaiStamp(utc: string): string {
  return localParts(utc)?.stamp ?? utc;
}

/**
 * Deterministic metadata header from the Pass1 row (§3.2.1). The realm=au
 * display word is resolved through the bundle's single mapping (closure-review
 * B); an unresolvable au (missing/empty id or empty label) returns null so the
 * orchestrator fails closed before any render/port call — no value echoed.
 */
export function buildMetaHeader(row: Pass1Episode, auDisplayById: Readonly<Record<string, string>>): EpisodeMetaHeader | null {
  const realmDisplay = realmDisplayWord(row.realm, row.au_id, auDisplayById);
  if (realmDisplay === null) return null;
  return {
    timeString: `${shanghaiStamp(row.started_at_utc)} 至 ${shanghaiStamp(row.ended_at_utc)}`,
    realmDisplay,
    realm: row.realm,
    auId: row.au_id,
    participants: row.participants,
    domainSuggestions: DOMAIN_SUGGESTIONS,
  };
}

function roleLabel(m: Pass1Message): string {
  if (m.proactive) return "Companion(主动消息)";
  return m.role === "owner" ? "Owner" : "Companion";
}

const codePoints = (s: string): number => [...s].length;

/** Render one WHOLE message as a unit line `[id] [HH:mm] Role: content` (§3.2.1). */
export function renderMessageUnit(m: Pass1Message): RenderedUnit {
  const hhmm = localParts(m.timestampUtc)?.localClock ?? "??:??";
  const line = `[${m.messageId}] [${hhmm}] ${roleLabel(m)}: ${m.contentNfc}`;
  return {
    refId: m.messageId,
    bareMessageId: m.messageId,
    sliceOrdinal: null,
    sliceTotal: null,
    line,
    renderedLength: codePoints(line),
    timestampUtc: m.timestampUtc,
    role: m.role,
    content: m.contentNfc,
  };
}

/** Render one SLICE of a message as a unit line (§3.2.2 virtual sub-block). */
export function renderSliceUnit(m: Pass1Message, sliceOrdinal: number, sliceTotal: number, content: string): RenderedUnit {
  const refId = `${m.messageId}#slice_${sliceOrdinal}`;
  const prefix =
    sliceOrdinal === 1
      ? `[${refId}/${sliceTotal}] [${localParts(m.timestampUtc)?.localClock ?? "??:??"}] ${roleLabel(m)}: `
      : `[${refId}/${sliceTotal}] (续): `;
  const line = prefix + content;
  return {
    refId,
    bareMessageId: m.messageId,
    sliceOrdinal,
    sliceTotal,
    line,
    renderedLength: codePoints(line),
    timestampUtc: m.timestampUtc,
    role: m.role,
    content,
  };
}

// ---------------------------------------------------------------------------
// Structured call builders (§5.1)
// ---------------------------------------------------------------------------

/** Regular-path episode call: a PRE-RESOLVED header + every member rendered once,
 *  in order. The header is resolved once by the orchestrator (single AU-display
 *  source, single fail-closed point). */
export function buildEpisodeCall(header: EpisodeMetaHeader, members: readonly Pass1Message[]): SummaryCall {
  return { kind: "episode", header, units: members.map(renderMessageUnit) };
}

/**
 * Chunk call with THIS block's +08 time span (§3.1.1 c02, G1A Erratum 3A). The
 * span comes from the first/last unit's archive UTC through the shared
 * time-labels rule — no raw-Z and no naive fallback: an empty block or an
 * unconvertible timestamp returns null (fail closed; the caller pends, no
 * prompt is generated).
 */
export function buildChunkCall(ordinal: number, total: number, chunkHash: string, units: readonly RenderedUnit[]): SummaryCall | null {
  if (units.length === 0) return null;
  const first = localParts(units[0]!.timestampUtc);
  const last = localParts(units[units.length - 1]!.timestampUtc);
  if (first === null || last === null) return null;
  return { kind: "chunk", ordinal, total, chunkHash, timeSpan: `${first.stamp} 至 ${last.stamp}`, units };
}

/** Assembly call: header + validated chunk summaries + fingerprint. NO original text. */
export function buildAssemblyCall(header: EpisodeMetaHeader, chunkSummaries: readonly ChunkModelOutput[], inputFingerprint: string): SummaryCall {
  return { kind: "assembly", header, n: chunkSummaries.length, chunkSummaries, inputFingerprint };
}

// ---------------------------------------------------------------------------
// Prompt rendering — bundle template + structured call → final prompt string.
// ---------------------------------------------------------------------------

function renderHeaderBlock(h: EpisodeMetaHeader): string {
  return [
    `时间: ${h.timeString}`,
    `层面: ${h.realmDisplay}`,
    `参与者: ${h.participants.join("、")}`,
    `domain 建议枚举: ${h.domainSuggestions.join("/")}`,
  ].join("\n");
}

/**
 * Render the final prompt text a call sends to the port. Deterministic; the
 * assembly branch renders chunk-summary JSON (canonical) and NEVER any message
 * line. Reuses the bundle's per-kind template verbatim.
 */
// ---------------------------------------------------------------------------
// Strict SummaryCall runtime shape guard (work order §5.1, G1A Erratum 4C).
// TypeScript unions are erased at runtime; this ONE guard closes the top-level
// key set of each call kind so a tampered call — in particular an assembly call
// carrying `units`/`content` or any unknown field — fails BEFORE prompt render
// and port call, with a stable category (never a thrown raw exception). The
// orchestrator runs it on the REAL path in front of every port call.
// ---------------------------------------------------------------------------

export type SummaryCallCheck = { ok: true } | { ok: false; code: "call_shape_invalid" };

const CALL_SHAPE_INVALID: SummaryCallCheck = { ok: false, code: "call_shape_invalid" };

const CALL_KEYS: Record<string, readonly string[]> = {
  episode: ["kind", "header", "units"],
  chunk: ["kind", "ordinal", "total", "chunkHash", "timeSpan", "units"],
  assembly: ["kind", "header", "n", "chunkSummaries", "inputFingerprint"],
};

// closed-shape predicates for the render-reachable nested structures. Reading a
// throwing getter / proxy trap here throws — validateSummaryCall's outer try/catch
// converts that to `call_shape_invalid` (never a leak, never a render throw).
const isStr = (v: unknown): v is string => typeof v === "string";
const isFiniteNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const isStrArray = (v: unknown): boolean => Array.isArray(v) && v.every(isStr);
const hasExactKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const keys = Object.keys(o);
  return keys.length === allowed.length && keys.every((k) => allowed.includes(k));
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isValidHeaderShape(h: unknown): boolean {
  if (!isObj(h)) return false;
  if (!hasExactKeys(h, ["timeString", "realmDisplay", "realm", "auId", "participants", "domainSuggestions"])) return false;
  return isStr(h["timeString"]) && isStr(h["realmDisplay"]) && isStr(h["realm"]) && (h["auId"] === null || isStr(h["auId"])) && isStrArray(h["participants"]) && isStrArray(h["domainSuggestions"]);
}

function isValidUnitShape(u: unknown): boolean {
  if (!isObj(u)) return false;
  if (!hasExactKeys(u, ["refId", "bareMessageId", "sliceOrdinal", "sliceTotal", "line", "renderedLength", "timestampUtc", "role", "content"])) return false;
  return (
    isStr(u["refId"]) && isStr(u["bareMessageId"]) && isStr(u["line"]) && isStr(u["timestampUtc"]) && isStr(u["role"]) && isStr(u["content"]) &&
    (u["sliceOrdinal"] === null || isFiniteNum(u["sliceOrdinal"])) && (u["sliceTotal"] === null || isFiniteNum(u["sliceTotal"])) && isFiniteNum(u["renderedLength"])
  );
}

// closure-03-review C4: the assembly chunkSummaries' INNER items must be closed
// too — a normally-serializable object with a smuggled extra field inside a claim
// or hint would otherwise pass the guard, survive canonicalJson, and reach the
// real prompt/port. These are the single per-item predicates (no second guard).
function isValidClaimItemShape(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (!hasExactKeys(v, ["text", "kind", "evidence_message_ids"])) return false;
  return isStr(v["text"]) && isStr(v["kind"]) && isStrArray(v["evidence_message_ids"]);
}
function isValidHintItemShape(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (!hasExactKeys(v, ["text", "message_id", "normalized_range", "confidence"])) return false;
  return isStr(v["text"]) && isStr(v["message_id"]) && (v["normalized_range"] === null || isStr(v["normalized_range"])) && isFiniteNum(v["confidence"]);
}

function isValidChunkSummaryShape(c: unknown): boolean {
  if (!isObj(c)) return false;
  if (!hasExactKeys(c, ["claims", "entities", "temporal_hints", "confidence", "uncertain_flags"])) return false;
  if (!Array.isArray(c["claims"]) || !c["claims"].every(isValidClaimItemShape)) return false;
  if (!Array.isArray(c["temporal_hints"]) || !c["temporal_hints"].every(isValidHintItemShape)) return false;
  return isStrArray(c["entities"]) && isStrArray(c["uncertain_flags"]) && (c["confidence"] === null || isFiniteNum(c["confidence"]));
}

function validateSummaryCallInner(call: unknown): SummaryCallCheck {
  if (!isObj(call)) return CALL_SHAPE_INVALID;
  const kind = call["kind"];
  if (kind !== "episode" && kind !== "chunk" && kind !== "assembly") return CALL_SHAPE_INVALID;
  if (!hasExactKeys(call, CALL_KEYS[kind]!)) return CALL_SHAPE_INVALID; // closed key set: no unknown / no missing
  // nested render-reachable shape (closure-02-review C): everything renderPrompt
  // touches is validated here so nothing malformed can throw in render or reach port.
  if (kind === "episode" || kind === "assembly") if (!isValidHeaderShape(call["header"])) return CALL_SHAPE_INVALID;
  if (kind === "episode" || kind === "chunk") {
    const units = call["units"];
    if (!Array.isArray(units) || !units.every(isValidUnitShape)) return CALL_SHAPE_INVALID;
  }
  if (kind === "chunk") {
    if (!Number.isSafeInteger(call["ordinal"]) || !Number.isSafeInteger(call["total"]) || !isStr(call["chunkHash"]) || !isStr(call["timeSpan"])) return CALL_SHAPE_INVALID;
  }
  if (kind === "assembly") {
    const cs = call["chunkSummaries"];
    if (!Number.isSafeInteger(call["n"]) || !isStr(call["inputFingerprint"]) || !Array.isArray(cs) || !cs.every(isValidChunkSummaryShape)) return CALL_SHAPE_INVALID;
  }
  return { ok: true };
}

/**
 * Strict SummaryCall shape guard (§5.1). PURE and it NEVER throws on any runtime
 * `unknown` (closure-02-review C): a throwing proxy trap or getter anywhere in
 * the call is caught and reported as `call_shape_invalid`. It closes the top-level
 * key set AND the nested shapes renderPrompt reaches (header / units /
 * chunkSummaries), so a call that passes this guard cannot throw in render or
 * carry a smuggled field into the port.
 */
export function validateSummaryCall(call: unknown): SummaryCallCheck {
  try {
    return validateSummaryCallInner(call);
  } catch {
    return CALL_SHAPE_INVALID;
  }
}

/**
 * G2 ruling 0c5028e8 §2.2 — TEMPORAL_ROUTING-v2 single machine source.
 *
 * The routing table the model sees is DERIVED, byte-mechanically, from the one
 * committed C9 lexicon + its deterministic normalizer registry. There is no
 * second hand-written classification anywhere: `normalizable_terms` are exactly
 * the entries whose normalizer is non-null, `unresolved_terms` exactly those
 * whose normalizer is null. Drift between the derived sets and C9 fails closed
 * BEFORE any provider call.
 */
export interface TemporalRoutingManifest {
  readonly normalizable: readonly string[];
  readonly unresolved: readonly string[];
  readonly block: string;
}

export type TemporalRoutingCheck =
  | { ok: true; manifest: TemporalRoutingManifest }
  | { ok: false; code: "temporal_routing_manifest_mismatch" };

export function buildTemporalRoutingManifest(bundle: SummaryBundle): TemporalRoutingCheck {
  const MISMATCH = { ok: false, code: "temporal_routing_manifest_mismatch" } as const;
  const lex = bundle.temporalHintLexicon;
  if (!Array.isArray(lex) || lex.length === 0) return MISMATCH;
  const normalizable: string[] = [];
  const unresolved: string[] = [];
  for (const t of lex) {
    if (typeof t.term !== "string" || t.term.length === 0) return MISMATCH;
    (t.normalizer !== null ? normalizable : unresolved).push(t.term);
  }
  // (1) the two sets are disjoint
  const nSet = new Set(normalizable);
  if (unresolved.some((t) => nSet.has(t))) return MISMATCH;
  // (2) their union is byte-equal to C9 (same multiset, same terms)
  const union = [...normalizable, ...unresolved].sort();
  const c9 = lex.map((t) => t.term).sort();
  if (union.length !== c9.length || union.some((t, i) => t !== c9[i])) return MISMATCH;
  const block = [
    "【时间词路由表】(由确定性 normalizer 注册表机械导出,只读)",
    `- 可归一化词(移入 temporal_hints,范围由本地流水线生成): ${normalizable.join("、")}`,
    `- 不可归一化词(不得生成 published hint,不得猜日期): ${unresolved.join("、")}`,
    "- 表外的时间表达: 不属于 hint 路由;作为事实一部分时必须原样保留在正文或 claim 中。",
  ].join("\n");
  return { ok: true, manifest: { normalizable, unresolved, block } };
}

/**
 * The derived routing block. P6 boundary review MAJOR: this used to return ""
 * on a failed manifest, which silently rendered a prompt WITHOUT the mandated
 * 【时间词路由表】 and sent it anyway. It now throws; `guardedPortCall` wraps
 * render in a try/catch that collapses any pre-port throw into a stable
 * `call_shape_invalid` with ZERO port calls, so degradation is impossible on
 * every path — including the B4 assembly leg, which bypasses `runPass2Core`.
 */
function routingBlock(bundle: SummaryBundle): string {
  const r = buildTemporalRoutingManifest(bundle);
  if (!r.ok) throw new Error(r.code);
  return r.manifest.block;
}

export function renderPrompt(bundle: SummaryBundle, call: SummaryCall): string {
  // G1-B Bundle-02-review Closure A: the C4 examples reach the model ONLY here,
  // sourced verbatim from `bundle.fewShots` (no inlined/second copy). They are
  // injected into the episode and assembly prompts (each block exactly once,
  // right after the prompt's `【正反示例】` heading) and NEVER into the chunk
  // prompt. `[...bundle.fewShots]` copies — the bundle/strings are not mutated.
  // Malformed `fewShots` is failed closed upstream (validateFewShots) before any
  // render/port; a valid list is a non-empty array of strings.
  if (call.kind === "episode") {
    return [bundle.episodePrompt, routingBlock(bundle), ...bundle.fewShots, renderHeaderBlock(call.header), "---", ...call.units.map((u) => u.line)].join("\n");
  }
  if (call.kind === "chunk") {
    // G1A Erratum 3A: the chunk prompt declares its own +08 span (never raw Z).
    // No few-shot examples enter the chunk prompt.
    return [bundle.chunkPrompt, routingBlock(bundle), `块: ${call.ordinal}/${call.total}`, `时间: ${call.timeSpan}`, "---", ...call.units.map((u) => u.line)].join("\n");
  }
  // P7 major fix: render each block through the SHARED canonical serializer so
  // the prompt bytes — like the assembly fingerprint (canonicalJson-based) —
  // are independent of model-controlled key insertion order. One serialization
  // rule, one implementation point (§13#12).
  const blocks = call.chunkSummaries.map((c, i) => `块摘要 ${i + 1}/${call.n}: ${canonicalJson(c)}`);
  return [bundle.assemblyPrompt, routingBlock(bundle), ...bundle.fewShots, `本情节经 ${call.n} 块中间摘要装配`, renderHeaderBlock(call.header), "---", ...blocks].join("\n");
}
