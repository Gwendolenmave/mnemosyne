import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssemblyCall,
  buildChunkCall,
  buildEpisodeCall,
  buildMetaHeader,
  DOMAIN_SUGGESTIONS,
  realmDisplayWord,
  renderMessageUnit,
  renderPrompt,
  validateAuDisplayMapping,
  validateFewShots,
  validateSummaryCall,
} from "../core/services/episode-summary-input.js";
import type { Pass1Episode } from "../core/domain/episode-pass1.js";
import type { EpisodeMetaHeader } from "../core/domain/episode-pass2.js";
import { summaryBundleHash } from "../core/services/episode-summary-bundle.js";
import { syntheticBundle, syntheticEpisode, syntheticMembers, chunkOutput } from "./pass2-fixtures.js";

/** L1-T03 P2 — input construction boundaries (matrix group B). */

// The header is now resolved through the bundle's single AU-display mapping
// (closure-review B); this helper resolves the synthetic row (au-alpha → label).
const AU_MAP = syntheticBundle().auDisplayById;
const hdr = (row: Pass1Episode): EpisodeMetaHeader => {
  const h = buildMetaHeader(row, AU_MAP);
  assert.ok(h, "synthetic row resolves through the AU mapping");
  return h;
};

test("B01: every member is rendered exactly once, in membership order", () => {
  const { row, members } = syntheticEpisode([
    { role: "owner", offsetSec: 0, content: "first", messageId: "m-1" },
    { role: "companion", offsetSec: 60, content: "second", messageId: "m-2" },
    { role: "owner", offsetSec: 120, content: "third", messageId: "m-3" },
  ]);
  const call = buildEpisodeCall(hdr(row), members);
  assert.equal(call.kind, "episode");
  if (call.kind !== "episode") return;
  assert.deepEqual(call.units.map((u) => u.bareMessageId), ["m-1", "m-2", "m-3"]);
  // each id appears exactly once
  for (const id of ["m-1", "m-2", "m-3"]) {
    assert.equal(call.units.filter((u) => u.bareMessageId === id).length, 1);
  }
});

test("B02: role mapping — owner→Owner, companion→Companion, proactive→Companion(主动消息); no user/assistant tokens", () => {
  const { row, members } = syntheticEpisode([
    { role: "owner", offsetSec: 0, content: "hi", messageId: "m-1" },
    { role: "companion", offsetSec: 60, content: "hello", messageId: "m-2" },
    { role: "companion", offsetSec: 120, content: "nudge", messageId: "m-3", proactive: true },
  ]);
  const prompt = renderPrompt(syntheticBundle(), buildEpisodeCall(hdr(row), members));
  assert.match(prompt, /\[m-1\] \[\d\d:\d\d\] Owner: hi/);
  assert.match(prompt, /\[m-2\] \[\d\d:\d\d\] Companion: hello/);
  assert.match(prompt, /\[m-3\] \[\d\d:\d\d\] Companion\(主动消息\): nudge/);
  assert.ok(!/user|assistant/i.test(prompt), "no user/assistant role tokens in the prompt");
});

test("B03: times render ONLY as +08 HH:mm; the archive UTC-Z string never appears", () => {
  const { row, members } = syntheticEpisode([{ role: "owner", offsetSec: 0, content: "x", messageId: "m-1" }]);
  const prompt = renderPrompt(syntheticBundle(), buildEpisodeCall(hdr(row), members));
  // base 12:00:00Z → +08 20:00
  assert.match(prompt, /\[20:00\]/);
  assert.ok(!prompt.includes("2099-01-02T12:00:00.000Z"), "raw archive Z instant must not appear");
  assert.ok(hdr(row).timeString.includes("+08:00"));
});

test("B04: no adjacent-episode / persona / retrieval / Mnemosyne text can enter the episode prompt", () => {
  const { row, members } = syntheticEpisode([{ role: "owner", offsetSec: 0, content: "clean content", messageId: "m-1" }]);
  const prompt = renderPrompt(syntheticBundle(), buildEpisodeCall(hdr(row), members));
  for (const foreign of ["PERSONA-IDENTITY", "MNEMOSYNE-CARD", "RETRIEVAL-HIT", "ADJACENT-EPISODE"]) {
    assert.ok(!prompt.includes(foreign), `${foreign} must not appear`);
  }
  // structurally: the episode call exposes only header + units — no field could carry them.
  const call = buildEpisodeCall(hdr(row), members);
  assert.deepEqual(Object.keys(call).sort(), ["header", "kind", "units"]);
});

test("B05: the assembly prompt contains ZERO original message content (sentinel count = 0)", () => {
  const SENT = "ORIGINALTEXTSENTINEL8842";
  const { row } = syntheticEpisode([{ role: "owner", offsetSec: 0, content: `secret ${SENT} words`, messageId: "m-1" }]);
  // assembly input is built from chunk SUMMARIES (model output), never original text
  const chunkSummaries = [chunkOutput({ claims: [{ text: "a neutral fact", kind: "event", evidence_message_ids: ["m-1"] }] })];
  const call = buildAssemblyCall(hdr(row), chunkSummaries, "sha256:" + "0".repeat(64));
  const prompt = renderPrompt(syntheticBundle(), call);
  assert.equal(prompt.split(SENT).length - 1, 0, "sentinel appears zero times in the assembly prompt");
  // the assembly call type carries no unit/content field at all
  assert.ok(!("units" in call));

  // P7 major fix proof: the assembly prompt renders chunk summaries through the
  // SHARED canonical serializer, so — like the assembly fingerprint — its bytes
  // are independent of model-controlled key insertion order.
  const c1 = chunkSummaries[0]!;
  const reKeyed = [{ uncertain_flags: c1.uncertain_flags, confidence: c1.confidence, temporal_hints: c1.temporal_hints, entities: c1.entities, claims: c1.claims.map((cl) => ({ evidence_message_ids: cl.evidence_message_ids, kind: cl.kind, text: cl.text })) }];
  const promptReKeyed = renderPrompt(syntheticBundle(), buildAssemblyCall(hdr(row), reKeyed, "sha256:" + "0".repeat(64)));
  assert.equal(promptReKeyed, prompt, "assembly prompt bytes are key-insertion-order independent (canonical)");
});

test("B06: an unvalidated chunk cannot enter assembly — the type accepts only ChunkModelOutput", () => {
  // Structural guarantee: buildAssemblyCall takes ChunkModelOutput[] (post-validation);
  // the assembly SummaryCall has `chunkSummaries`, never raw units.
  const { row } = syntheticEpisode();
  const call = buildAssemblyCall(hdr(row), [chunkOutput()], "sha256:" + "0".repeat(64));
  assert.equal(call.kind, "assembly");
  if (call.kind === "assembly") {
    assert.equal(call.n, 1);
    assert.ok(Array.isArray(call.chunkSummaries));
    assert.ok(!("units" in call));
  }
});

test("B-header: realm display word resolves au THROUGH the mapping; domain suggestion table is correct", () => {
  const map = { "au-alpha": "AU-ALPHA-DISPLAY", "au-beta": "AU-BETA-DISPLAY" };
  assert.equal(realmDisplayWord("reality", null, map), "现实");
  assert.equal(realmDisplayWord("uncertain", null, map), "层面未定");
  // closure-review B: realm=au returns the DISPLAY LABEL, never the au_id itself
  assert.equal(realmDisplayWord("au", "au-alpha", map), "AU-ALPHA-DISPLAY");
  // unresolvable au (missing key / empty id / empty label) → null (caller fails closed)
  assert.equal(realmDisplayWord("au", "au-missing", map), null);
  assert.equal(realmDisplayWord("au", null, map), null);
  assert.equal(realmDisplayWord("au", "", map), null);
  assert.equal(realmDisplayWord("au", "au-x", { "au-x": "" }), null);
  assert.deepEqual([...DOMAIN_SUGGESTIONS], ["relationship", "project", "planning", "daily", "scene", "proactive", "uncertain", "conflict"]);
});

// --- closure-review B: the AU mapping is the SINGLE display source ---

test("G1A-CR-B: realm=au header/prompt use the mapped display label (not the au_id); an unresolvable au builds no header", () => {
  const map = { "au-alpha": "AU-ALPHA-DISPLAY", "au-beta": "AU-BETA-DISPLAY" };
  const { row, members } = syntheticEpisode(); // realm=au, au_id=au-alpha
  const header = buildMetaHeader(row, map);
  assert.ok(header);
  // the header display word is the LABEL, and the au_id does NOT masquerade as it
  assert.equal(header.realmDisplay, "AU-ALPHA-DISPLAY");
  assert.notEqual(header.realmDisplay, "au-alpha");
  // the prompt first "层面" line carries the mapped label, never the bare au_id
  const prompt = renderPrompt(syntheticBundle(), buildEpisodeCall(header, members));
  assert.match(prompt, /层面: AU-ALPHA-DISPLAY/);
  assert.ok(!/层面: au-alpha(\s|$)/m.test(prompt), "the au_id is not used as the display word");
  // unresolvable au → buildMetaHeader returns null (the orchestrator fails closed)
  assert.equal(buildMetaHeader(row, { "au-beta": "AU-BETA-DISPLAY" }), null); // missing au-alpha
  assert.equal(buildMetaHeader(row, { "au-alpha": "" }), null); // empty label
  assert.equal(buildMetaHeader({ ...row, au_id: null }, map), null); // no au_id on an au row
  // reality / uncertain never depend on the mapping
  assert.ok(buildMetaHeader({ ...row, realm: "reality", au_id: null }, {}));
  assert.ok(buildMetaHeader({ ...row, realm: "uncertain", au_id: null }, {}));
});

// --- G1A Erratum 3A: the chunk prompt declares its own +08 time span ---

test("G1A-3A: each chunk prompt carries THIS block's +08 span (no archive Z); spans track the block's units; unconvertible fails closed", () => {
  const members = syntheticMembers([
    { role: "owner", offsetSec: 0, content: "first message", messageId: "m-1" },
    { role: "companion", offsetSec: 3600, content: "an hour later", messageId: "m-2" },
  ]);
  const [u1, u2] = members.map(renderMessageUnit);
  const hash = "sha256:" + "0".repeat(64);

  const callA = buildChunkCall(1, 2, hash, [u1!]);
  const callB = buildChunkCall(2, 2, hash, [u2!]);
  assert.ok(callA !== null && callB !== null);
  if (callA === null || callB === null || callA.kind !== "chunk" || callB.kind !== "chunk") return;
  // span format: +08 stamp 至 +08 stamp, never the raw archive Z instant
  assert.match(callA.timeSpan, /\+08:00.*至.*\+08:00/s);
  const promptA = renderPrompt(syntheticBundle(), callA);
  const promptB = renderPrompt(syntheticBundle(), callB);
  assert.ok(promptA.includes(`时间: ${callA.timeSpan}`), "chunk prompt renders its own span");
  assert.ok(!promptA.includes("Z]") && !promptA.includes(".000Z"), "no raw archive Z in the chunk prompt");
  // different first/last units → different spans
  assert.notEqual(callA.timeSpan, callB.timeSpan);
  // a two-unit block spans first→last
  const callAB = buildChunkCall(1, 1, hash, [u1!, u2!]);
  assert.ok(callAB !== null && callAB.kind === "chunk");
  if (callAB !== null && callAB.kind === "chunk") {
    assert.equal(callAB.timeSpan.split(" 至 ")[0], callA.timeSpan.split(" 至 ")[0]);
    assert.equal(callAB.timeSpan.split(" 至 ")[1], callB.timeSpan.split(" 至 ")[1]);
  }
  // fail closed: an empty block or an unconvertible timestamp builds NO call (no prompt)
  assert.equal(buildChunkCall(1, 1, hash, []), null);
  const garbage = { ...u1!, timestampUtc: "not-a-timestamp" };
  assert.equal(buildChunkCall(1, 1, hash, [garbage]), null);
});

// --- closure-02-review B: the whole-mapping validity predicate (pure, never throws) ---

test("G1A-CR-B2 (pure): validateAuDisplayMapping accepts a well-formed mapping (incl. empty) and rejects malformed ones without throwing", () => {
  assert.equal(validateAuDisplayMapping({ "au-alpha": "AU-ALPHA-DISPLAY", "au-beta": "AU-BETA-DISPLAY" }), true);
  assert.equal(validateAuDisplayMapping({}), true); // empty resolves no AU — structurally valid, no hidden default
  for (const bad of [undefined, null, 42, "str", ["a"], { "au-alpha": "" }, { "au-alpha": "   " }, { "": "X" }, { "   ": "X" }, { "au-alpha": 7 }]) {
    assert.equal(validateAuDisplayMapping(bad), false, JSON.stringify(bad ?? null));
  }
  // never throws on a throwing proxy
  const proxy = new Proxy({}, { ownKeys() { throw new Error("boom"); }, getOwnPropertyDescriptor() { throw new Error("boom"); } });
  assert.equal(validateAuDisplayMapping(proxy), false);
});

// --- closure-02-review C: validateSummaryCall never throws on any runtime unknown ---

test("G1A-CR-C3 (pure): validateSummaryCall never throws — throwing proxy / nested throwing getter → call_shape_invalid", () => {
  const trap = { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); }, getOwnPropertyDescriptor() { throw new Error("boom"); } };
  assert.deepEqual(validateSummaryCall(new Proxy({}, trap)), { ok: false, code: "call_shape_invalid" });
  const { row, members } = syntheticEpisode();
  const ep = buildEpisodeCall(hdr(row), members);
  const withThrowingHeader = { ...ep, header: new Proxy({}, trap) };
  assert.deepEqual(validateSummaryCall(withThrowingHeader), { ok: false, code: "call_shape_invalid" });
  // deep shape: empty header and malformed unit are rejected
  assert.deepEqual(validateSummaryCall({ ...ep, header: {} }), { ok: false, code: "call_shape_invalid" });
  assert.deepEqual(validateSummaryCall({ ...ep, units: [{}] }), { ok: false, code: "call_shape_invalid" });
  // a well-formed call still passes
  assert.deepEqual(validateSummaryCall(ep), { ok: true });
});

// --- closure-03-review C4: assembly chunkSummaries' INNER items are closed ---

test("G1A-CR-C4 (pure): a normally-serializable smuggled/malformed claim or hint item is rejected by validateSummaryCall itself", () => {
  const { row } = syntheticEpisode();
  const asm = buildAssemblyCall(hdr(row), [chunkOutput()], "sha256:" + "0".repeat(64));
  const invalid = { ok: false, code: "call_shape_invalid" } as const;
  const withSummary = (summary: unknown): unknown => ({ ...asm, chunkSummaries: [summary] });
  const claim = (over: Record<string, unknown>): unknown => ({ ...chunkOutput(), claims: [over] });
  const hint = (over: Record<string, unknown>): unknown => ({ ...chunkOutput(), temporal_hints: [over] });

  // the legal assembly (builder-produced) still passes
  assert.deepEqual(validateSummaryCall(asm), { ok: true });

  // claim: a serializable smuggled field / missing field / non-string evidence item
  assert.deepEqual(validateSummaryCall(withSummary(claim({ text: "x", kind: "event", evidence_message_ids: ["m-1"], smuggled: "MODEL_CONTROLLED_BYTES" }))), invalid);
  assert.deepEqual(validateSummaryCall(withSummary(claim({ text: "x", kind: "event" }))), invalid); // missing evidence_message_ids
  assert.deepEqual(validateSummaryCall(withSummary(claim({ text: "x", kind: "event", evidence_message_ids: [1] }))), invalid); // non-string evidence
  assert.deepEqual(validateSummaryCall(withSummary(claim({ text: 1, kind: "event", evidence_message_ids: ["m-1"] }))), invalid); // non-string text

  // hint: unknown field / missing field / illegal normalized_range / non-finite confidence
  assert.deepEqual(validateSummaryCall(withSummary(hint({ text: "t", message_id: "m-1", normalized_range: null, confidence: 0.5, smuggled: "MCB" }))), invalid);
  assert.deepEqual(validateSummaryCall(withSummary(hint({ text: "t", message_id: "m-1", confidence: 0.5 }))), invalid); // missing normalized_range
  assert.deepEqual(validateSummaryCall(withSummary(hint({ text: "t", message_id: "m-1", normalized_range: 5, confidence: 0.5 }))), invalid); // range not string|null
  assert.deepEqual(validateSummaryCall(withSummary(hint({ text: "t", message_id: "m-1", normalized_range: null, confidence: Number.POSITIVE_INFINITY }))), invalid); // non-finite confidence
  assert.deepEqual(validateSummaryCall(withSummary(hint({ text: "t", message_id: "m-1", normalized_range: null, confidence: Number.NaN }))), invalid);

  // legal inner items (a resolved + an unresolved hint, a normal claim) still pass
  const legalSummary = { claims: [{ text: "a", kind: "event", evidence_message_ids: ["m-1"] }], entities: [], temporal_hints: [{ text: "t", message_id: "m-1", normalized_range: null, confidence: 0.4 }], confidence: 0.7, uncertain_flags: [] };
  assert.deepEqual(validateSummaryCall(withSummary(legalSummary)), { ok: true });
});

// --- G1-B Bundle-02-review Closure A: fewShots reach the model via renderPrompt ---

test("G1-B-CA (renderPrompt): the 5 fewShots appear exactly once in episode + once in assembly, zero in chunk; no placeholder; bundle not mutated", () => {
  const { row, members } = syntheticEpisode();
  const header = hdr(row);
  const markers = ["FSMARK_A1", "FSMARK_B2", "FSMARK_C3", "FSMARK_D4", "FSMARK_E5"];
  const fewShots = markers.map((m, i) => `FS-${i + 1} 示例 ${m}`);
  const frozen = Object.freeze([...fewShots]);
  const bundle = syntheticBundle({ fewShots: frozen });
  const ep = renderPrompt(bundle, buildEpisodeCall(header, members));
  const asm = renderPrompt(bundle, buildAssemblyCall(header, [chunkOutput()], "sha256:" + "0".repeat(64)));
  const ck = renderPrompt(bundle, buildChunkCall(1, 1, "sha256:" + "0".repeat(64), members.map(renderMessageUnit))!);
  for (const m of markers) {
    assert.equal(ep.split(m).length - 1, 1, `episode carries ${m} exactly once`);
    assert.equal(asm.split(m).length - 1, 1, `assembly carries ${m} exactly once`);
    assert.equal(ck.split(m).length - 1, 0, `chunk carries no ${m}`);
  }
  for (const p of [ep, asm, ck]) assert.ok(!p.includes("[此处注入定稿 few-shot"), "no stale placeholder in any rendered prompt");
  assert.deepEqual([...bundle.fewShots], fewShots, "examples sourced only from bundle.fewShots; not mutated");
});

test("G1-B-CA (validateFewShots): non-empty string array passes; empty/non-array/non-string/blank/throwing-proxy fail without throwing", () => {
  assert.equal(validateFewShots(["a", "b"]), true);
  for (const bad of [undefined, null, 42, "s", [], ["ok", ""], ["ok", "   "], ["ok", 7], [{}]]) {
    assert.equal(validateFewShots(bad), false, JSON.stringify(bad ?? null));
  }
  assert.equal(validateFewShots(new Proxy([], { get() { throw new Error("boom"); } })), false);
});

test("G1-B-CA: a one-byte fewShots change moves BOTH the rendered episode prompt and summary_bundle_hash", () => {
  const { row, members } = syntheticEpisode();
  const call = buildEpisodeCall(hdr(row), members);
  const b1 = syntheticBundle({ fewShots: ["EX one", "EX two"] });
  const b2 = syntheticBundle({ fewShots: ["EX one", "EX twox"] });
  assert.notEqual(renderPrompt(b1, call), renderPrompt(b2, call));
  assert.notEqual(summaryBundleHash(b1), summaryBundleHash(b2));
});

// --- G1A Erratum 4C: strict SummaryCall runtime shape guard ---

test("G1A-4C: the SummaryCall guard accepts the three legal kinds and rejects unknown fields / assembly units+content, leaking nothing", () => {
  const { row, members } = syntheticEpisode();
  const episode = buildEpisodeCall(hdr(row), members);
  const chunk = buildChunkCall(1, 1, "sha256:" + "0".repeat(64), members.map(renderMessageUnit))!;
  const assembly = buildAssemblyCall(hdr(row), [chunkOutput()], "sha256:" + "0".repeat(64));

  // the three legal, builder-produced kinds pass
  for (const call of [episode, chunk, assembly]) assert.deepEqual(validateSummaryCall(call), { ok: true });

  // any unknown top-level field is rejected on every kind
  const SENT = "CALLGUARDSENTINEL_4C_88";
  for (const call of [episode, chunk, assembly]) {
    const bad = validateSummaryCall({ ...call, [SENT]: 1 });
    assert.deepEqual(bad, { ok: false, code: "call_shape_invalid" });
  }
  // an assembly call smuggling units or content fails (the closed key set rejects both)
  const withUnits = validateSummaryCall({ ...assembly, units: [`raw ${SENT} text`] });
  const withContent = validateSummaryCall({ ...assembly, content: `raw ${SENT} text` });
  assert.deepEqual(withUnits, { ok: false, code: "call_shape_invalid" });
  assert.deepEqual(withContent, { ok: false, code: "call_shape_invalid" });
  // the failure result is a stable category only — no sentinel, no thrown exception
  for (const r of [withUnits, withContent]) assert.ok(!JSON.stringify(r).includes(SENT));
  // non-object / missing kind / missing required key all fail closed
  assert.deepEqual(validateSummaryCall(null), { ok: false, code: "call_shape_invalid" });
  assert.deepEqual(validateSummaryCall([]), { ok: false, code: "call_shape_invalid" });
  assert.deepEqual(validateSummaryCall({ kind: "wrong" }), { ok: false, code: "call_shape_invalid" });
  const { header, ...noHeader } = episode as unknown as Record<string, unknown>;
  void header;
  assert.deepEqual(validateSummaryCall(noHeader), { ok: false, code: "call_shape_invalid" });
});
