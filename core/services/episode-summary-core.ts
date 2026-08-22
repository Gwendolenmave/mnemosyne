/**
 * L1-T03 Pass2 core orchestrator (§3 / §10). Pure control flow over injected
 * collaborators; NO real model, transcript, DB, cache, quota, retry, served
 * probe, promotion, FTS, or persistence (those are T04/T05). It NEVER mutates
 * the Pass1 row, members, bundle, stub output, or validator input — every
 * derived structure is freshly built.
 *
 * Regular path:
 *   row + members → episode input → port(episode) → parseModelJson → V0–V13
 *   → candidate payload builder → T01 validateEpisodePayload → candidate/pending.
 * Chunked path:
 *   planChunks → port(chunk) per block → chunk validators → (all pass only)
 *   → assembly input (validated chunk JSON only) → port(assembly)
 *   → full V0–V13 (V11 assembly variant) → candidate builder → T01 validator.
 * Any chunk failure pends the whole episode with assemblyCalls = 0.
 *
 * Provenance is filled deterministically by the pipeline (source_hash + effective
 * realm/au/domain from the Pass1 row; generator/created_at/source_basis from
 * injected config); a model that emits provenance is rejected by V0. Pending
 * carries only stable reason/detail — never raw output, exception text, content,
 * or a hit word.
 */

import {
  PAYLOAD_VERSION,
  type ClaimKind,
  type EpisodePayload,
  type Sensitivity,
} from "../domain/episode.js";
import { validateEpisodePayload } from "../domain/episode-validation.js";
import type { Pass1Episode, Pass1Message } from "../domain/episode-pass1.js";
import type {
  ChunkModelOutput,
  EpisodeMetaHeader,
  EpisodeModelOutput,
  Pass2Config,
  Pass2CoreResult,
  Pass2PendingReason,
  RenderedUnit,
  SafeDetail,
  SafeDiagnostics,
  SummaryBundle,
  SummaryBundleManifest,
  SummaryCall,
} from "../domain/episode-pass2.js";
import { isEpisodeSummaryErrorKind, type EpisodeSummarizerPort, type EpisodeSummaryRequest } from "../ports/episode-summarizer.js";
import { assemblyInputFingerprint, checkSummaryBundleManifest, type OrderedChunkSummary } from "./episode-summary-bundle.js";
import { planChunks, type PlannedChunk } from "./episode-summary-chunking.js";
import { buildAssemblyCall, buildChunkCall, buildEpisodeCall, buildMetaHeader, buildTemporalRoutingManifest, DOMAIN_SUGGESTIONS, renderPrompt, validateAuDisplayMapping, validateFewShots, validateSummaryCall } from "./episode-summary-input.js";
import { parseModelJson, runValidators, type ValidationRun, type ValidatorContext } from "./episode-summary-validation.js";

export interface Pass2CoreInput {
  row: Pass1Episode;
  /** Ordered episode members (membership order). */
  members: readonly Pass1Message[];
  bundle: SummaryBundle;
  manifest: SummaryBundleManifest;
  config: Pass2Config;
  port: EpisodeSummarizerPort;
}

const EMPTY_DIAG: SafeDiagnostics = { chunkCount: 0, prunedEntities: 0, prunedHints: 0, warns: [], appendedFlags: [], notes: [] };

function pend(reason: Pass2PendingReason, detail: SafeDetail, diagnostics: SafeDiagnostics = EMPTY_DIAG): Pass2CoreResult {
  return { status: "pending", reason, detail, diagnostics };
}

function safeDiagnostics(run: ValidationRun, chunkCount: number): SafeDiagnostics {
  const notes = run.issues.map((i) => `${i.validatorId}:${i.stableCode}`);
  const warns = run.issues.filter((i) => i.stableCode.endsWith("_warn")).map((i) => `${i.validatorId}:${i.stableCode}`);
  return { chunkCount, prunedEntities: run.diagnostics.prunedEntities, prunedHints: run.diagnostics.prunedHints, warns, appendedFlags: run.diagnostics.appendedFlags, notes };
}

/**
 * The single sealed category for any throw NOT covered by an EpisodeSummarizerPort
 * typed failure (§ Erratum A). `Error.name`, constructor name, message, and stack
 * are adapter/provider-controlled and may carry original text, so none of them is
 * ever read: an unexpected throw is mapped here — and ONLY here — to this constant.
 * Consumers (harness, report) reuse this value; they never re-derive a category
 * from an exception.
 */
export const UNEXPECTED_EXCEPTION = "unexpected_exception";

type PortCall = { ok: true; rawJson: string } | { ok: false; code: string };

/**
 * One port call. The ENTIRE handling of the resolved result — the shape test
 * and every field read — happens inside one try/catch (closure-review C1), so a
 * contract-violating adapter cannot escape the sealed category: a `null` /
 * `undefined` / primitive result, an `ok` that is not a boolean, a throwing
 * getter on any field, or a non-string `rawJson` all collapse to
 * UNEXPECTED_EXCEPTION. A typed `ok:false` keeps its errorKind ONLY when the
 * runtime membership guard (same const-tuple the type derives from) accepts it;
 * any other errorKind collapses too. No adapter detail, exception, or
 * constructor/name/stack is ever read. This is the only exception→category site.
 */
async function callPort(port: EpisodeSummarizerPort, request: EpisodeSummaryRequest): Promise<PortCall> {
  try {
    const res: unknown = await port.summarize(request);
    if (res === null || typeof res !== "object") return { ok: false, code: UNEXPECTED_EXCEPTION };
    const ok = (res as { ok: unknown }).ok; // a throwing getter here lands in catch
    if (ok === true) {
      const rawJson = (res as { rawJson: unknown }).rawJson;
      return typeof rawJson === "string" ? { ok: true, rawJson } : { ok: false, code: UNEXPECTED_EXCEPTION };
    }
    if (ok === false) {
      const errorKind = (res as { errorKind: unknown }).errorKind;
      return { ok: false, code: isEpisodeSummaryErrorKind(errorKind) ? errorKind : UNEXPECTED_EXCEPTION };
    }
    return { ok: false, code: UNEXPECTED_EXCEPTION }; // ok is not a boolean
  } catch {
    return { ok: false, code: UNEXPECTED_EXCEPTION };
  }
}

/**
 * The SINGLE guard→render→port execution seam (closure-review C2). Every port
 * call in the pipeline flows through here, so the strict SummaryCall shape guard
 * is the sole pre-entry of prompt render and the port: a tampered call fails
 * with `call_shape_invalid` BEFORE `renderPrompt` (no content exposure) and
 * BEFORE the port (no call is made). A guard failure is a validation_failed; a
 * port failure is a model_error.
 */
export async function guardedPortCall(
  bundle: SummaryBundle,
  call: SummaryCall,
  port: EpisodeSummarizerPort,
  requestedModel: string,
): Promise<{ ok: true; rawJson: string } | { ok: false; reason: Pass2PendingReason; code: string }> {
  // closure-02-review C: the guard AND the render live inside one non-leaking
  // pre-port boundary. `validateSummaryCall` never throws, but render could still
  // throw on a shape the guard cannot fully close (a cyclic / BigInt chunk
  // summary reaching canonicalJson). Any pre-port throw collapses to the stable
  // `call_shape_invalid` with ZERO port calls — no getter/proxy/nested value or
  // exception detail is ever read. Port failures stay model_error / unexpected_exception.
  // P6 boundary review MAJOR: the §2.2 routing gate belongs HERE, at the one
  // guard→render→port seam, not only in `runPass2Core`. `guardedPortCall` is
  // exported and driven directly by the B4 assembly leg, which never runs the
  // core orchestrator — so a drifted bundle used to reach the port on that path
  // with a prompt whose 【时间词路由表】 had silently degraded to "".
  const routing = buildTemporalRoutingManifest(bundle);
  if (!routing.ok) return { ok: false, reason: "validation_failed", code: routing.code };
  let prompt: string;
  let kind: SummaryCall["kind"];
  try {
    const shape = validateSummaryCall(call);
    if (!shape.ok) return { ok: false, reason: "validation_failed", code: shape.code };
    kind = call.kind;
    prompt = renderPrompt(bundle, call);
  } catch {
    return { ok: false, reason: "validation_failed", code: "call_shape_invalid" };
  }
  const pc = await callPort(port, { kind, prompt, requestedModel });
  return pc.ok ? { ok: true, rawJson: pc.rawJson } : { ok: false, reason: "model_error", code: pc.code };
}

// ---------------------------------------------------------------------------
// Validator context builders (fresh structures; no input mutation)
// ---------------------------------------------------------------------------

// metadata labels reuse the header's already-resolved realm display word (the
// single AU-display source, closure-review B) — never a second resolution.
const metadataLabels = (header: EpisodeMetaHeader, row: Pass1Episode): string[] => [header.realmDisplay, ...row.participants, ...DOMAIN_SUGGESTIONS];

function fullMemberText(members: readonly Pass1Message[]): Map<string, string> {
  return new Map(members.map((m) => [m.messageId, m.contentNfc]));
}
function memberTimestamps(members: readonly Pass1Message[]): Map<string, string> {
  return new Map(members.map((m) => [m.messageId, m.timestampUtc]));
}

/** Slice ordinals per message across the WHOLE plan (a #slice_n ref is valid iff n exists). */
function collectSliceOrdinals(groups: readonly (readonly RenderedUnit[])[]): Map<string, Set<number>> {
  const m = new Map<string, Set<number>>();
  for (const g of groups) {
    for (const u of g) {
      if (u.sliceOrdinal !== null) {
        const s = m.get(u.bareMessageId) ?? new Set<number>();
        s.add(u.sliceOrdinal);
        m.set(u.bareMessageId, s);
      }
    }
  }
  return m;
}

function episodeContext(input: Pass2CoreInput, header: EpisodeMetaHeader): ValidatorContext {
  return {
    kind: "episode",
    header,
    memberIds: new Set(input.members.map((m) => m.messageId)),
    visibleText: fullMemberText(input.members),
    fullMessageText: fullMemberText(input.members),
    memberTimestamps: memberTimestamps(input.members),
    sliceOrdinals: new Map(),
    legalRefs: null,
    metadataLabels: metadataLabels(header, input.row),
    bundle: input.bundle,
    pass1Domain: input.row.domain,
    assemblyEvidenceUnion: null,
  };
}

/**
 * The chunk validator context (G1A Erratum 1 + closure-review A). TWO distinct
 * text sources are supplied on purpose:
 *   - `visibleText`  — ONLY this chunk's units' content (V8 entity whitelist);
 *   - `fullMessageText` — the WHOLE message contentNfc for each bare id the
 *     chunk touches (V6/V12 substring base, per 03R2 §3.3 V12).
 * `legalRefs` is the exact ref set the chunk owns (V11 hard gate — a bare id
 * cannot stand in for a sliced message, another chunk's ordinal is illegal),
 * while V12's slice-suffix check uses the message's REAL full slice set
 * (`fullSliceOrdinals`), not a chunk-local subset.
 */
function chunkContext(
  input: Pass2CoreInput,
  chunk: PlannedChunk,
  header: EpisodeMetaHeader,
  fullSliceOrdinals: ReadonlyMap<string, ReadonlySet<number>>,
): ValidatorContext {
  const legalRefs = new Set(chunk.units.map((u) => u.refId));
  const bareIds = new Set(chunk.units.map((u) => u.bareMessageId));
  const byId = new Map(input.members.map((m) => [m.messageId, m] as const));
  const visibleText = new Map<string, string>();
  const fullText = new Map<string, string>();
  const stamps = new Map<string, string>();
  for (const u of chunk.units) {
    visibleText.set(u.bareMessageId, (visibleText.get(u.bareMessageId) ?? "") + u.content); // chunk-local
    const whole = byId.get(u.bareMessageId);
    if (whole !== undefined) {
      fullText.set(u.bareMessageId, whole.contentNfc); // whole message, per 03R2 V12
      stamps.set(u.bareMessageId, whole.timestampUtc);
    }
  }
  return {
    kind: "chunk",
    header,
    memberIds: bareIds,
    visibleText,
    fullMessageText: fullText,
    memberTimestamps: stamps,
    sliceOrdinals: fullSliceOrdinals, // V12 validates against the message's REAL slice set
    legalRefs,
    metadataLabels: metadataLabels(header, input.row),
    bundle: input.bundle,
    pass1Domain: input.row.domain,
    assemblyEvidenceUnion: null,
  };
}

function assemblyContext(input: Pass2CoreInput, header: EpisodeMetaHeader, sliceOrdinals: ReadonlyMap<string, ReadonlySet<number>>, evidenceUnion: ReadonlySet<string>): ValidatorContext {
  return {
    kind: "assembly",
    header,
    memberIds: new Set(input.members.map((m) => m.messageId)),
    visibleText: fullMemberText(input.members),
    fullMessageText: fullMemberText(input.members),
    memberTimestamps: memberTimestamps(input.members),
    sliceOrdinals,
    legalRefs: null,
    metadataLabels: metadataLabels(header, input.row),
    bundle: input.bundle,
    pass1Domain: input.row.domain,
    assemblyEvidenceUnion: evidenceUnion,
  };
}

// ---------------------------------------------------------------------------
// Candidate payload builder (T01 shape; provenance filled by the pipeline)
// ---------------------------------------------------------------------------

function buildCandidate(out: EpisodeModelOutput, effectiveSensitivity: Sensitivity, input: Pass2CoreInput): EpisodePayload {
  // T01 payload temporal_hints require a non-null range; carry only resolved hints.
  const hints = out.temporal_hints.filter((h) => h.normalized_range !== null).map((h) => ({ text: h.text, message_id: h.message_id, normalized_range: h.normalized_range as string, confidence: h.confidence }));
  return {
    payload_version: input.config.payloadVersion,
    title: out.title,
    summary: out.summary,
    claims: out.claims.map((c) => ({ text: c.text, kind: c.kind as ClaimKind, evidence_message_ids: [...c.evidence_message_ids] })),
    temporal_hints: hints,
    entities_model: [...out.entities],
    uncertain_flags: out.uncertain_flags.filter((f): f is EpisodePayload["uncertain_flags"][number] => true),
    summary_confidence: out.confidence,
    domain_suggestion: out.domain_suggestion,
    sensitivity: effectiveSensitivity,
    provenance: {
      source_hash: input.row.source_hash,
      effective_realm: input.row.realm,
      effective_au_id: input.row.au_id,
      effective_domain: input.row.domain,
      // G1A Erratum 2: the version-coherence gate has already proven
      // config == bundle == manifest == row; provenance prefers the Pass1
      // row's verified values (the model id has no row counterpart).
      generator: { model: input.config.modelId, summary_version: input.row.summary_version, projection_version: input.row.index_version },
      created_at: input.config.createdAt,
      source_basis: "model",
    },
  };
}

function finishEpisodeRun(run: ValidationRun, input: Pass2CoreInput, chunkCount: number, locationPrefix: string): Pass2CoreResult {
  if (run.verdict === "hard_fail") return pend("validation_failed", { code: run.firstHardValidatorId, location: locationPrefix || undefined }, safeDiagnostics(run, chunkCount));
  const payload = buildCandidate(run.output as EpisodeModelOutput, run.effectiveSensitivity ?? "normal", input);
  const v = validateEpisodePayload(payload);
  if (!v.ok) return pend("validation_failed", { code: "payload_schema", location: locationPrefix || undefined }, safeDiagnostics(run, chunkCount));
  return { status: "candidate", payload: v.value, diagnostics: safeDiagnostics(run, chunkCount) };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runPass2Core(input: Pass2CoreInput): Promise<Pass2CoreResult> {
  // closure-02-review B: the whole AU-display mapping is validated FIRST — before
  // the bundle hash, header resolution, plan, or any port call — so a
  // missing/null/array/malformed mapping (empty or whitespace key/value) fails
  // closed as a typed pending instead of throwing in hash/render. This is the
  // "whole table invalid" gate; a valid table whose active au_id simply isn't a
  // key stays `au_display_unresolved` (resolved later by buildMetaHeader).
  if (!validateAuDisplayMapping(input.bundle.auDisplayById)) return pend("validation_failed", { code: "au_display_mapping_invalid" });
  // G1-B Bundle-02-review Closure A: the C4 few-shot list feeds the episode/
  // assembly prompts; a malformed list fails closed HERE, before any plan or
  // port call — stable code, zero example/error bytes on any face.
  if (!validateFewShots(input.bundle.fewShots)) return pend("validation_failed", { code: "few_shots_invalid" });
  // G2 ruling 0c5028e8 §2.2 — TEMPORAL_ROUTING-v2 single machine source. The
  // read-only routing table injected into every prompt is derived mechanically
  // from the committed C9 lexicon + its normalizer registry; ANY drift (a term
  // in neither set, a term in both, a union that is not byte-equal to C9) fails
  // closed HERE — before the plan and before any port call — so the model is
  // never asked to classify a time word itself. Stable code only.
  const routing = buildTemporalRoutingManifest(input.bundle);
  if (!routing.ok) return pend("validation_failed", { code: routing.code });
  // fail-closed bundle drift gate (§5.2)
  const drift = checkSummaryBundleManifest(input.bundle, input.manifest);
  if (!drift.ok) return pend("validation_failed", { code: drift.code });
  // payload/bundle version integrity (injected, explicit)
  if (input.config.payloadVersion !== PAYLOAD_VERSION) return pend("validation_failed", { code: "payload_version_mismatch" });
  // G1A Erratum 2: version-coherence gate — the prompt (bundle), the registered
  // manifest, the injected config, and the Pass1 row must agree on the summary
  // version, and config/row on the index version, BEFORE any plan or port call.
  // Stable categories only; no raw value is echoed.
  if (
    input.config.summaryVersion !== input.bundle.summaryVersion ||
    input.config.summaryVersion !== input.manifest.summaryVersion ||
    input.config.summaryVersion !== input.row.summary_version
  ) {
    return pend("validation_failed", { code: "summary_version_incoherent" });
  }
  if (input.config.indexVersion !== input.row.index_version) {
    return pend("validation_failed", { code: "index_version_incoherent" });
  }

  // closure-review B: resolve the metadata header ONCE through the single
  // AU-display mapping, BEFORE plan or port. A realm=au whose au_id is missing,
  // empty, or maps to an empty label fails closed here with a stable category —
  // no raw value echoed, zero port calls — and the resolved header is the one
  // source reused by every call and validator context below.
  const header = buildMetaHeader(input.row, input.bundle.auDisplayById);
  if (header === null) return pend("validation_failed", { code: "au_display_unresolved" });

  const plan = planChunks(input.members, input.config);
  if (plan.kind === "pending") return pend("validation_failed", { code: plan.code });

  if (plan.kind === "single") {
    // guardedPortCall is the sole guard→render→port seam (closure-review C2).
    const g = await guardedPortCall(input.bundle, buildEpisodeCall(header, input.members), input.port, input.config.modelId);
    if (!g.ok) return pend(g.reason, { code: g.code });
    const parsed = parseModelJson(g.rawJson);
    if (!parsed.ok) return pend("model_error", { code: parsed.code });
    const run = runValidators(parsed.value, episodeContext(input, header));
    return finishEpisodeRun(run, input, 1, "");
  }

  // chunked path — the message's REAL full slice set (V12 base, per 03R2 V12)
  const sliceOrdinals = collectSliceOrdinals(plan.chunks.map((c) => c.units));
  const validated: OrderedChunkSummary[] = [];
  const evidenceUnion = new Set<string>();
  for (const chunk of plan.chunks) {
    const loc = `chunk:${chunk.ordinal}/${chunk.total}`;
    const call = buildChunkCall(chunk.ordinal, chunk.total, chunk.chunkHash, chunk.units);
    // G1A Erratum 3A: an empty block or unconvertible timestamp builds no call
    if (call === null) return pend("validation_failed", { code: "chunk_time_unconvertible", location: loc });
    const g = await guardedPortCall(input.bundle, call, input.port, input.config.modelId);
    if (!g.ok) return pend(g.reason, { code: g.code, location: loc });
    const parsed = parseModelJson(g.rawJson);
    if (!parsed.ok) return pend("model_error", { code: parsed.code, location: loc });
    const run = runValidators(parsed.value, chunkContext(input, chunk, header, sliceOrdinals));
    if (run.verdict === "hard_fail") return pend("validation_failed", { code: run.firstHardValidatorId, location: loc }, safeDiagnostics(run, plan.chunks.length)); // assembly NOT called
    const cs = run.output as ChunkModelOutput;
    validated.push({ ordinal: chunk.ordinal, summary: cs });
    for (const claim of cs.claims) for (const ref of claim.evidence_message_ids) evidenceUnion.add(ref);
  }

  const fp = assemblyInputFingerprint(validated);
  if (!fp.ok) return pend("validation_failed", { code: fp.code, location: "assembly" });

  const assemblyCall = buildAssemblyCall(header, validated.map((v) => v.summary), fp.fingerprint);
  const g = await guardedPortCall(input.bundle, assemblyCall, input.port, input.config.modelId);
  if (!g.ok) return pend(g.reason, { code: g.code, location: "assembly" });
  const aParsed = parseModelJson(g.rawJson);
  if (!aParsed.ok) return pend("model_error", { code: aParsed.code, location: "assembly" });
  const aRun = runValidators(aParsed.value, assemblyContext(input, header, sliceOrdinals, evidenceUnion));
  return finishEpisodeRun(aRun, input, plan.chunks.length, "assembly");
}
