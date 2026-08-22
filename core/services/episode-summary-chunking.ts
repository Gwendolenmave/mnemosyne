/**
 * L1-T03 Pass2 deterministic chunking + zero-truncation virtual slicing (§3.2.2
 * / §7). Pure and deterministic. A single message whose rendered length exceeds
 * CHUNK_MAX is sliced at STABLE grapheme-cluster boundaries; units (whole
 * messages or slices) are greedily packed into chunks; each chunk carries a
 * chunk_hash computed by the SINGLE shared `canonicalMemberHash` rule (§13#1).
 *
 * Grapheme stability is an EXECUTABLE invariant, not a comment (owner ruling):
 * the runtime `Intl.Segmenter` + ICU + Unicode identity is registered against a
 * pinned manifest and verified BEFORE any slicing. A mismatch (an ICU/Unicode
 * change, or a missing Segmenter) fails closed with `grapheme_runtime_unverified`
 * and produces no slices — so a changed identity cannot silently shift slice
 * points; the maintainer MUST re-register the identity and bump the algorithm
 * version. The manifest is emitted into the normalized evidence report.
 */

import { createHash } from "node:crypto";
import { canonicalMemberHash } from "./episode-pass1.js";
import { canonicalJson } from "../domain/episode-pass1.js";
import { renderMessageUnit, renderSliceUnit } from "./episode-summary-input.js";
import type { Pass1Message } from "../domain/episode-pass1.js";
import type { Pass2Config, RenderedUnit } from "../domain/episode-pass2.js";

// ---------------------------------------------------------------------------
// Registered grapheme runtime identity + DERIVED algorithm id (owner ruling)
// ---------------------------------------------------------------------------

/**
 * Algorithm/schema GENERATION — bump ONLY when the slicing algorithm or its
 * schema changes. The primitive/ICU/Unicode identity is NOT hand-synced here:
 * the derived id below carries it via a manifest hash, so an ICU/Unicode change
 * necessarily changes the id without any manual edit to this constant.
 */
export const GRAPHEME_GENERATION = "grapheme-v1";

export interface GraphemeRuntimeIdentity {
  /** The segmentation primitive — "Intl.Segmenter" when present, "absent" otherwise. */
  primitive: string;
  /** process.versions.icu at registration time. */
  icu: string;
  /** process.versions.unicode at registration time. */
  unicode: string;
}

/**
 * The registered identity `grapheme-v1` was validated against. Node is pinned
 * (.nvmrc 22.22.1) and bundles this ICU. A runtime whose identity differs fails
 * closed; re-registering here changes the derived id automatically.
 */
export const REGISTERED_GRAPHEME_IDENTITY: GraphemeRuntimeIdentity = {
  primitive: "Intl.Segmenter",
  icu: "78.2",
  unicode: "17.0",
};

/**
 * Derived algorithm id `grapheme-v1:<sha256(canonical identity)>` (owner ruling):
 * the version is NOT an independent constant needing manual sync — the manifest
 * hash deterministically carries primitive/ICU/Unicode, so any identity change
 * necessarily changes the id. `canonicalJson` sorts keys, so the id is
 * independent of manifest key insertion order.
 */
export function deriveGraphemeAlgoId(identity: GraphemeRuntimeIdentity): string {
  return `${GRAPHEME_GENERATION}:${createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex")}`;
}

/** The registered derived algorithm id — the ONE id all evidence/reports use. */
export const GRAPHEME_ALGO_ID = deriveGraphemeAlgoId(REGISTERED_GRAPHEME_IDENTITY);

export interface GraphemeManifest {
  /** Derived id: `${generation}:${sha256(canonical identity)}`. */
  algoId: string;
  generation: string;
  identity: GraphemeRuntimeIdentity;
}

/** Emitted verbatim into the normalized evidence report (owner requirement 5). */
export const GRAPHEME_MANIFEST: GraphemeManifest = {
  algoId: GRAPHEME_ALGO_ID,
  generation: GRAPHEME_GENERATION,
  identity: REGISTERED_GRAPHEME_IDENTITY,
};

/** Read the CURRENT runtime grapheme identity. The one spot that touches process.versions. */
export function readRuntimeGraphemeIdentity(): GraphemeRuntimeIdentity {
  return {
    primitive: typeof Intl.Segmenter === "function" ? "Intl.Segmenter" : "absent",
    icu: process.versions.icu ?? "",
    unicode: process.versions.unicode ?? "",
  };
}

/** True iff the runtime identity byte-equals the registered identity (all three fields). */
export function verifyGraphemeRuntime(runtime: GraphemeRuntimeIdentity, registered: GraphemeRuntimeIdentity = REGISTERED_GRAPHEME_IDENTITY): boolean {
  return runtime.primitive === registered.primitive && runtime.icu === registered.icu && runtime.unicode === registered.unicode;
}

// ---------------------------------------------------------------------------
// Grapheme slicing (§3.2.2)
// ---------------------------------------------------------------------------

const codePoints = (s: string): number => [...s].length;

/** Split text into grapheme clusters via the (verified) Intl.Segmenter primitive. */
function graphemeClusters(text: string): string[] {
  const seg = new Intl.Segmenter("und", { granularity: "grapheme" });
  const out: string[] = [];
  for (const part of seg.segment(text)) out.push(part.segment);
  return out;
}

type SliceOutcome = { ok: true; units: RenderedUnit[] } | { ok: false; code: "slicing_error" };

/**
 * Slice one over-long message into rendered slice units, each ≤ CHUNK_MAX
 * rendered length, at grapheme-cluster boundaries. The content budget reserves
 * the worst-case first-slice prefix (k = clusterCount digits) so every rendered
 * slice is bounded. Reconstruction (join of slice contents == original NFC) is
 * verified — zero truncation, or `slicing_error` (fail closed).
 */
function sliceMessage(m: Pass1Message, chunkMax: number): SliceOutcome {
  const whole = renderMessageUnit(m);
  if (whole.renderedLength <= chunkMax) return { ok: true, units: [whole] };

  const clusters = graphemeClusters(m.contentNfc);
  if (clusters.length === 0) return { ok: false, code: "slicing_error" };
  // Worst-case first-slice prefix length: n=1, k=clusters.length (max possible slices).
  const reserve = renderSliceUnit(m, 1, clusters.length, "").renderedLength;
  const budget = chunkMax - reserve;
  if (budget < 1) return { ok: false, code: "slicing_error" };

  const sliceContents: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const g of clusters) {
    const gl = codePoints(g);
    if (gl > budget) return { ok: false, code: "slicing_error" }; // a single grapheme can't fit — fail closed
    if (curLen + gl > budget && curLen > 0) {
      sliceContents.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += g;
    curLen += gl;
  }
  if (curLen > 0) sliceContents.push(cur);

  // zero-truncation: the slices reconstruct the original content byte-for-byte
  if (sliceContents.join("") !== m.contentNfc) return { ok: false, code: "slicing_error" };
  const k = sliceContents.length;
  const units = sliceContents.map((c, i) => renderSliceUnit(m, i + 1, k, c));
  for (const u of units) if (u.renderedLength > chunkMax) return { ok: false, code: "slicing_error" };
  return { ok: true, units };
}

// ---------------------------------------------------------------------------
// Greedy packing + chunk_hash (§7.2)
// ---------------------------------------------------------------------------

function greedyPack(units: readonly RenderedUnit[], chunkMax: number): RenderedUnit[][] {
  // G1A Erratum 3B: the packed length must equal the REAL rendered unit-block
  // length — units join with "\n", so one joiner code point is counted between
  // consecutive units. No emitted block's joined length exceeds chunkMax.
  const chunks: RenderedUnit[][] = [];
  let cur: RenderedUnit[] = [];
  let curLen = 0;
  for (const u of units) {
    const joined = cur.length === 0 ? u.renderedLength : curLen + 1 + u.renderedLength;
    if (joined > chunkMax && cur.length > 0) {
      chunks.push(cur);
      cur = [u];
      curLen = u.renderedLength;
    } else {
      cur.push(u);
      curLen = joined;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** chunk_hash over a block's units — the SAME rule as source_hash (§3.2.2 / §13#1). */
export function chunkHashOf(units: readonly RenderedUnit[]): string {
  return canonicalMemberHash(units.map((u) => ({ id: u.refId, timestampUtc: u.timestampUtc, role: u.role, content: u.content })));
}

// ---------------------------------------------------------------------------
// Plan (§3.2.1 regular vs §3.2.2 chunked)
// ---------------------------------------------------------------------------

export interface PlannedChunk {
  ordinal: number;
  total: number;
  chunkHash: string;
  units: RenderedUnit[];
}

export type ChunkPlan =
  | { kind: "single"; units: RenderedUnit[] }
  | { kind: "chunked"; chunks: PlannedChunk[] }
  | { kind: "pending"; code: "grapheme_runtime_unverified" | "chunking_overflow" | "slicing_error" | "config_invalid"; detail?: string };

const isPositiveInt = (v: number): boolean => Number.isSafeInteger(v) && v > 0;

/**
 * Plan how this episode's members are presented to the model. `single` = the
 * regular path (one episode call); `chunked` = the deterministic chunk path
 * (per-block calls + assembly). Fails closed on an unverified grapheme runtime,
 * bad config, an unsliceable message, or a chunk-count overflow.
 */
export function planChunks(
  members: readonly Pass1Message[],
  config: Pass2Config,
  runtimeIdentity: GraphemeRuntimeIdentity = readRuntimeGraphemeIdentity(),
): ChunkPlan {
  // (0) executable grapheme-identity gate — BEFORE any slicing (owner requirement 2)
  if (!verifyGraphemeRuntime(runtimeIdentity)) return { kind: "pending", code: "grapheme_runtime_unverified" };
  // (1) config fail-closed (§7.3)
  if (!isPositiveInt(config.chunkMax) || !isPositiveInt(config.maxChunks)) return { kind: "pending", code: "config_invalid" };

  // (2) build units — slice any over-long message (zero truncation)
  const allUnits: RenderedUnit[] = [];
  let anySlice = false;
  for (const m of members) {
    const whole = renderMessageUnit(m);
    if (whole.renderedLength <= config.chunkMax) {
      allUnits.push(whole);
      continue;
    }
    const sliced = sliceMessage(m, config.chunkMax);
    if (!sliced.ok) return { kind: "pending", code: "slicing_error", detail: m.messageId };
    anySlice = true;
    allUnits.push(...sliced.units);
  }

  // (3) greedy pack
  const packed = greedyPack(allUnits, config.chunkMax);
  if (packed.length > config.maxChunks) return { kind: "pending", code: "chunking_overflow" };

  // (4) regular path iff a single chunk and no slicing happened
  if (packed.length === 1 && !anySlice) return { kind: "single", units: allUnits };

  const chunks: PlannedChunk[] = packed.map((units, i) => ({ ordinal: i + 1, total: packed.length, chunkHash: chunkHashOf(units), units }));
  return { kind: "chunked", chunks };
}
