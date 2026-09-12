import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  parseModelJson,
  runValidators,
  sortIssues,
  type ValidatorContext,
} from "../core/services/episode-summary-validation.js";
import type { ChunkModelOutput, EpisodeModelOutput, ValidatorIssue } from "../core/domain/episode-pass2.js";
import { passingEpisodeOutput, syntheticBundle, validatorContext } from "./pass2-fixtures.js";

/**
 * MICRO-ERRATUM-01 B — the repository is found by LANDMARK, never by counting
 * `../`: this same file runs from `tests/` and from `build/tests/`, and no
 * single `../` count is correct for both.
 */
function repoRoot(): string {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (
      existsSync(join(cursor, "package.json")) &&
      existsSync(join(cursor, "core", "services", "episode-summary-validation.ts"))
    ) {
      return cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("repository root landmark not found");
    cursor = parent;
  }
}


/** L1-T03 P4 — V0–V13 deterministic validators (matrix group D). Each validator
 * has a positive and a negative case; plus a hard+soft+annotate combination,
 * stable ordering, deep-freeze no-mutation, and a four-face sentinel check. */

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const ctx = (): ValidatorContext => validatorContext();
const fired = (issues: readonly ValidatorIssue[], id: string): boolean => issues.some((i) => i.validatorId === id);

// --- positive baseline ---

test("D-pass: a well-formed episode output passes with zero issues", () => {
  const c = ctx();
  const run = runValidators(passingEpisodeOutput(c), c);
  assert.equal(run.verdict, "pass");
  assert.deepEqual(run.issues, []);
});

test("parseModelJson: valid JSON parses; malformed returns a stable code, never the raw text", () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { ok: true, value: { a: 1 } });
  const bad = parseModelJson("{not json SENTINELRAW7}");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "malformed_output");
  assert.ok(!JSON.stringify(bad).includes("SENTINELRAW7"));
});

// --- V0 ---

test("V0: unknown field (provenance), missing field, illegal flag, illegal claim kind all hard-fail", () => {
  const c = ctx();
  assert.equal(runValidators({ ...passingEpisodeOutput(c), provenance: {} }, c).verdict, "hard_fail");
  const { summary, ...missing } = passingEpisodeOutput(c);
  void summary;
  assert.equal(runValidators(missing, c).verdict, "hard_fail");
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), uncertain_flags: ["type_mismatch"] }, c).issues, "V0"));
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), claims: [{ text: "x", kind: "wrongkind", evidence_message_ids: ["m-1"] }] }, c).issues, "V0"));

  // P7 major fix proof: a model-supplied unknown KEY NAME is raw model output and
  // must never be echoed into a ValidatorIssue — a stable placeholder path is
  // reported instead, at all three sites (top level, claim shape, hint shape).
  const KEY_SENT = "UNKNOWNKEYSENTINEL_V0_31";
  const topLevel = runValidators({ ...passingEpisodeOutput(c), [KEY_SENT]: 1 }, c);
  assert.equal(topLevel.verdict, "hard_fail");
  assert.ok(!JSON.stringify(topLevel.issues).includes(KEY_SENT), "top-level unknown key never enters issues");
  assert.ok(topLevel.issues.some((i) => i.fieldPath === "$.<unknown>" && i.stableCode === "unknown_field"));
  const inClaim = runValidators({ ...passingEpisodeOutput(c), claims: [{ text: "x", kind: "event", evidence_message_ids: ["m-1"], [KEY_SENT]: 1 }] }, c);
  assert.ok(!JSON.stringify(inClaim.issues).includes(KEY_SENT), "claim-shape unknown key never enters issues");
  assert.ok(inClaim.issues.some((i) => i.fieldPath === "claims[0].<unknown>" && i.stableCode === "unknown_field"));
  const inHint = runValidators({ ...passingEpisodeOutput(c), temporal_hints: [{ text: "x", message_id: "m-1", normalized_range: null, confidence: 0.5, [KEY_SENT]: 1 }] }, c);
  assert.ok(!JSON.stringify(inHint.issues).includes(KEY_SENT), "hint-shape unknown key never enters issues");
  assert.ok(inHint.issues.some((i) => i.fieldPath === "temporal_hints[0].<unknown>" && i.stableCode === "unknown_field"));
});

// --- V0 enum/range enforcement (G1A Erratum 4B) ---

test("V0 4B: domain enum + confidence [0,1] are enforced at V0 for BOTH the episode and the chunk variant", () => {
  const c = ctx();
  const fired0 = (parsed: unknown, cx = c): boolean => runValidators(parsed, cx).issues.some((i) => i.validatorId === "V0");

  // episode branch — unknown domain hard-fails as illegal_enum; legal values pass
  const unknownDomain = runValidators({ ...passingEpisodeOutput(c), domain_suggestion: "notadomain" }, c);
  assert.equal(unknownDomain.verdict, "hard_fail");
  assert.ok(unknownDomain.issues.some((i) => i.validatorId === "V0" && i.fieldPath === "domain_suggestion" && i.stableCode === "illegal_enum"));
  assert.ok(!fired0(passingEpisodeOutput(c))); // legal domain (scene)
  assert.ok(!fired0({ ...passingEpisodeOutput(c), domain_suggestion: "conflict" })); // archive-only value is legal
  assert.ok(!fired0({ ...passingEpisodeOutput(c), domain_suggestion: null }));

  // episode branch — confidence range: -0.01 / 1.01 out_of_range; NaN/Infinity type_error; 0 and 1 legal
  for (const bad of [-0.01, 1.01]) {
    const run = runValidators({ ...passingEpisodeOutput(c), confidence: bad }, c);
    assert.equal(run.verdict, "hard_fail");
    assert.ok(run.issues.some((i) => i.validatorId === "V0" && i.fieldPath === "confidence" && i.stableCode === "out_of_range"), `confidence ${bad}`);
  }
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const run = runValidators({ ...passingEpisodeOutput(c), confidence: bad }, c);
    assert.ok(run.issues.some((i) => i.validatorId === "V0" && i.fieldPath === "confidence" && i.stableCode === "type_error"), `confidence ${bad}`);
  }
  assert.ok(!fired0({ ...passingEpisodeOutput(c), confidence: 0 }));
  assert.ok(!fired0({ ...passingEpisodeOutput(c), confidence: 1 }));

  // hint confidence range (both branches share checkHintShape)
  const hint = (conf: number): unknown => ({ ...passingEpisodeOutput(c), temporal_hints: [{ text: "x", message_id: "m-1", normalized_range: null, confidence: conf }] });
  for (const bad of [-0.01, 1.01]) {
    const run = runValidators(hint(bad), c);
    assert.ok(run.issues.some((i) => i.validatorId === "V0" && i.fieldPath === "temporal_hints[0].confidence" && i.stableCode === "out_of_range"), `hint confidence ${bad}`);
  }

  // chunk branch — an out-of-range chunk confidence must fail at V0 (it would
  // otherwise reach assembly before any T01 payload_schema check)
  const cc = validatorContext({ kind: "chunk", legalRefs: new Set(["m-1", "m-2"]) });
  const chunk = (conf: number): unknown => ({ claims: [{ text: "a fact", kind: "event", evidence_message_ids: ["m-1"] }], entities: [], temporal_hints: [], confidence: conf, uncertain_flags: [] });
  for (const bad of [-0.01, 1.01]) {
    const run = runValidators(chunk(bad), cc);
    assert.equal(run.verdict, "hard_fail");
    assert.ok(run.issues.some((i) => i.validatorId === "V0" && i.fieldPath === "confidence" && i.stableCode === "out_of_range"), `chunk confidence ${bad}`);
  }
  assert.equal(runValidators(chunk(0), cc).verdict, "pass");
  assert.equal(runValidators(chunk(1), cc).verdict, "pass");
});

// --- V1 ---

test("V1: 用户/助手 (or word-boundary user/assistant) in summary/claims hard-fails; clean text passes", () => {
  const c = ctx();
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), summary: `${c.header.timeString}在${c.header.realmDisplay}层面。用户提出想法。第二句结束。` }, c).issues, "V1"));
  assert.ok(!fired(runValidators(passingEpisodeOutput(c), c).issues, "V1"));
});

// --- V2 ---

// G2 ruling 0c5028e8 §3 — narrow T03 erratum: the floor moves 2 → 1 so a
// genuinely single-fact episode is stated in one honest sentence instead of
// being padded with meta-commentary about the transcript. Boundary constants
// only; V0/V1/V3–V13 untouched.
test("V2: body sentence count must be 1–3; zero or four sentences hard-fail", () => {
  const c = ctx();
  const mk = (body: string): EpisodeModelOutput => ({ ...passingEpisodeOutput(c), summary: `${c.header.timeString}在${c.header.realmDisplay}层面。${body}` });
  assert.ok(!fired(runValidators(mk("只有一句。"), c).issues, "V2"), "V2-SPARSE-ONE-SENTENCE-PASS-01");
  assert.ok(fired(runValidators(mk("一。二。三。四。"), c).issues, "V2"), "V2-FOUR-SENTENCE-FAIL-01");
  assert.ok(!fired(runValidators(mk("第一句。第二句。"), c).issues, "V2"));
  assert.ok(!fired(runValidators(mk("一。二。三。"), c).issues, "V2"));
  assert.ok(fired(runValidators(mk(""), c).issues, "V2"), "an empty body is still out of range");
});

// --- V3 ---

test("V3: summary must byte-start with the metadata time string", () => {
  const c = ctx();
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), summary: `在${c.header.realmDisplay}层面。计划已确定。细节已记录。` }, c).issues, "V3"));
  assert.ok(!fired(runValidators(passingEpisodeOutput(c), c).issues, "V3"));
});

// --- V4 ---

test("V4: realm display word must appear in the realm sentence; uncertain needs a scope flag & no AU label", () => {
  const c = ctx();
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), summary: `${c.header.timeString}某个层面。计划已确定。细节已记录。` }, c).issues, "V4"));
  // uncertain header requires the `scope` flag
  const cu = validatorContext({ header: { ...c.header, realm: "uncertain", realmDisplay: "层面未定", auId: null } });
  const uncertainOut: EpisodeModelOutput = { ...passingEpisodeOutput(cu), summary: `${cu.header.timeString}在层面未定中展开。计划已确定。细节已记录。`, uncertain_flags: [] };
  assert.ok(fired(runValidators(uncertainOut, cu).issues, "V4"));
  assert.ok(!fired(runValidators({ ...uncertainOut, uncertain_flags: ["scope"] }, cu).issues, "V4"));

  // G1A Erratum 5 + closure-review B: the uncertain AU-label ban is enforceable — the
  // scan base is the single injected synthetic AU mapping (bundle.auDisplayById),
  // and both the display label (value) and the au_id (key) are AU markers.
  const clean = { ...uncertainOut, uncertain_flags: ["scope"] };
  const withLabel = { ...clean, summary: `${cu.header.timeString}在层面未定中展开。AU-ALPHA-DISPLAY 的痕迹残留。细节已记录。` };
  const labelRun = runValidators(withLabel, cu);
  assert.equal(labelRun.verdict, "hard_fail");
  assert.ok(labelRun.issues.some((i) => i.validatorId === "V4" && i.stableCode === "au_label_in_uncertain"), "display label in uncertain hard-fails");
  const withAuId = { ...clean, summary: `${cu.header.timeString}在层面未定中展开。au-alpha 相关。细节已记录。` };
  assert.ok(runValidators(withAuId, cu).issues.some((i) => i.validatorId === "V4" && i.stableCode === "au_label_in_uncertain"), "the au_id itself is an AU marker too");
  // clean uncertain (scope, no AU marker) still passes V4
  assert.ok(!fired(runValidators(clean, cu).issues, "V4"));
  // realm=au keeps USING its display word (V4 requires it) — the ban is uncertain-only
  assert.ok(!fired(runValidators(passingEpisodeOutput(c), c).issues, "V4"));
});

// --- V5 ---

test("V5: a prediction-blacklist term in a claim hard-fails; clean claims pass", () => {
  const c = ctx();
  const bad = { ...passingEpisodeOutput(c), claims: [{ text: "PREDICT-NEXT 我们会去", kind: "event", evidence_message_ids: ["m-1"] }] };
  assert.ok(fired(runValidators(bad, c).issues, "V5"));
  assert.ok(!fired(runValidators(passingEpisodeOutput(c), c).issues, "V5"));
});

// --- V6 ---

test("V6: a sensitivity-lexicon hit in original text REQUIRES intimate; normal under-classification hard-fails", () => {
  const c = validatorContext({ memberText: new Map([["m-1", "we discussed SENS-INTIMATE-A privately"], ["m-2", "ok"]]) });
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), sensitivity: "normal" }, c).issues, "V6"));
  // declaring intimate satisfies V6; effective sensitivity is intimate
  const ok = runValidators({ ...passingEpisodeOutput(c), sensitivity: "intimate" }, c);
  assert.equal(ok.verdict, "pass");
  if (ok.verdict === "pass") assert.equal(ok.effectiveSensitivity, "intimate");
});

// --- V7 (annotate transform) ---

test("V7: non-empty uncertain_flags caps summary_confidence to ≤0.5; empty flags leave it untouched", () => {
  const c = validatorContext({ header: { ...ctx().header, realm: "uncertain", realmDisplay: "层面未定", auId: null } });
  const out: EpisodeModelOutput = { ...passingEpisodeOutput(c), summary: `${c.header.timeString}在层面未定中展开。计划已确定。细节已记录。`, uncertain_flags: ["scope"], confidence: 0.9 };
  const run = runValidators(out, c);
  assert.equal(run.verdict, "pass");
  if (run.verdict === "pass") {
    assert.equal((run.output as EpisodeModelOutput).confidence, 0.5);
    assert.ok(fired(run.issues, "V7"));
  }
  // no flags → no cap
  const run2 = runValidators(passingEpisodeOutput(ctx()), ctx());
  if (run2.verdict === "pass") assert.equal((run2.output as EpisodeModelOutput).confidence, 0.8);
});

// --- V8 (soft prune) ---

test("V8: entities not in source (or relative-time words) are soft-pruned; the hit word never appears in the issue", () => {
  const c = ctx();
  const out = { ...passingEpisodeOutput(c), entities: ["trip", "GHOSTENTITY9", "REL-LASTNIGHT"] };
  const run = runValidators(out, c);
  assert.equal(run.verdict, "pass"); // soft, not fatal
  if (run.verdict === "pass") {
    assert.deepEqual((run.output as EpisodeModelOutput).entities, ["trip"]);
    assert.equal(run.diagnostics.prunedEntities, 2);
  }
  assert.ok(fired(run.issues, "V8"));
  assert.ok(!JSON.stringify(run.issues).includes("GHOSTENTITY9"), "pruned word must not leak into issues");
});

// --- V9 ---

test("V9: empty or >20-char model title hard-fails; a short clean title passes", () => {
  const c = ctx();
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), title: "" }, c).issues, "V9"));
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), title: "标".repeat(21) }, c).issues, "V9"));
  assert.ok(!fired(runValidators(passingEpisodeOutput(c), c).issues, "V9"));
});

// --- V10 (annotate) ---

test("V10: a domain_suggestion differing from the effective Pass1 domain appends type_mismatch (not fatal)", () => {
  const c = ctx(); // pass1Domain = scene
  const run = runValidators({ ...passingEpisodeOutput(c), domain_suggestion: "project" }, c);
  assert.equal(run.verdict, "pass");
  if (run.verdict === "pass") {
    assert.ok((run.output as EpisodeModelOutput).uncertain_flags.includes("type_mismatch"));
    assert.deepEqual(run.diagnostics.appendedFlags, ["type_mismatch"]);
  }
  assert.ok(fired(run.issues, "V10"));
});

// --- V11 ---

test("V11: empty claims / empty evidence / non-member evidence / bad slice ordinal all hard-fail", () => {
  const c = validatorContext({ sliceOrdinals: new Map([["m-1", new Set([1, 2])]]) });
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), claims: [] }, c).issues, "V11"));
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), claims: [{ text: "x", kind: "event", evidence_message_ids: [] }] }, c).issues, "V11"));
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), claims: [{ text: "x", kind: "event", evidence_message_ids: ["m-999"] }] }, c).issues, "V11"));
  assert.ok(fired(runValidators({ ...passingEpisodeOutput(c), claims: [{ text: "x", kind: "event", evidence_message_ids: ["m-1#slice_9"] }] }, c).issues, "V11"));
  // a valid slice ref passes
  assert.ok(!fired(runValidators({ ...passingEpisodeOutput(c), claims: [{ text: "x", kind: "event", evidence_message_ids: ["m-1#slice_2"] }] }, c).issues, "V11"));
});

// --- V12 (soft prune / normalize / warn) ---

test("V12: prune/normalize/warn; a kept null-range hint warns (Erratum B) without dropping resolved hints", () => {
  // m-1 text carries BOTH a normalizable term (REL-LASTNIGHT) and a non-normalizable
  // one (REL-SOON). REL-SOON is a legal member substring but resolves to no range.
  const c = validatorContext({ memberText: new Map([["m-1", "we did it REL-LASTNIGHT and will REL-SOON follow up"], ["m-2", "ok"]]) });
  const out: EpisodeModelOutput = deepFreeze({
    ...passingEpisodeOutput(c),
    temporal_hints: [
      { text: "REL-LASTNIGHT", message_id: "m-1", normalized_range: null, confidence: 0.2 }, // normalizable → resolved
      { text: "REL-SOON", message_id: "m-1", normalized_range: null, confidence: 0.4 }, // non-normalizable, kept null → warn
      { text: "not in text", message_id: "m-1", normalized_range: null, confidence: 0.5 }, // pruned (not substring)
      { text: "x", message_id: "m-999", normalized_range: null, confidence: 0.5 }, // pruned (not member)
    ],
  });
  const run = runValidators(out, c);
  const run2 = runValidators(out, c);
  assert.deepEqual(run, run2, "V12 is deterministic across two runs");
  assert.equal(run.verdict, "pass");
  if (run.verdict === "pass") {
    const hints = (run.output as EpisodeModelOutput).temporal_hints;
    // one resolved (normalizable) + one legitimately unresolved (null range) are kept; two pruned.
    assert.equal(hints.length, 2);
    const resolved = hints.find((h) => h.confidence === 1.0)!;
    assert.match(resolved.normalized_range ?? "", /\+08:00$/); // normalizable → recomputed range
    const unresolved = hints.find((h) => h.normalized_range === null)!;
    assert.ok(unresolved, "the non-normalizable hint is KEPT with a null range, not fabricated");
    assert.equal(run.diagnostics.prunedHints, 2);
  }
  assert.ok(fired(run.issues, "V12"));
  // the unresolved-range warn is observable in the evidence (annotate), and it does NOT
  // demote the run — one unresolved hint never drops the resolved ones.
  const warn = run.issues.find((i) => i.stableCode === "hint_unresolved_range_warn");
  assert.ok(warn && warn.severity === "annotate" && warn.validatorId === "V12");
  // stable code/field only — no hint body text leaks into any issue
  assert.ok(!JSON.stringify(run.issues).includes("REL-SOON"), "hint text must not appear in issues");
  assert.deepEqual(out.temporal_hints[1], { text: "REL-SOON", message_id: "m-1", normalized_range: null, confidence: 0.4 }, "input hint not mutated");
});

// --- closure-review A: V8 chunk-visible text vs V12 whole-message text ---

test("G1A-CR-A: V8 uses chunk-VISIBLE text while V12 compares against the WHOLE message (03R2 V12 base)", () => {
  // The two bases DIFFER on purpose: the visible slice is a prefix of the whole
  // message. An entity that lives only in the hidden tail is V8-pruned, while a
  // temporal hint whose text is in the hidden tail is KEPT by V12.
  const visible = new Map([["m-1", "VISIBLEPART only"]]);
  const whole = new Map([["m-1", "VISIBLEPART only REL-SOON HIDDENENTITY tail"]]);
  const c = validatorContext({ kind: "chunk", legalRefs: new Set(["m-1"]), memberIds: new Set(["m-1"]), visibleText: visible, fullMessageText: whole, memberTimestamps: new Map([["m-1", "2099-01-02T12:00:00.000Z"]]), metadataLabels: [] });
  const out: ChunkModelOutput = {
    claims: [{ text: "a fact", kind: "event", evidence_message_ids: ["m-1"] }],
    entities: ["HIDDENENTITY"], // only in the hidden tail
    temporal_hints: [{ text: "REL-SOON", message_id: "m-1", normalized_range: null, confidence: 0.4 }], // text in the hidden tail
    confidence: 0.6,
    uncertain_flags: [],
  };
  const run = runValidators(out, c);
  const run2 = runValidators(out, c);
  assert.deepEqual(run, run2, "deterministic");
  assert.equal(run.verdict, "pass"); // both are soft/annotate, not hard
  if (run.verdict === "pass") {
    const o = run.output as ChunkModelOutput;
    // V8: the entity is NOT in the visible text → soft-pruned
    assert.deepEqual(o.entities, []);
    assert.equal(run.diagnostics.prunedEntities, 1);
    assert.ok(run.issues.some((i) => i.validatorId === "V8" && i.stableCode === "entity_not_in_source_pruned"));
    // V12: the hint text IS a substring of the WHOLE message → KEPT (not mis-pruned)
    assert.equal(o.temporal_hints.length, 1, "V12 compares against the whole message, not the visible slice");
    assert.ok(!run.issues.some((i) => i.stableCode === "hint_text_not_substring_pruned"), "the hint is not wrongly pruned");
  }
  // neither the hidden entity nor the hint text leaks into the issues
  assert.ok(!JSON.stringify(run.issues).includes("HIDDENENTITY") && !JSON.stringify(run.issues).includes("REL-SOON"));
});

test("G1A-CR-A: V12 still soft-prunes a non-member id / illegal slice ordinal (03R2 unchanged), never hard-fails", () => {
  // Whole-message base does NOT weaken the member / slice-ordinal gates.
  const whole = new Map([["m-1", "some REL-SOON content here"]]);
  const c = validatorContext({ kind: "chunk", legalRefs: new Set(["m-1"]), memberIds: new Set(["m-1"]), visibleText: whole, fullMessageText: whole, memberTimestamps: new Map([["m-1", "2099-01-02T12:00:00.000Z"]]), sliceOrdinals: new Map([["m-1", new Set([1, 2])]]), metadataLabels: [] });
  const out: ChunkModelOutput = {
    claims: [{ text: "a fact", kind: "event", evidence_message_ids: ["m-1"] }],
    temporal_hints: [
      { text: "REL-SOON", message_id: "m-999", normalized_range: null, confidence: 0.5 }, // non-member → prune
      { text: "REL-SOON", message_id: "m-1#slice_9", normalized_range: null, confidence: 0.5 }, // illegal ordinal → prune
    ],
    entities: [],
    confidence: 0.6,
    uncertain_flags: [],
  };
  const run = runValidators(out, c);
  assert.equal(run.verdict, "pass"); // soft prune, never hard
  if (run.verdict === "pass") {
    assert.equal((run.output as ChunkModelOutput).temporal_hints.length, 0);
    assert.equal(run.diagnostics.prunedHints, 2);
    assert.ok(run.issues.some((i) => i.validatorId === "V12" && i.stableCode === "hint_not_member_pruned"));
    assert.ok(run.issues.some((i) => i.validatorId === "V12" && i.stableCode === "hint_bad_slice_pruned"));
  }
});

// --- V13 ---

test("V13: a relative-time word anywhere in the summary hard-fails (quotes not exempt)", () => {
  const c = ctx();
  const bad = { ...passingEpisodeOutput(c), summary: `${c.header.timeString}在${c.header.realmDisplay}层面。REL-LASTNIGHT 发生了事。第二句结束。` };
  assert.ok(fired(runValidators(bad, c).issues, "V13"));
  assert.ok(!fired(runValidators(passingEpisodeOutput(c), c).issues, "V13"));
});

// --- combination: hard + soft + annotate simultaneously ---

test("D-combo: hard (V5) + soft (V8) + annotate (V10) all fire together; verdict hard_fail; issues sorted", () => {
  const c = ctx();
  const out = deepFreeze({
    ...passingEpisodeOutput(c),
    claims: [{ text: "PREDICT-NEXT plan", kind: "event", evidence_message_ids: ["m-1"] }], // V5 hard
    entities: ["trip", "GHOSTENTITY9"], // V8 soft prune
    domain_suggestion: "project", // V10 annotate (pass1Domain=scene)
  });
  const run = runValidators(out, c);
  assert.equal(run.verdict, "hard_fail");
  if (run.verdict === "hard_fail") assert.equal(run.firstHardValidatorId, "V5");
  const sev = new Set(run.issues.map((i) => i.severity));
  assert.ok(sev.has("hard") && sev.has("soft") && sev.has("annotate"), "all three severities present");
  assert.deepEqual(run.issues, sortIssues(run.issues), "issues are in canonical order");
  // ordering: V5 < V8 < V10 by validator number
  const order = run.issues.map((i) => Number(i.validatorId.slice(1)));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

// --- purity / no mutation ---

test("purity: deep-frozen input and context are never mutated (no throw), result is independent", () => {
  const c = deepFreeze(validatorContext({ memberText: new Map([["m-1", "we planned the trip REL-LASTNIGHT"], ["m-2", "ok"]]) }));
  const out = deepFreeze({
    ...passingEpisodeOutput(c as ValidatorContext),
    entities: ["trip", "GHOSTENTITY9"],
    temporal_hints: [{ text: "REL-LASTNIGHT", message_id: "m-1", normalized_range: null, confidence: 0.3 }],
    domain_suggestion: "project",
    uncertain_flags: [] as string[],
  });
  // deep-frozen: any in-place mutation would throw. Two runs must be identical.
  const a = runValidators(out, c as ValidatorContext);
  const b = runValidators(out, c as ValidatorContext);
  assert.deepEqual(a, b);
  // the transformed output is a NEW object, input arrays untouched
  if (a.verdict === "pass") {
    assert.notEqual((a.output as EpisodeModelOutput).entities, out.entities);
    assert.deepEqual(out.entities, ["trip", "GHOSTENTITY9"]); // original unchanged
  }
});

// --- four output faces (Erratum): runtime stdout + stderr capture, not just JSON/MD ---

test("4-face runtime: a unique sentinel is 0 in captured stdout, stderr, JSON, and Markdown; validators emit nothing", () => {
  const SENT = "UNIQSENTINEL4FACE90X"; // one unique synthetic sentinel across every face
  const c = validatorContext({ memberText: new Map([["m-1", `planned ${SENT} trip near coast`], ["m-2", "ok"]]) });

  // Capture BOTH console.* and the raw process.*.write channels.
  type W = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const orig = {
    log: console.log,
    error: console.error,
    info: console.info,
    warn: console.warn,
    debug: console.debug,
    out: process.stdout.write.bind(process.stdout),
    err: process.stderr.write.bind(process.stderr),
  };
  let out = "";
  let err = "";
  let json = "";
  let md = "";
  try {
    console.log = console.info = console.warn = console.debug = (...a: unknown[]): void => {
      out += a.map(String).join(" ") + "\n";
    };
    console.error = (...a: unknown[]): void => {
      err += a.map(String).join(" ") + "\n";
    };
    (process.stdout as unknown as W).write = (chunk: unknown): boolean => {
      out += String(chunk);
      return true;
    };
    (process.stderr as unknown as W).write = (chunk: unknown): boolean => {
      err += String(chunk);
      return true;
    };

    // parseModelJson + the hard(V5)+soft(V8)+annotate(V10) combination path, with the
    // sentinel present in the model claim text (raw output) AND in original text.
    const parsed = parseModelJson(
      JSON.stringify({
        ...passingEpisodeOutput(c),
        claims: [{ text: `PREDICT-NEXT ${SENT}`, kind: "event", evidence_message_ids: ["m-1"] }],
        entities: ["GHOSTENTITY", SENT],
        domain_suggestion: "project",
      }),
    );
    if (parsed.ok) {
      const run = runValidators(parsed.value, c);
      json = JSON.stringify(run);
      md = run.issues.map((i) => `| ${i.validatorId} | ${i.fieldPath} | ${i.stableCode} | ${i.severity} |`).join("\n");
    }
  } finally {
    // Restore EVERY global output function so no other test is polluted.
    console.log = orig.log;
    console.error = orig.error;
    console.info = orig.info;
    console.warn = orig.warn;
    console.debug = orig.debug;
    (process.stdout as unknown as W).write = orig.out as unknown as W["write"];
    (process.stderr as unknown as W).write = orig.err as unknown as W["write"];
  }

  // validators must have emitted nothing at all…
  assert.equal(out, "", "validators produced no stdout");
  assert.equal(err, "", "validators produced no stderr");
  // …and the sentinel is absent from each of the four faces, asserted separately.
  assert.ok(!out.includes(SENT), "stdout carries no sentinel");
  assert.ok(!err.includes(SENT), "stderr carries no sentinel");
  assert.ok(!json.includes(SENT) && !json.includes("PREDICT-NEXT"), "JSON carries no sentinel/hit-word");
  assert.ok(!md.includes(SENT) && !md.includes("PREDICT-NEXT"), "Markdown carries no sentinel/hit-word");
  assert.ok(json.length > 0 && md.length > 0, "the combination path actually ran");
});

test("source scan: the validator module references no console / process.stdout / process.stderr / env channel", () => {
  const src = readFileSync(join(repoRoot(), "core/services/episode-summary-validation.ts"), "utf8");
  assert.ok(!/\bconsole\s*\./.test(src), "no console.* in the validator source");
  assert.ok(!/process\s*\.\s*stdout/.test(src), "no process.stdout");
  assert.ok(!/process\s*\.\s*stderr/.test(src), "no process.stderr");
  assert.ok(!/process\s*\.\s*env/.test(src), "no process.env");
  assert.ok(!/Date\s*\.\s*now|Math\s*\.\s*random/.test(src), "no clock/random");
});
