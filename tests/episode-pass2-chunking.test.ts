import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkHashOf,
  deriveGraphemeAlgoId,
  GRAPHEME_ALGO_ID,
  GRAPHEME_GENERATION,
  GRAPHEME_MANIFEST,
  planChunks,
  readRuntimeGraphemeIdentity,
  REGISTERED_GRAPHEME_IDENTITY,
  verifyGraphemeRuntime,
  type ChunkPlan,
} from "../core/services/episode-summary-chunking.js";
import { runValidators, type ValidatorContext } from "../core/services/episode-summary-validation.js";
import { buildMetaHeader } from "../core/services/episode-summary-input.js";
import type { ChunkModelOutput, RenderedUnit } from "../core/domain/episode-pass2.js";
import { syntheticBundle, syntheticConfig, syntheticEpisode, syntheticMembers } from "./pass2-fixtures.js";

/** L1-T03 P3 — deterministic chunking + zero-truncation slicing + the
 * EXECUTABLE grapheme-runtime invariant (matrix group C + owner ruling). */

const gseg = new Intl.Segmenter("und", { granularity: "grapheme" });
const graphemes = (s: string): string[] => [...gseg.segment(s)].map((p) => p.segment);

// Complex graphemes that MUST never be split: family ZWJ, flag, VS16 heart,
// non-composing combining mark, and an emoji + skin-tone modifier (work-order C01).
const COMPLEX = "👨‍👩‍👧🇨🇳❤️n̈👍🏽";

function allUnits(plan: ChunkPlan): RenderedUnit[] {
  if (plan.kind === "single") return plan.units;
  if (plan.kind === "chunked") return plan.chunks.flatMap((c) => c.units);
  throw new Error(`unexpected pending: ${plan.kind === "pending" ? plan.code : ""}`);
}

// --- owner ruling: registered identity + runtime verification ---

test("manifest registers Intl.Segmenter + ICU + Unicode; the algo id is DERIVED from it; runtime matches", () => {
  assert.equal(GRAPHEME_MANIFEST.generation, GRAPHEME_GENERATION);
  assert.equal(GRAPHEME_MANIFEST.identity.primitive, "Intl.Segmenter");
  assert.match(GRAPHEME_MANIFEST.identity.icu, /^\d+/);
  assert.match(GRAPHEME_MANIFEST.identity.unicode, /^\d+/);
  // the algo id is the derived value, not an independent constant
  assert.equal(GRAPHEME_MANIFEST.algoId, GRAPHEME_ALGO_ID);
  assert.equal(GRAPHEME_ALGO_ID, deriveGraphemeAlgoId(REGISTERED_GRAPHEME_IDENTITY));
  assert.match(GRAPHEME_ALGO_ID, /^grapheme-v1:[0-9a-f]{64}$/);
  // On the pinned runtime the live identity equals the registered one.
  assert.deepEqual(readRuntimeGraphemeIdentity(), REGISTERED_GRAPHEME_IDENTITY);
  assert.ok(verifyGraphemeRuntime(readRuntimeGraphemeIdentity()));
});

test("version-coupling 1&2: changing manifest.icu OR manifest.unicode changes the derived algorithm id", () => {
  const base = deriveGraphemeAlgoId(REGISTERED_GRAPHEME_IDENTITY);
  assert.notEqual(deriveGraphemeAlgoId({ ...REGISTERED_GRAPHEME_IDENTITY, icu: "77.0" }), base);
  assert.notEqual(deriveGraphemeAlgoId({ ...REGISTERED_GRAPHEME_IDENTITY, unicode: "16.0" }), base);
  // the generation prefix is stable; only the manifest-hash suffix moves
  assert.ok(deriveGraphemeAlgoId({ ...REGISTERED_GRAPHEME_IDENTITY, icu: "77.0" }).startsWith("grapheme-v1:"));
  // primitive is also carried
  assert.notEqual(deriveGraphemeAlgoId({ ...REGISTERED_GRAPHEME_IDENTITY, primitive: "absent" }), base);
});

test("version-coupling 3: manifest key insertion order does NOT change the derived id", () => {
  const reordered = { unicode: REGISTERED_GRAPHEME_IDENTITY.unicode, primitive: REGISTERED_GRAPHEME_IDENTITY.primitive, icu: REGISTERED_GRAPHEME_IDENTITY.icu };
  assert.equal(deriveGraphemeAlgoId(reordered), deriveGraphemeAlgoId(REGISTERED_GRAPHEME_IDENTITY));
});

test("runtime-mismatch (changed ICU/Unicode, or absent Segmenter) fails closed = grapheme_runtime_unverified", () => {
  const members = syntheticMembers([{ role: "owner", offsetSec: 0, content: COMPLEX.repeat(20), messageId: "m-1" }]);
  const cfg = syntheticConfig({ chunkMax: 40 });
  for (const bad of [
    { primitive: "Intl.Segmenter", icu: "77.0", unicode: "17.0" },
    { primitive: "Intl.Segmenter", icu: "78.2", unicode: "16.0" },
    { primitive: "absent", icu: "78.2", unicode: "17.0" },
  ]) {
    const plan = planChunks(members, cfg, bad);
    assert.equal(plan.kind, "pending");
    if (plan.kind === "pending") assert.equal(plan.code, "grapheme_runtime_unverified");
  }
  // and verifyGraphemeRuntime is a pure equality on all three fields
  assert.equal(verifyGraphemeRuntime({ primitive: "Intl.Segmenter", icu: "78.2", unicode: "17.0" }), true);
});

// --- C01 / C02 / C03: grapheme integrity, zero truncation, coverage ---

test("C01: family-ZWJ / flag / VS16 / combining-mark / skin-tone graphemes are NEVER split across slices", () => {
  const content = COMPLEX.repeat(30);
  const members = syntheticMembers([{ role: "owner", offsetSec: 0, content, messageId: "m-1" }]);
  const plan = planChunks(members, syntheticConfig({ chunkMax: 45, maxChunks: 64 }));
  const units = allUnits(plan);
  assert.ok(units.length > 1, "content should have been sliced into multiple units");
  // Re-segment each slice and concatenate — must equal the original grapheme sequence.
  const rejoined = units.flatMap((u) => graphemes(u.content));
  assert.deepEqual(rejoined, graphemes(content.normalize("NFC")));
});

test("C02: slice contents (prefix stripped) rejoin to the original NFC content byte-for-byte", () => {
  const content = COMPLEX.repeat(25) + "尾巴文字ending";
  const members = syntheticMembers([{ role: "owner", offsetSec: 0, content, messageId: "m-1" }]);
  const units = allUnits(planChunks(members, syntheticConfig({ chunkMax: 50, maxChunks: 64 })));
  assert.equal(units.map((u) => u.content).join(""), content.normalize("NFC"));
  // slice refIds are message_id#slice_n and ordinals are contiguous 1..k
  units.forEach((u, i) => {
    assert.equal(u.refId, `m-1#slice_${i + 1}`);
    assert.equal(u.sliceOrdinal, i + 1);
    assert.equal(u.sliceTotal, units.length);
  });
});

test("C03: chunk units cover every unit once, in order, with no duplication", () => {
  const members = syntheticMembers([
    { role: "owner", offsetSec: 0, content: "alpha message one", messageId: "m-1" },
    { role: "companion", offsetSec: 60, content: "beta message two", messageId: "m-2" },
    { role: "owner", offsetSec: 120, content: "gamma message three", messageId: "m-3" },
  ]);
  // small chunkMax so each whole message lands in its own chunk
  const plan = planChunks(members, syntheticConfig({ chunkMax: 45, maxChunks: 64 }));
  const units = allUnits(plan);
  assert.deepEqual(units.map((u) => u.bareMessageId), ["m-1", "m-2", "m-3"]);
});

// --- C04 determinism ---

test("C04: same input yields byte-identical slice boundaries, chunk order, and chunk hashes across two runs", () => {
  const members = syntheticMembers([
    { role: "owner", offsetSec: 0, content: COMPLEX.repeat(30), messageId: "m-1" },
    { role: "companion", offsetSec: 60, content: "a reply here", messageId: "m-2" },
  ]);
  const cfg = syntheticConfig({ chunkMax: 45, maxChunks: 64 });
  const a = planChunks(members, cfg);
  const b = planChunks(members, cfg);
  assert.equal(a.kind, "chunked");
  assert.deepEqual(a, b);
  if (a.kind === "chunked") {
    for (const c of a.chunks) assert.match(c.chunkHash, /^sha256:[0-9a-f]{64}$/);
  }
});

test("C04b: chunkHashOf is the shared canonical member-hash rule and is order/content sensitive", () => {
  const u = (refId: string, content: string): RenderedUnit => ({
    refId,
    bareMessageId: refId,
    sliceOrdinal: null,
    sliceTotal: null,
    line: content,
    renderedLength: [...content].length,
    timestampUtc: "2099-01-01T00:00:00.000Z",
    role: "owner",
    content,
  });
  const base = chunkHashOf([u("m-1", "x"), u("m-2", "y")]);
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(base, chunkHashOf([u("m-2", "y"), u("m-1", "x")])); // order sensitive
  assert.notEqual(base, chunkHashOf([u("m-1", "x"), u("m-2", "z")])); // content sensitive
});

// --- C05 / C06 slicing trigger + boundary packing ---

test("C05: a single message over CHUNK_MAX goes down the slice path", () => {
  const members = syntheticMembers([{ role: "owner", offsetSec: 0, content: "z".repeat(500), messageId: "m-1" }]);
  const plan = planChunks(members, syntheticConfig({ chunkMax: 60, maxChunks: 64 }));
  assert.equal(plan.kind, "chunked");
  const units = allUnits(plan);
  assert.ok(units.every((x) => x.sliceOrdinal !== null));
  assert.equal(units.map((x) => x.content).join(""), "z".repeat(500));
});

test("C06: multiple messages pack greedily at unit boundaries; a tiny episode is the single regular path", () => {
  const members = syntheticMembers([
    { role: "owner", offsetSec: 0, content: "short a", messageId: "m-1" },
    { role: "companion", offsetSec: 60, content: "short b", messageId: "m-2" },
  ]);
  // large chunkMax → whole episode fits one call = regular path
  assert.equal(planChunks(members, syntheticConfig({ chunkMax: 500 })).kind, "single");
  // tiny chunkMax → each message its own chunk = chunked
  const chunked = planChunks(members, syntheticConfig({ chunkMax: 35, maxChunks: 64 }));
  assert.equal(chunked.kind, "chunked");
  if (chunked.kind === "chunked") assert.equal(chunked.chunks.length, 2);

  // G1A Erratum 3B: TRUE exact-boundary and +1 fixtures — the packed length is
  // the REAL joined ("\n"-separated) rendered length, measured, not assumed.
  const three = syntheticMembers([
    { role: "owner", offsetSec: 0, content: "aaaaa", messageId: "m-1" },
    { role: "companion", offsetSec: 60, content: "bbbbb", messageId: "m-2" },
    { role: "owner", offsetSec: 120, content: "ccccc", messageId: "m-3" },
  ]);
  const probe = planChunks(three, syntheticConfig({ chunkMax: 500 }));
  assert.equal(probe.kind, "single");
  if (probe.kind !== "single") return;
  const [u1, u2] = probe.units;
  const exactTwo = u1!.renderedLength + 1 + u2!.renderedLength; // units + the "\n" joiner
  const joinedLen = (units: readonly RenderedUnit[]): number => [...units.map((u) => u.line).join("\n")].length;
  assert.equal(joinedLen([u1!, u2!]), exactTwo, "the accounting formula equals the real joined length");

  // two units + separator EXACTLY equal CHUNK_MAX → same block
  const atBoundary = planChunks(three, syntheticConfig({ chunkMax: exactTwo, maxChunks: 64 }));
  assert.equal(atBoundary.kind, "chunked");
  if (atBoundary.kind === "chunked") {
    assert.equal(atBoundary.chunks[0]!.units.length, 2, "exact fit packs both units into the first block");
    assert.equal(joinedLen(atBoundary.chunks[0]!.units), exactTwo);
  }
  // ONE more code point required → they split
  const overBoundary = planChunks(three, syntheticConfig({ chunkMax: exactTwo - 1, maxChunks: 64 }));
  assert.equal(overBoundary.kind, "chunked");
  if (overBoundary.kind === "chunked") assert.equal(overBoundary.chunks[0]!.units.length, 1, "one code point over splits the block");

  // invariant: NO emitted block's real joined length ever exceeds CHUNK_MAX
  for (const [plan, max] of [[atBoundary, exactTwo], [overBoundary, exactTwo - 1], [chunked, 35]] as const) {
    if (plan.kind === "chunked") for (const c of plan.chunks) assert.ok(joinedLen(c.units) <= max, `block within CHUNK_MAX ${max}`);
  }
});

// --- C07 overflow / C08 config fail-closed ---

test("C07: exceeding MAX_CHUNKS pends as chunking_overflow (no partial plan)", () => {
  // Each whole message renders to ~25 code points (< chunkMax 40, so NO slicing);
  // two never fit together (50 > 40) → one chunk per message → 6 chunks > maxChunks 3.
  const members = syntheticMembers(
    Array.from({ length: 6 }, (_, i) => ({ role: "owner" as const, offsetSec: i * 60, content: `msg ${i}`, messageId: `m-${i}` })),
  );
  const plan = planChunks(members, syntheticConfig({ chunkMax: 40, maxChunks: 3 }));
  assert.equal(plan.kind, "pending");
  if (plan.kind === "pending") assert.equal(plan.code, "chunking_overflow");
});

test("C08: missing / zero / negative / non-integer CHUNK_MAX or MAX_CHUNKS fail closed = config_invalid", () => {
  const members = syntheticMembers([{ role: "owner", offsetSec: 0, content: "x", messageId: "m-1" }]);
  for (const bad of [{ chunkMax: 0 }, { chunkMax: -5 }, { chunkMax: 1.5 }, { chunkMax: Number.NaN }, { maxChunks: 0 }, { maxChunks: -1 }, { maxChunks: 2.2 }]) {
    const plan = planChunks(members, syntheticConfig(bad));
    assert.equal(plan.kind, "pending");
    if (plan.kind === "pending") assert.equal(plan.code, "config_invalid");
  }
});

// --- C09 slice-evidence routing: the ordinals produced by chunking gate V11 ---

test("C09: valid slice evidence and an illegal ordinal are routed correctly", () => {
  // Slice one long message into k contiguous slices, then feed the ordinal set
  // that chunking produced into the evidence validator: an in-range #slice_n is
  // accepted, an out-of-range ordinal hard-fails V11 — no silent acceptance.
  const content = "z".repeat(400);
  const members = syntheticMembers([{ role: "owner", offsetSec: 0, content, messageId: "m-1" }]);
  const units = allUnits(planChunks(members, syntheticConfig({ chunkMax: 60, maxChunks: 64 })));
  const k = units.length;
  assert.ok(k >= 2 && units.every((u) => u.sliceOrdinal !== null), "the message was sliced");
  const valid = new Set(units.map((u) => u.sliceOrdinal as number));
  assert.deepEqual([...valid].sort((a, b) => a - b), Array.from({ length: k }, (_, i) => i + 1), "ordinals are contiguous 1..k");

  const { row } = syntheticEpisode([{ role: "owner", offsetSec: 0, content, messageId: "m-1" }]);
  const bundle = syntheticBundle();
  const chunkCtx: ValidatorContext = {
    kind: "chunk",
    header: buildMetaHeader(row, bundle.auDisplayById)!,
    memberIds: new Set(["m-1"]),
    visibleText: new Map([["m-1", content]]),
    fullMessageText: new Map([["m-1", content]]),
    memberTimestamps: new Map([["m-1", members[0]!.timestampUtc]]),
    sliceOrdinals: new Map([["m-1", valid]]),
    legalRefs: new Set(units.map((u) => u.refId)), // exact refs this (pseudo-)chunk owns
    metadataLabels: [],
    bundle,
    pass1Domain: row.domain,
    assemblyEvidenceUnion: null,
  };
  const chunkOut = (ref: string): ChunkModelOutput => ({ claims: [{ text: "a fact", kind: "event", evidence_message_ids: [ref] }], entities: [], temporal_hints: [], confidence: 0.7, uncertain_flags: [] });

  // in-range slice ordinal → accepted
  assert.equal(runValidators(chunkOut(`m-1#slice_${k}`), chunkCtx).verdict, "pass");
  // out-of-range ordinal → V11 hard-fails (evidence_bad_slice)
  const bad = runValidators(chunkOut(`m-1#slice_${k + 1}`), chunkCtx);
  assert.equal(bad.verdict, "hard_fail");
  if (bad.verdict === "hard_fail") assert.equal(bad.firstHardValidatorId, "V11");
});
