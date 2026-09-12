import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DeterministicEpisodeSummarizer } from "../core/services/deterministic-episode-summarizer.js";
import { validateEpisodePayload } from "../core/domain/episode-validation.js";
import { buildAssemblyCall, buildChunkCall, buildEpisodeCall, buildMetaHeader, renderMessageUnit, validateSummaryCall } from "../core/services/episode-summary-input.js";
import { planChunks } from "../core/services/episode-summary-chunking.js";
import { runValidators, type ValidatorContext } from "../core/services/episode-summary-validation.js";
import { guardedPortCall, runPass2Core, type Pass2CoreInput } from "../core/services/episode-summary-core.js";
import type { EpisodeMetaHeader, Pass2Config, RenderedUnit, SummaryCall } from "../core/domain/episode-pass2.js";
import type { Pass1Episode } from "../core/domain/episode-pass1.js";
import type { EpisodeSummarizerPort, EpisodeSummaryRequest, EpisodeSummaryResult } from "../core/ports/episode-summarizer.js";
import { chunkOutput, syntheticBundle, syntheticConfig, syntheticEpisode, syntheticManifest, type MemberSpec } from "./pass2-fixtures.js";

// The header is resolved through the bundle's single AU-display mapping
// (closure-review B); this helper resolves the synthetic row (au-alpha → label).
const AU_MAP = syntheticBundle().auDisplayById;
const mkHeader = (row: Pass1Episode): EpisodeMetaHeader => {
  const h = buildMetaHeader(row, AU_MAP);
  assert.ok(h, "synthetic row resolves through the AU mapping");
  return h;
};

/** L1-T03 P5 — core orchestration end-to-end (matrix group E). Synthetic stub;
 * realModelCalls ≡ 0; no DB / real model / real transcript. */

function validEpisodeJson(header: EpisodeMetaHeader, evId = "m-1"): string {
  return JSON.stringify({
    title: "行程记录",
    summary: `${header.timeString}在${header.realmDisplay}层面展开。计划已确定。细节已记录。`,
    claims: [{ text: "计划已确定", kind: "decision", evidence_message_ids: [evId] }],
    entities: [],
    temporal_hints: [],
    domain_suggestion: "scene",
    sensitivity: "normal",
    confidence: 0.8,
    uncertain_flags: [],
  });
}

function validChunkJson(evId: string): string {
  return JSON.stringify({ claims: [{ text: "一个事实", kind: "event", evidence_message_ids: [evId] }], entities: [], temporal_hints: [], confidence: 0.7, uncertain_flags: [] });
}

const idFromPrompt = (prompt: string): string => /\[(m-\d+)[\]#]/.exec(prompt)?.[1] ?? "m-0";

interface StubOpts {
  header: EpisodeMetaHeader;
  episode?: (req: EpisodeSummaryRequest) => EpisodeSummaryResult;
  chunk?: (req: EpisodeSummaryRequest) => EpisodeSummaryResult;
  assembly?: (req: EpisodeSummaryRequest) => EpisodeSummaryResult;
  throwOn?: "episode" | "chunk" | "assembly";
  /** Adversarial exception name — must never surface (Erratum A). */
  throwName?: string;
  /** Adversarial exception message — must never surface. */
  throwMessage?: string;
}

function mkStub(o: StubOpts): DeterministicEpisodeSummarizer {
  return new DeterministicEpisodeSummarizer({
    respond: (req) => {
      if (o.throwOn === req.kind) {
        const e = new Error(o.throwMessage ?? "boom");
        if (o.throwName !== undefined) e.name = o.throwName;
        throw e;
      }
      if (req.kind === "episode") return o.episode?.(req) ?? { ok: true, rawJson: validEpisodeJson(o.header), servedModel: null };
      if (req.kind === "chunk") return o.chunk?.(req) ?? { ok: true, rawJson: validChunkJson(idFromPrompt(req.prompt)), servedModel: null };
      return o.assembly?.(req) ?? { ok: true, rawJson: validEpisodeJson(o.header, "m-0"), servedModel: null };
    },
  });
}

function mkInput(members: MemberSpec[], chunkMax: number, stub: DeterministicEpisodeSummarizer, cfgOverrides = {}): { input: Pass2CoreInput; header: EpisodeMetaHeader } {
  const { row, members: mems } = syntheticEpisode(members);
  const header = mkHeader(row);
  const bundle = syntheticBundle();
  return {
    input: { row, members: mems, bundle, manifest: syntheticManifest(bundle), config: syntheticConfig({ chunkMax, ...cfgOverrides }), port: stub },
    header,
  };
}

const REG: MemberSpec[] = [
  { role: "owner", offsetSec: 0, content: "we planned the trip", messageId: "m-1" },
  { role: "companion", offsetSec: 60, content: "noted it", messageId: "m-2" },
];
const CHUNKED: MemberSpec[] = [
  { role: "owner", offsetSec: 0, content: "msg zero", messageId: "m-0" },
  { role: "companion", offsetSec: 60, content: "msg one", messageId: "m-1" },
  { role: "owner", offsetSec: 120, content: "msg two", messageId: "m-2" },
];

// --- E01 / E02 regular path ---

test("E01: regular path — valid model output yields a candidate; one episode call, no chunk/assembly", async () => {
  const header = mkHeader(syntheticEpisode(REG).row);
  const stub = mkStub({ header });
  const { input } = mkInput(REG, 500, stub);
  const r = await runPass2Core(input);
  assert.equal(r.status, "candidate");
  assert.deepEqual(stub.calls.map((c) => c.kind), ["episode"]);
});

test("E02: regular path — a hard validator failure pends validation_failed + the V id, no candidate", async () => {
  const header = mkHeader(syntheticEpisode(REG).row);
  // V3 fail: summary lacks the time prefix
  const stub = mkStub({ header, episode: () => ({ ok: true, rawJson: JSON.stringify({ title: "x", summary: "在现实层面。一句。二句。", claims: [{ text: "a", kind: "event", evidence_message_ids: ["m-1"] }], entities: [], temporal_hints: [], domain_suggestion: null, sensitivity: "normal", confidence: 0.5, uncertain_flags: [] }), servedModel: null }) });
  const { input } = mkInput(REG, 500, stub);
  const r = await runPass2Core(input);
  assert.equal(r.status, "pending");
  if (r.status === "pending") {
    assert.equal(r.reason, "validation_failed");
    assert.equal(r.detail.code, "V3");
  }
});

// --- E03 / E04 / E05 chunked path ---

test("E03: chunked path — N chunk calls + exactly 1 assembly call → candidate", async () => {
  const header = mkHeader(syntheticEpisode(CHUNKED).row);
  const stub = mkStub({ header });
  const { input } = mkInput(CHUNKED, 40, stub);
  const r = await runPass2Core(input);
  assert.equal(r.status, "candidate");
  const kinds = stub.calls.map((c) => c.kind);
  assert.equal(kinds.filter((k) => k === "chunk").length, 3);
  assert.equal(kinds.filter((k) => k === "assembly").length, 1);
  assert.deepEqual(kinds, ["chunk", "chunk", "chunk", "assembly"]);
});

test("E04: a single chunk failure pends the whole episode with ZERO assembly calls (no partial stitch)", async () => {
  const header = mkHeader(syntheticEpisode(CHUNKED).row);
  let n = 0;
  const stub = mkStub({
    header,
    chunk: (req) => {
      n += 1;
      // second chunk fails V11 (empty claims)
      if (n === 2) return { ok: true, rawJson: JSON.stringify({ claims: [], entities: [], temporal_hints: [], confidence: 0.5, uncertain_flags: [] }), servedModel: null };
      return { ok: true, rawJson: validChunkJson(idFromPrompt(req.prompt)), servedModel: null };
    },
  });
  const { input } = mkInput(CHUNKED, 40, stub);
  const r = await runPass2Core(input);
  assert.equal(r.status, "pending");
  if (r.status === "pending") {
    assert.equal(r.reason, "validation_failed");
    assert.equal(r.detail.code, "V11");
    assert.equal(r.detail.location, "chunk:2/3");
  }
  assert.equal(stub.calls.filter((c) => c.kind === "assembly").length, 0, "assembly must not be called");
});

test("E05: an assembly hard failure pends validation_failed with an assembly location", async () => {
  const header = mkHeader(syntheticEpisode(CHUNKED).row);
  const stub = mkStub({ header, assembly: () => ({ ok: true, rawJson: JSON.stringify({ title: "x", summary: "缺少时间前缀。一句。二句。", claims: [{ text: "a", kind: "event", evidence_message_ids: ["m-0"] }], entities: [], temporal_hints: [], domain_suggestion: null, sensitivity: "normal", confidence: 0.5, uncertain_flags: [] }), servedModel: null }) });
  const { input } = mkInput(CHUNKED, 40, stub);
  const r = await runPass2Core(input);
  assert.equal(r.status, "pending");
  if (r.status === "pending") {
    assert.equal(r.reason, "validation_failed");
    assert.equal(r.detail.location, "assembly");
  }
});

// --- E06 / E07 candidate + provenance ---

test("E06: the candidate passes the T01 validator; a null-range hint is omitted while the resolved hint survives (Erratum B)", async () => {
  const members: MemberSpec[] = [
    { role: "owner", offsetSec: 0, content: "we met REL-LASTNIGHT and will REL-SOON regroup", messageId: "m-1" },
    { role: "companion", offsetSec: 60, content: "noted it", messageId: "m-2" },
  ];
  const header = mkHeader(syntheticEpisode(members).row);
  const rawJson = JSON.stringify({
    title: "行程记录",
    summary: `${header.timeString}在${header.realmDisplay}层面展开。计划已确定。细节已记录。`,
    claims: [{ text: "计划已确定", kind: "decision", evidence_message_ids: ["m-1"] }],
    entities: [],
    temporal_hints: [
      { text: "REL-LASTNIGHT", message_id: "m-1", normalized_range: null, confidence: 0.3 }, // normalizable → resolved range
      { text: "REL-SOON", message_id: "m-1", normalized_range: null, confidence: 0.4 }, // non-normalizable → kept null → omitted from candidate
    ],
    domain_suggestion: "scene",
    sensitivity: "normal",
    confidence: 0.8,
    uncertain_flags: [],
  });
  const r = await runPass2Core(mkInput(members, 500, mkStub({ header, episode: () => ({ ok: true, rawJson, servedModel: null }) })).input);
  assert.equal(r.status, "candidate");
  if (r.status === "candidate") {
    assert.ok(validateEpisodePayload(r.payload).ok, "candidate passes the T01 validator");
    // only the resolved hint reaches the T01 payload; the null-range hint is omitted, not fabricated
    assert.equal(r.payload.temporal_hints.length, 1);
    assert.match(r.payload.temporal_hints[0]!.normalized_range, /\+08:00$/);
    // the omission is observable in evidence as a V12 unresolved-range warn
    assert.ok(r.diagnostics.warns.some((w) => w.includes("hint_unresolved_range_warn")), "the unresolved hint warns");
  }
});

test("E07: provenance is pipeline-only (row + config); a model that emits provenance is rejected by V0", async () => {
  const { row } = syntheticEpisode(REG);
  const header = mkHeader(row);
  const { input } = mkInput(REG, 500, mkStub({ header }));
  const r = await runPass2Core(input);
  assert.equal(r.status, "candidate");
  if (r.status === "candidate") {
    const p = r.payload.provenance;
    assert.equal(p.source_hash, row.source_hash);
    assert.equal(p.effective_realm, row.realm);
    assert.equal(p.effective_au_id, row.au_id);
    assert.equal(p.effective_domain, row.domain);
    assert.equal(p.source_basis, "model");
    assert.equal(p.created_at, input.config.createdAt);
    assert.equal(p.generator?.model, input.config.modelId);
    assert.equal(p.generator?.summary_version, input.config.summaryVersion);
    assert.equal(p.generator?.projection_version, input.config.indexVersion);
  }
  // model output carrying provenance → V0 unknown field → pending
  const bad = mkStub({ header, episode: () => ({ ok: true, rawJson: JSON.stringify({ ...JSON.parse(validEpisodeJson(header)), provenance: {} }), servedModel: null }) });
  const r2 = await runPass2Core(mkInput(REG, 500, bad).input);
  assert.equal(r2.status, "pending");
  if (r2.status === "pending") assert.equal(r2.detail.code, "V0");
});

// --- E08 no mutation ---

test("E08: any result leaves the Pass1 row & members deep-equal (no mutation)", async () => {
  const { row, members } = syntheticEpisode(REG);
  const header = mkHeader(row);
  const rowBefore = structuredClone(row);
  const membersBefore = structuredClone(members);
  await runPass2Core({ row, members, bundle: syntheticBundle(), manifest: syntheticManifest(syntheticBundle()), config: syntheticConfig({ chunkMax: 500 }), port: mkStub({ header }) });
  assert.deepEqual(row, rowBefore);
  assert.deepEqual(members, membersBefore);
});

// --- E09 synthetic DB sentinel (isolated temp dir; never a live DB) ---

test("E09: a synthetic sentinel DB file is byte-identical (SHA unchanged) before/after a run — the pure core opens no DB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pass2-e09-"));
  try {
    const dbPath = join(dir, "synthetic-sentinel.sqlite3");
    writeFileSync(dbPath, "SYNTHETIC-SENTINEL-DB-NOT-A-REAL-DATABASE\n");
    const sha = (): string => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const before = sha();
    const header = mkHeader(syntheticEpisode(CHUNKED).row);
    await runPass2Core(mkInput(CHUNKED, 30, mkStub({ header })).input); // exercise the chunked+assembly path too
    assert.equal(sha(), before, "the pure core wrote to no DB file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- E10 realModelCalls = 0 + provider/CLI/vendor/DB source scan clean ---

test("E10: realModelCalls stays 0 and the Pass2 core sources scan clean of provider/CLI/vendor/DB/persistence", async () => {
  const { row, members } = syntheticEpisode(REG);
  const header = mkHeader(row);
  const stub = mkStub({ header });
  await runPass2Core({ row, members, bundle: syntheticBundle(), manifest: syntheticManifest(syntheticBundle()), config: syntheticConfig({ chunkMax: 500 }), port: stub });
  assert.equal(stub.realModelCalls, 0);
  for (const rel of ["episode-summary-core.ts", "episode-summary-validation.ts", "episode-summary-input.ts", "episode-summary-chunking.ts", "episode-summary-bundle.ts"]) {
    const src = readFileSync(new URL(`../../core/services/${rel}`, import.meta.url), "utf8");
    assert.ok(!/node:sqlite|DatabaseSync|EpisodesProjectionDb|episode-pass1-writer|writePass1|generated_payload|published_payload/.test(src), `${rel}: no DB/persistence`);
    assert.ok(!/\bfetch\s*\(|node:https?\b|child_process|execSync|spawnSync|Anthropic|OpenAI/.test(src), `${rel}: no provider/CLI/network/vendor`);
    assert.ok(!/\bconsole\s*\.|process\s*\.\s*(stdout|stderr|env)|Date\s*\.\s*now|Math\s*\.\s*random/.test(src), `${rel}: no console/env/clock/random`);
  }
});

// --- G1A Erratum 1: chunk-level evidence boundary (sliced message across ≥3 chunks) ---

const SLICE_SENT = "TAILSENTINEL_G1A_E1";
const SLICED: MemberSpec[] = [{ role: "owner", offsetSec: 0, content: "z".repeat(150) + SLICE_SENT, messageId: "m-1" }];
const SLICE_CFG = { chunkMax: 60 };

/** Chunk stub whose FIRST chunk call uses `firstChunkRefs`; later chunks reference their own first visible slice ref. */
function sliceStub(header: EpisodeMetaHeader, firstChunkRefs: string[] | null): DeterministicEpisodeSummarizer {
  let n = 0;
  const ownRef = (prompt: string): string => /\[(m-1#slice_\d+)\//.exec(prompt)?.[1] ?? "m-1";
  return new DeterministicEpisodeSummarizer({
    respond: (req) => {
      if (req.kind === "chunk") {
        n += 1;
        const refs = n === 1 && firstChunkRefs !== null ? firstChunkRefs : [ownRef(req.prompt)];
        return { ok: true, rawJson: JSON.stringify({ claims: [{ text: "一个事实", kind: "event", evidence_message_ids: refs }], entities: [], temporal_hints: [], confidence: 0.7, uncertain_flags: [] }), servedModel: null };
      }
      // assembly: reference a ref that is provably in the chunk-claim union
      const unionRef = /m-1#slice_\d+/.exec(req.prompt)?.[0] ?? "m-1";
      return { ok: true, rawJson: validEpisodeJson(header, unionRef), servedModel: null };
    },
  });
}

test("G1A-E1: a chunk referencing ANOTHER chunk's (globally valid) slice hard-fails V11 with zero assembly calls; nothing leaks", async () => {
  const { row, members } = syntheticEpisode(SLICED);
  const header = mkHeader(row);
  const plan = planChunks(members, syntheticConfig(SLICE_CFG));
  assert.equal(plan.kind, "chunked");
  if (plan.kind !== "chunked") return;
  assert.ok(plan.chunks.length >= 3, "the sliced message spans at least 3 chunks");
  const chunk3Ref = plan.chunks[2]!.units[0]!.refId; // globally valid ordinal — but NOT chunk 1's

  const stub = sliceStub(header, [chunk3Ref]);
  type W = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const orig = { log: console.log, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  let out = "";
  let err = "";
  let r;
  try {
    console.log = (...a: unknown[]): void => { out += a.map(String).join(" "); };
    console.error = (...a: unknown[]): void => { err += a.map(String).join(" "); };
    (process.stdout as unknown as W).write = (c: unknown): boolean => { out += String(c); return true; };
    (process.stderr as unknown as W).write = (c: unknown): boolean => { err += String(c); return true; };
    r = await runPass2Core({ row, members, bundle: syntheticBundle(), manifest: syntheticManifest(syntheticBundle()), config: syntheticConfig(SLICE_CFG), port: stub });
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    (process.stdout as unknown as W).write = orig.out as unknown as W["write"];
    (process.stderr as unknown as W).write = orig.err as unknown as W["write"];
  }
  assert.equal(r.status, "pending");
  if (r.status === "pending") {
    assert.equal(r.reason, "validation_failed");
    assert.equal(r.detail.code, "V11");
    assert.equal(r.detail.location, `chunk:1/${plan.chunks.length}`);
  }
  assert.equal(stub.calls.filter((c) => c.kind === "assembly").length, 0, "assembly never runs");
  // failure faces carry no member content and no evidence ref
  const json = JSON.stringify(r);
  const md = r.status === "pending" ? `| ${r.status} | ${r.reason} | ${r.detail.code} | ${r.detail.location ?? ""} |` : "";
  for (const face of [out, err, json, md]) {
    assert.ok(!face.includes(SLICE_SENT), "no member content on any face");
    assert.ok(!face.includes("#slice_"), "no evidence ref on any failure face");
  }
  assert.equal(out, "");
  assert.equal(err, "");
});

test("G1A-E1: a bare message_id cannot stand in for a sliced message — hard fail, no assembly", async () => {
  const { row, members } = syntheticEpisode(SLICED);
  const header = mkHeader(row);
  const stub = sliceStub(header, ["m-1"]); // bare id, though chunk 1 holds only slices
  const r = await runPass2Core({ row, members, bundle: syntheticBundle(), manifest: syntheticManifest(syntheticBundle()), config: syntheticConfig(SLICE_CFG), port: stub });
  assert.equal(r.status, "pending");
  if (r.status === "pending") {
    assert.equal(r.reason, "validation_failed");
    assert.equal(r.detail.code, "V11");
  }
  assert.equal(stub.calls.filter((c) => c.kind === "assembly").length, 0);
});

test("G1A-E1: chunks referencing their OWN slices pass end-to-end into a candidate; V8's whitelist is chunk-local", async () => {
  const { row, members } = syntheticEpisode(SLICED);
  const header = mkHeader(row);
  const stub = sliceStub(header, null); // every chunk uses its own first slice ref
  const r = await runPass2Core({ row, members, bundle: syntheticBundle(), manifest: syntheticManifest(syntheticBundle()), config: syntheticConfig(SLICE_CFG), port: stub });
  assert.equal(r.status, "candidate", "own-slice evidence is legal");

  // V8 chunk-local whitelist: the tail sentinel exists ONLY in the last chunk's
  // visible content. Contexts are built per chunk exactly like the orchestrator's
  // rule (units-only), so the entity prunes in chunk 1 and survives in the last.
  const plan = planChunks(members, syntheticConfig(SLICE_CFG));
  assert.equal(plan.kind, "chunked");
  if (plan.kind !== "chunked") return;
  const byId = new Map(members.map((m) => [m.messageId, m] as const));
  const localCtx = (units: readonly RenderedUnit[]): ValidatorContext => {
    const visible = new Map<string, string>();
    const full = new Map<string, string>();
    for (const u of units) {
      visible.set(u.bareMessageId, (visible.get(u.bareMessageId) ?? "") + u.content); // chunk-local (V8)
      full.set(u.bareMessageId, byId.get(u.bareMessageId)?.contentNfc ?? ""); // whole message (V6/V12)
    }
    return {
      kind: "chunk",
      header,
      memberIds: new Set(units.map((u) => u.bareMessageId)),
      visibleText: visible,
      fullMessageText: full,
      memberTimestamps: new Map(units.map((u) => [u.bareMessageId, u.timestampUtc])),
      sliceOrdinals: new Map(), // V12 slice check not exercised here
      legalRefs: new Set(units.map((u) => u.refId)),
      metadataLabels: [],
      bundle: syntheticBundle(),
      pass1Domain: row.domain,
      assemblyEvidenceUnion: null,
    };
  };
  const first = plan.chunks[0]!;
  const last = plan.chunks[plan.chunks.length - 1]!;
  // The probe entity is the LAST chunk's exact visible content (slices may split
  // the tail sentinel, so the entity is derived from the plan, not assumed): it
  // is a substring of the last chunk's visible text and — carrying tail
  // sentinel characters — of no earlier all-"z" chunk.
  const probeEntity = last.units.map((u) => u.content).join("");
  const chunkOut = (ref: string): unknown => ({ claims: [{ text: "一个事实", kind: "event", evidence_message_ids: [ref] }], entities: [probeEntity], temporal_hints: [], confidence: 0.7, uncertain_flags: [] });
  const firstRun = runValidators(chunkOut(first.units[0]!.refId), localCtx(first.units));
  assert.equal(firstRun.verdict, "pass");
  if (firstRun.verdict === "pass") {
    assert.equal(firstRun.diagnostics.prunedEntities, 1, "entity visible only in a later chunk is pruned here (soft)");
    assert.ok(firstRun.issues.some((i) => i.validatorId === "V8" && i.stableCode === "entity_not_in_source_pruned"));
    assert.ok(!JSON.stringify(firstRun.issues).includes(probeEntity), "the pruned entity text never enters the issues");
  }
  const lastRun = runValidators(chunkOut(last.units[0]!.refId), localCtx(last.units));
  assert.equal(lastRun.verdict, "pass");
  if (lastRun.verdict === "pass") assert.equal(lastRun.diagnostics.prunedEntities, 0, "the same entity survives where its text is actually visible");
});

// --- closure-02-review A: the V8/V12 split proven on the REAL runPass2Core path ---

test("G1A-CR-A-e2e: a ≥3-chunk message through real runPass2Core prunes a chunk-only entity (V8) yet keeps a whole-message hint (V12); the assembly port sees the split, no whole text", async () => {
  const HID = "HIDDENENTSENT"; // entity present in the whole message but NOT chunk 1's visible slice
  const RAW = "RAWONLYSENT"; // raw whole-message text that no model output ever references
  // one long message: leading a-run (chunk 1's visible slice), then the hint word
  // + hidden entity, then a b-run, then the raw-only tail.
  const content = "a".repeat(40) + " REL-SOON " + HID + " MIDDLE " + "b".repeat(30) + " " + RAW;
  const SLICED_A: MemberSpec[] = [{ role: "owner", offsetSec: 0, content, messageId: "m-1" }];
  const CFG = { chunkMax: 46, maxChunks: 64 };
  const { row, members } = syntheticEpisode(SLICED_A);
  const header = mkHeader(row);
  const plan = planChunks(members, syntheticConfig(CFG));
  assert.equal(plan.kind, "chunked");
  if (plan.kind !== "chunked") return;
  assert.ok(plan.chunks.length >= 3, "the message spans ≥3 chunks");
  const chunk1Ref = plan.chunks[0]!.units[0]!.refId; // m-1#slice_1
  assert.ok(!plan.chunks[0]!.units.map((u) => u.content).join("").includes("REL-SOON"), "chunk 1's visible slice does not contain the hint word");
  assert.ok(!plan.chunks[0]!.units.map((u) => u.content).join("").includes(HID), "…nor the hidden entity");

  const ownRef = (prompt: string): string => /\[(m-1#slice_\d+)\//.exec(prompt)?.[1] ?? "m-1";
  let assemblyPrompt = "";
  const stub = new DeterministicEpisodeSummarizer({
    respond: (req) => {
      if (req.kind === "chunk") {
        const ordinal = Number(/块: (\d+)\//.exec(req.prompt)?.[1] ?? "0");
        if (ordinal === 1) {
          // chunk 1 emits a chunk-only entity (V8 must prune) + a whole-message hint (V12 must keep)
          return { ok: true, rawJson: JSON.stringify({ claims: [{ text: "一个事实", kind: "event", evidence_message_ids: [chunk1Ref] }], entities: [HID], temporal_hints: [{ text: "REL-SOON", message_id: chunk1Ref, normalized_range: null, confidence: 0.4 }], confidence: 0.7, uncertain_flags: [] }), servedModel: null };
        }
        return { ok: true, rawJson: JSON.stringify({ claims: [{ text: "一个事实", kind: "event", evidence_message_ids: [ownRef(req.prompt)] }], entities: [], temporal_hints: [], confidence: 0.7, uncertain_flags: [] }), servedModel: null };
      }
      assemblyPrompt = req.prompt; // capture the REAL assembly prompt
      return { ok: true, rawJson: validEpisodeJson(header, chunk1Ref), servedModel: null };
    },
  });

  type W = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const orig = { log: console.log, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  let out = "";
  let err = "";
  let r;
  try {
    console.log = (...a: unknown[]): void => { out += a.map(String).join(" "); };
    console.error = (...a: unknown[]): void => { err += a.map(String).join(" "); };
    (process.stdout as unknown as W).write = (c: unknown): boolean => { out += String(c); return true; };
    (process.stderr as unknown as W).write = (c: unknown): boolean => { err += String(c); return true; };
    r = await runPass2Core({ row, members, bundle: syntheticBundle(), manifest: syntheticManifest(syntheticBundle()), config: syntheticConfig(CFG), port: stub });
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    (process.stdout as unknown as W).write = orig.out as unknown as W["write"];
    (process.stderr as unknown as W).write = orig.err as unknown as W["write"];
  }
  assert.equal(r.status, "candidate", "the whole episode reaches a candidate");

  // The REAL assembly prompt (built from the validated chunk JSON) proves the split:
  assert.ok(assemblyPrompt.length > 0, "assembly ran");
  assert.ok(assemblyPrompt.includes("REL-SOON"), "V12 KEPT the whole-message hint → it reaches assembly");
  assert.ok(!assemblyPrompt.includes(HID), "V8 PRUNED the chunk-only entity → it never reaches assembly");
  assert.ok(!assemblyPrompt.includes(RAW), "raw whole-message text never enters assembly");
  assert.ok(!assemblyPrompt.includes("a".repeat(40)) && !assemblyPrompt.includes("b".repeat(30)), "no original slice content in assembly");

  // Five result faces carry neither the pruned entity nor the raw-only sentinel nor the (null-range, filtered) hint.
  const json = JSON.stringify(r);
  const md = r.status === "candidate" ? `| candidate | ${r.diagnostics.notes.join(",")} |` : "";
  const typed = r.status === "candidate" ? ["candidate", ...r.diagnostics.notes, ...r.diagnostics.warns].join("|") : "";
  for (const [name, face] of [["stdout", out], ["stderr", err], ["json", json], ["markdown", md], ["typed", typed]] as const) {
    for (const s of [HID, RAW, "REL-SOON"]) assert.ok(!face.includes(s), `${name} must not carry ${s}`);
  }
  assert.equal(out, "");
  assert.equal(err, "");
});

// --- G1A Erratum 2: version-coherence gate (config == bundle == manifest == row) ---

test("G1A-E2: any single incoherent summary/index version pends with a stable code and ZERO port calls; the coherent path is unchanged", async () => {
  const build = (cfgOverrides: Partial<Pass2Config>, rowOverrides: Partial<Pass1Episode>, manifestVersion?: string): { input: Pass2CoreInput; stub: DeterministicEpisodeSummarizer } => {
    const { row, members } = syntheticEpisode(REG, rowOverrides);
    const header = mkHeader(row);
    const stub = mkStub({ header });
    const bundle = syntheticBundle();
    const manifest = manifestVersion === undefined ? syntheticManifest(bundle) : { ...syntheticManifest(bundle), summaryVersion: manifestVersion };
    return { input: { row, members, bundle, manifest, config: syntheticConfig({ chunkMax: 500, ...cfgOverrides }), port: stub }, stub };
  };

  const cases: Array<{ name: string; cfg: Partial<Pass2Config>; row: Partial<Pass1Episode>; manifest?: string; code: string }> = [
    { name: "config summaryVersion", cfg: { summaryVersion: "sum-other" }, row: {}, code: "summary_version_incoherent" },
    { name: "row summary_version", cfg: {}, row: { summary_version: "sum-other" }, code: "summary_version_incoherent" },
    { name: "manifest summaryVersion", cfg: {}, row: {}, manifest: "sum-other", code: "summary_version_mismatch" },
    { name: "config indexVersion", cfg: { indexVersion: "p1-vX" }, row: {}, code: "index_version_incoherent" },
    { name: "row index_version", cfg: {}, row: { index_version: "p1-vX" }, code: "index_version_incoherent" },
  ];
  for (const c of cases) {
    const { input, stub } = build(c.cfg, c.row, c.manifest);
    const r = await runPass2Core(input);
    assert.equal(r.status, "pending", c.name);
    if (r.status === "pending") {
      assert.equal(r.reason, "validation_failed", c.name);
      assert.equal(r.detail.code, c.code, c.name);
      // the stable category never echoes either raw version value
      assert.ok(!JSON.stringify(r).includes("sum-other") && !JSON.stringify(r).includes("p1-vX"), c.name);
    }
    assert.equal(stub.calls.length, 0, `${c.name}: zero port calls`);
  }

  // the all-equal path still yields the same candidate, provenance from the verified row
  const { input, stub } = build({}, {});
  const r = await runPass2Core(input);
  assert.equal(r.status, "candidate");
  if (r.status === "candidate") {
    assert.equal(r.payload.provenance.generator?.summary_version, input.row.summary_version);
    assert.equal(r.payload.provenance.generator?.projection_version, input.row.index_version);
  }
  assert.ok(stub.calls.length > 0);
});

// --- G1A Erratum 4A: adapter-controlled errorKind cannot cross the runtime guard ---

test("G1A-4A: a non-member errorKind from the adapter collapses to unexpected_exception; the sentinel is 0 on all five faces", async () => {
  const KIND_SENT = "EVIL_ERRORKIND_SENTINEL_4A";
  const DETAIL_SENT = "EVIL_DETAIL_SENTINEL_4A";
  const header = mkHeader(syntheticEpisode(REG).row);
  const stub = new DeterministicEpisodeSummarizer({
    respond: () => ({ ok: false, errorKind: KIND_SENT, detail: DETAIL_SENT } as unknown as EpisodeSummaryResult),
  });
  const { input } = mkInput(REG, 500, stub);

  type W = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const orig = { log: console.log, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  let out = "";
  let err = "";
  let r;
  try {
    console.log = (...a: unknown[]): void => { out += a.map(String).join(" "); };
    console.error = (...a: unknown[]): void => { err += a.map(String).join(" "); };
    (process.stdout as unknown as W).write = (c: unknown): boolean => { out += String(c); return true; };
    (process.stderr as unknown as W).write = (c: unknown): boolean => { err += String(c); return true; };
    r = await runPass2Core(input);
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    (process.stdout as unknown as W).write = orig.out as unknown as W["write"];
    (process.stderr as unknown as W).write = orig.err as unknown as W["write"];
  }
  assert.equal(r.status, "pending");
  if (r.status === "pending") {
    assert.equal(r.reason, "model_error");
    assert.equal(r.detail.code, "unexpected_exception"); // sealed collapse — never the adapter string
  }
  const json = JSON.stringify(r);
  const md = r.status === "pending" ? `| ${r.status} | ${r.reason} | ${r.detail.code} |` : "";
  const typed = r.status === "pending" ? [r.status, r.reason, r.detail.code].join("|") : "";
  for (const face of [out, err, json, md, typed]) {
    assert.ok(!face.includes(KIND_SENT), "errorKind sentinel never surfaces");
    assert.ok(!face.includes(DETAIL_SENT), "detail sentinel never surfaces");
  }
  assert.equal(out, "");
  assert.equal(err, "");
});

// --- closure-review B: the AU mapping is the single display source (orchestrator) ---

test("G1A-CR-B: realm=au uses the mapped display label end-to-end; an unresolvable au pends before any port call", async () => {
  // coherent path: the candidate is produced and the episode prompt used the LABEL
  const { row, members } = syntheticEpisode(REG); // realm=au / au-alpha
  const header = mkHeader(row);
  const seen: string[] = [];
  const stub = new DeterministicEpisodeSummarizer({
    respond: (req) => {
      seen.push(req.prompt);
      return { ok: true, rawJson: validEpisodeJson(header), servedModel: null };
    },
  });
  const r = await runPass2Core({ row, members, bundle: syntheticBundle(), manifest: syntheticManifest(syntheticBundle()), config: syntheticConfig({ chunkMax: 500 }), port: stub });
  assert.equal(r.status, "candidate");
  assert.ok(seen[0]!.includes("层面: AU-ALPHA-DISPLAY"), "prompt used the mapped display label");
  assert.ok(!/层面: au-alpha(\s|$)/m.test(seen[0]!), "not the bare au_id");

  // A VALID table whose active au_id simply isn't a key → au_display_unresolved
  // (distinct from "whole table invalid"). An empty/whitespace label makes the
  // WHOLE table invalid → au_display_mapping_invalid (see G1A-CR-B2).
  const cases: Array<{ map: Record<string, string>; code: string }> = [
    { map: { "au-beta": "AU-BETA-DISPLAY" }, code: "au_display_unresolved" }, // valid table, active key absent
    { map: { "au-alpha": "" }, code: "au_display_mapping_invalid" }, // empty value → whole table invalid
  ];
  for (const c of cases) {
    const bundle = syntheticBundle({ auDisplayById: c.map });
    const stub2 = mkStub({ header });
    const r2 = await runPass2Core({ row, members, bundle, manifest: syntheticManifest(bundle), config: syntheticConfig({ chunkMax: 500 }), port: stub2 });
    assert.equal(r2.status, "pending");
    if (r2.status === "pending") {
      assert.equal(r2.reason, "validation_failed");
      assert.equal(r2.detail.code, c.code);
    }
    assert.equal(stub2.calls.length, 0, "zero port calls");
    assert.ok(!JSON.stringify(r2).includes("au-alpha") && !JSON.stringify(r2).includes("au-beta"), "no au id/label echoed");
  }
});

// --- closure-02-review B: the WHOLE-mapping runtime validity gate ---

test("G1A-CR-B2: a malformed auDisplayById (missing/null/array/whitespace key or value) pends au_display_mapping_invalid via real runPass2Core, 0 port calls, 5 faces clean", async () => {
  const SENT = "AUMAPSENTINEL_B2";
  const { row, members } = syntheticEpisode(REG);
  const header = mkHeader(row);
  // runtime-cast injections the type system forbids but an adapter could produce
  const injections: Array<{ label: string; map: unknown }> = [
    { label: "missing-property", map: undefined },
    { label: "null", map: null },
    { label: "array", map: [`${SENT}`] },
    { label: "primitive", map: 42 },
    { label: "whitespace-key", map: { "   ": "AU-ALPHA-DISPLAY" } },
    { label: "empty-key", map: { "": "AU-ALPHA-DISPLAY" } },
    { label: "whitespace-value", map: { "au-alpha": `   ` } },
    { label: "nonstring-value", map: { "au-alpha": 7 } },
  ];

  type W = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const orig = { log: console.log, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  let out = "";
  let err = "";
  try {
    console.log = (...a: unknown[]): void => { out += a.map(String).join(" "); };
    console.error = (...a: unknown[]): void => { err += a.map(String).join(" "); };
    (process.stdout as unknown as W).write = (c: unknown): boolean => { out += String(c); return true; };
    (process.stderr as unknown as W).write = (c: unknown): boolean => { err += String(c); return true; };
    for (const inj of injections) {
      const bundle = { ...syntheticBundle(), auDisplayById: inj.map as Record<string, string> };
      const stub = mkStub({ header });
      // the manifest need not match — the mapping gate runs before the hash gate
      const r = await runPass2Core({ row, members, bundle, manifest: syntheticManifest(syntheticBundle()), config: syntheticConfig({ chunkMax: 500 }), port: stub });
      assert.equal(r.status, "pending", inj.label);
      if (r.status === "pending") {
        assert.equal(r.reason, "validation_failed", inj.label);
        assert.equal(r.detail.code, "au_display_mapping_invalid", inj.label);
      }
      assert.equal(stub.calls.length, 0, `${inj.label}: zero port calls`);
      const json = JSON.stringify(r);
      const md = r.status === "pending" ? `| ${r.reason} | ${r.detail.code} |` : "";
      const typed = r.status === "pending" ? [r.reason, r.detail.code].join("|") : "";
      for (const face of [json, md, typed]) assert.ok(!face.includes(SENT), `${inj.label}: face leaked`);
    }
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    (process.stdout as unknown as W).write = orig.out as unknown as W["write"];
    (process.stderr as unknown as W).write = orig.err as unknown as W["write"];
  }
  assert.equal(out, "");
  assert.equal(err, "");
  // an empty mapping {} is structurally valid (resolves no AU, no hidden default):
  // a realm=au row then pends au_display_unresolved, NOT mapping_invalid
  const emptyBundle = syntheticBundle({ auDisplayById: {} });
  const emptyStub = mkStub({ header });
  const rEmpty = await runPass2Core({ row, members, bundle: emptyBundle, manifest: syntheticManifest(emptyBundle), config: syntheticConfig({ chunkMax: 500 }), port: emptyStub });
  assert.equal(rEmpty.status, "pending");
  if (rEmpty.status === "pending") assert.equal(rEmpty.detail.code, "au_display_unresolved");
});

// --- closure-review C1: callPort collapses any contract-violating port result ---

test("G1A-CR-C1: null/undefined/primitive/bad-ok/non-string-rawJson/throwing-getter port results all collapse to unexpected_exception; 5 faces clean; no throw", async () => {
  const SENT = "PORTRESULTSENTINEL_C1";
  const malformedPort = (result: unknown): EpisodeSummarizerPort => ({
    name: "malformed",
    probeServedModel: async () => ({ servedModel: null }),
    summarize: async () => result as EpisodeSummaryResult,
  });
  const throwingOk: Record<string, unknown> = {};
  Object.defineProperty(throwingOk, "ok", { get() { throw new Error(`ok-getter ${SENT}`); }, enumerable: true });
  const throwingRaw: Record<string, unknown> = { ok: true };
  Object.defineProperty(throwingRaw, "rawJson", { get() { throw new Error(`raw-getter ${SENT}`); }, enumerable: true });
  const cases: Array<{ label: string; result: unknown }> = [
    { label: "null", result: null },
    { label: "undefined", result: undefined },
    { label: "primitive-number", result: 42 },
    { label: "primitive-string", result: `str ${SENT}` },
    { label: "ok-not-boolean", result: { ok: "yes", detail: SENT } },
    { label: "ok-true-nonstring-rawJson", result: { ok: true, rawJson: 123 } },
    { label: "ok-true-missing-rawJson", result: { ok: true } },
    { label: "ok-false-nonmember-kind", result: { ok: false, errorKind: `EVIL ${SENT}`, detail: `d ${SENT}` } },
    { label: "throwing-ok-getter", result: throwingOk },
    { label: "throwing-rawJson-getter", result: throwingRaw },
  ];

  type W = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const orig = { log: console.log, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  let out = "";
  let err = "";
  try {
    console.log = (...a: unknown[]): void => { out += a.map(String).join(" "); };
    console.error = (...a: unknown[]): void => { err += a.map(String).join(" "); };
    (process.stdout as unknown as W).write = (c: unknown): boolean => { out += String(c); return true; };
    (process.stderr as unknown as W).write = (c: unknown): boolean => { err += String(c); return true; };
    for (const c of cases) {
      const { row, members } = syntheticEpisode(REG);
      const r = await runPass2Core({ row, members, bundle: syntheticBundle(), manifest: syntheticManifest(syntheticBundle()), config: syntheticConfig({ chunkMax: 500 }), port: malformedPort(c.result) });
      assert.equal(r.status, "pending", c.label);
      if (r.status === "pending") {
        assert.equal(r.reason, "model_error", c.label);
        assert.equal(r.detail.code, "unexpected_exception", c.label);
      }
      const json = JSON.stringify(r);
      const md = r.status === "pending" ? `| ${r.reason} | ${r.detail.code} |` : "";
      const typed = r.status === "pending" ? [r.reason, r.detail.code].join("|") : "";
      for (const face of [json, md, typed]) assert.ok(!face.includes(SENT), `${c.label}: face leaked`);
    }
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    (process.stdout as unknown as W).write = orig.out as unknown as W["write"];
    (process.stderr as unknown as W).write = orig.err as unknown as W["write"];
  }
  assert.equal(out, "", "no stdout across every malformed case");
  assert.equal(err, "", "no stderr across every malformed case");
});

// --- closure-review C2: the guard→render→port seam, exercised for real ---

test("G1A-CR-C2: the guardedPortCall seam rejects tampered calls (call_shape_invalid, 0 port, 5-face clean) and passes legal ones (1 port call)", async () => {
  const SENT = "SEAMSENTINEL_C2";
  const { row, members } = syntheticEpisode(REG);
  const header = mkHeader(row);
  const bundle = syntheticBundle();
  const legal: Record<string, SummaryCall> = {
    episode: buildEpisodeCall(header, members),
    chunk: buildChunkCall(1, 1, "sha256:" + "0".repeat(64), members.map(renderMessageUnit))!,
    assembly: buildAssemblyCall(header, [chunkOutput()], "sha256:" + "0".repeat(64)),
  };
  const tampered: SummaryCall[] = [
    { ...legal["episode"], [SENT]: 1 } as unknown as SummaryCall,
    { ...legal["chunk"], [SENT]: 1 } as unknown as SummaryCall,
    { ...legal["assembly"], units: [`raw ${SENT} text`] } as unknown as SummaryCall, // assembly must never carry units
    { ...legal["assembly"], content: `raw ${SENT} text` } as unknown as SummaryCall, // …or content
  ];

  type W = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const orig = { log: console.log, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  let out = "";
  let err = "";
  const faces: string[] = [];
  try {
    console.log = (...a: unknown[]): void => { out += a.map(String).join(" "); };
    console.error = (...a: unknown[]): void => { err += a.map(String).join(" "); };
    (process.stdout as unknown as W).write = (c: unknown): boolean => { out += String(c); return true; };
    (process.stderr as unknown as W).write = (c: unknown): boolean => { err += String(c); return true; };
    // legal calls pass through the seam and make exactly one port call each
    for (const call of Object.values(legal)) {
      const stub = mkStub({ header });
      const g = await guardedPortCall(bundle, call, stub, "synthetic-model-x");
      assert.ok(g.ok, `legal ${call.kind} passes the guard`);
      assert.equal(stub.calls.length, 1, `legal ${call.kind}: exactly one port call`);
    }
    // tampered calls are rejected BEFORE the port — zero calls, stable category
    for (const call of tampered) {
      const stub = mkStub({ header });
      const g = await guardedPortCall(bundle, call, stub, "synthetic-model-x");
      assert.equal(g.ok, false);
      if (!g.ok) {
        assert.equal(g.reason, "validation_failed");
        assert.equal(g.code, "call_shape_invalid");
      }
      assert.equal(stub.calls.length, 0, "no render, no port call on a tampered shape");
      faces.push(JSON.stringify(g));
    }
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    (process.stdout as unknown as W).write = orig.out as unknown as W["write"];
    (process.stderr as unknown as W).write = orig.err as unknown as W["write"];
  }
  // 5 faces: stdout, stderr, and each tampered typed/JSON result carry no sentinel
  assert.equal(out, "");
  assert.equal(err, "");
  for (const f of faces) assert.ok(!f.includes(SENT), "no tampered-call content on any result face");
});

// --- closure-02-review C: DEEP malformed shapes never throw in the seam ---

test("G1A-CR-C3: empty header / malformed unit / throwing getter / cyclic|BigInt chunk summary / throwing Proxy all collapse to call_shape_invalid via the real seam, 0 port, 5-face clean, no throw", async () => {
  const SENT = "DEEPSEAMSENTINEL_C3";
  const { row, members } = syntheticEpisode(REG);
  const header = mkHeader(row);
  const bundle = syntheticBundle();
  const legalEpisode = buildEpisodeCall(header, members);
  const legalUnit = renderMessageUnit(members[0]!);
  const legalAssembly = buildAssemblyCall(header, [chunkOutput()], "sha256:" + "0".repeat(64));

  // a unit whose `line` getter throws (would throw in render if it reached it)
  const throwingLineUnit: Record<string, unknown> = { ...legalUnit };
  Object.defineProperty(throwingLineUnit, "line", { get() { throw new Error(`line ${SENT}`); }, enumerable: true });
  // a chunk summary that passes the shallow shape but whose claim carries a cycle / BigInt (throws in canonicalJson)
  const cyclicClaim: Record<string, unknown> = { text: "x", kind: "event", evidence_message_ids: [] };
  cyclicClaim["self"] = cyclicClaim;
  const cyclicSummary = { claims: [cyclicClaim], entities: [], temporal_hints: [], confidence: 0.5, uncertain_flags: [] };
  const bigintSummary = { claims: [{ text: "x", kind: "event", evidence_message_ids: [], big: 1n }], entities: [], temporal_hints: [], confidence: 0.5, uncertain_flags: [] };
  // closure-03-review C4: a NORMALLY-SERIALIZABLE smuggled nested field (would
  // canonicalJson fine and reach the port before this fix) — must be rejected by
  // the guard itself, not by a render throw.
  const smuggledClaimSummary = { claims: [{ text: "x", kind: "event", evidence_message_ids: ["m-1"], smuggled: SENT }], entities: [], temporal_hints: [], confidence: 0.5, uncertain_flags: [] };
  const smuggledHintSummary = { claims: [{ text: "x", kind: "event", evidence_message_ids: ["m-1"] }], entities: [], temporal_hints: [{ text: "t", message_id: "m-1", normalized_range: null, confidence: 0.4, smuggled: SENT }], confidence: 0.5, uncertain_flags: [] };
  // a throwing top-level Proxy and a throwing nested (header) Proxy
  const throwTrap = { get() { throw new Error(`proxy ${SENT}`); }, ownKeys() { throw new Error(`proxy ${SENT}`); }, getOwnPropertyDescriptor() { throw new Error(`proxy ${SENT}`); } };
  const topProxy = new Proxy({}, throwTrap);
  const nestedHeaderProxy = { ...legalEpisode, header: new Proxy({}, throwTrap) };

  const malformed: Array<{ label: string; call: unknown; guardRejects: boolean }> = [
    { label: "empty-header", call: { ...legalEpisode, header: {} }, guardRejects: true },
    { label: "malformed-unit", call: { ...legalEpisode, units: [{}] }, guardRejects: true },
    { label: "throwing-line-getter", call: { ...legalEpisode, units: [throwingLineUnit] }, guardRejects: true },
    { label: "cyclic-chunk-summary", call: { ...legalAssembly, n: 1, chunkSummaries: [cyclicSummary] }, guardRejects: true },
    { label: "bigint-chunk-summary", call: { ...legalAssembly, n: 1, chunkSummaries: [bigintSummary] }, guardRejects: true },
    { label: "smuggled-claim-field", call: { ...legalAssembly, n: 1, chunkSummaries: [smuggledClaimSummary] }, guardRejects: true },
    { label: "smuggled-hint-field", call: { ...legalAssembly, n: 1, chunkSummaries: [smuggledHintSummary] }, guardRejects: true },
    { label: "throwing-top-proxy", call: topProxy, guardRejects: true },
    { label: "throwing-nested-header-proxy", call: nestedHeaderProxy, guardRejects: true },
  ];

  type W = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const orig = { log: console.log, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  let out = "";
  let err = "";
  const faces: string[] = [];
  try {
    console.log = (...a: unknown[]): void => { out += a.map(String).join(" "); };
    console.error = (...a: unknown[]): void => { err += a.map(String).join(" "); };
    (process.stdout as unknown as W).write = (c: unknown): boolean => { out += String(c); return true; };
    (process.stderr as unknown as W).write = (c: unknown): boolean => { err += String(c); return true; };
    for (const m of malformed) {
      // C4: the strict guard ITSELF rejects every case (no dependence on a render throw)
      if (m.guardRejects) assert.equal(validateSummaryCall(m.call as SummaryCall).ok, false, `${m.label}: guard rejects directly`);
      const stub = mkStub({ header });
      // must NOT throw/reject — guardedPortCall absorbs every pre-port exception
      const g = await guardedPortCall(bundle, m.call as SummaryCall, stub, "synthetic-model-x");
      assert.equal(g.ok, false, m.label);
      if (!g.ok) {
        assert.equal(g.reason, "validation_failed", m.label);
        assert.equal(g.code, "call_shape_invalid", m.label);
      }
      assert.equal(stub.calls.length, 0, `${m.label}: zero port calls`);
      faces.push(JSON.stringify(g));
    }
    // legal calls STILL pass with exactly one port call each (behavior unchanged)
    for (const call of [legalEpisode, buildChunkCall(1, 1, "sha256:" + "0".repeat(64), members.map(renderMessageUnit))!, legalAssembly]) {
      const stub = mkStub({ header });
      const g = await guardedPortCall(bundle, call, stub, "synthetic-model-x");
      assert.ok(g.ok, `legal ${call.kind} still passes`);
      assert.equal(stub.calls.length, 1, `legal ${call.kind}: one port call`);
    }
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    (process.stdout as unknown as W).write = orig.out as unknown as W["write"];
    (process.stderr as unknown as W).write = orig.err as unknown as W["write"];
  }
  assert.equal(out, "");
  assert.equal(err, "");
  for (const f of faces) assert.ok(!f.includes(SENT), "no getter/proxy exception text on any result face");
});

// --- G1-B Bundle-02-review Closure A: fewShots reach episode+assembly port prompts ---

const FS_MARKERS = ["FSMARK_A1", "FSMARK_B2", "FSMARK_C3", "FSMARK_D4", "FSMARK_E5"];
const FS = FS_MARKERS.map((m, i) => `FS-${i + 1} 示例 ${m}`);

async function captureFsPrompts(specs: MemberSpec[], chunkMax: number): Promise<{ status: string; cap: Record<string, string[]> }> {
  const cap: Record<string, string[]> = { episode: [], chunk: [], assembly: [] };
  const { row, members } = syntheticEpisode(specs);
  const header = mkHeader(row);
  const bundle = syntheticBundle({ fewShots: FS });
  const stub = new DeterministicEpisodeSummarizer({
    respond: (req) => {
      cap[req.kind]!.push(req.prompt);
      if (req.kind === "chunk") return { ok: true, rawJson: validChunkJson(idFromPrompt(req.prompt)), servedModel: null };
      if (req.kind === "assembly") return { ok: true, rawJson: validEpisodeJson(header, "m-0"), servedModel: null };
      return { ok: true, rawJson: validEpisodeJson(header), servedModel: null };
    },
  });
  const r = await runPass2Core({ row, members, bundle, manifest: syntheticManifest(bundle), config: syntheticConfig({ chunkMax }), port: stub });
  return { status: r.status, cap };
}

test("G1-B-CA (real seam): fewShots reach episode + assembly port prompts once each, never chunk; two runs byte-identical", async () => {
  const ep = await captureFsPrompts(REG, 500); // regular path → episode prompt
  const ch = await captureFsPrompts(CHUNKED, 40); // chunked path → chunk + assembly prompts
  assert.equal(ep.status, "candidate");
  assert.equal(ch.status, "candidate");
  assert.ok(ep.cap["episode"]!.length >= 1 && ch.cap["assembly"]!.length >= 1 && ch.cap["chunk"]!.length >= 1);
  for (const m of FS_MARKERS) {
    for (const p of ep.cap["episode"]!) assert.equal(p.split(m).length - 1, 1, `episode prompt carries ${m} once`);
    for (const p of ch.cap["assembly"]!) assert.equal(p.split(m).length - 1, 1, `assembly prompt carries ${m} once`);
    for (const p of ch.cap["chunk"]!) assert.equal(p.split(m).length - 1, 0, `chunk prompt carries no ${m}`);
  }
  for (const p of [...ep.cap["episode"]!, ...ch.cap["assembly"]!, ...ch.cap["chunk"]!]) assert.ok(!p.includes("[此处注入定稿 few-shot"), "no placeholder");
  // two runs → byte-identical captured prompts
  const ch2 = await captureFsPrompts(CHUNKED, 40);
  assert.deepEqual(ch.cap, ch2.cap, "two runs produce byte-identical prompts");
});

test("G1-B-CA: malformed fewShots fails closed (few_shots_invalid) with ZERO port calls; no example bytes on any of the five faces", async () => {
  const SENT = "FSLEAKSENTINEL_CA";
  const { row, members } = syntheticEpisode(REG);
  const header = mkHeader(row);
  const bad = syntheticBundle({ fewShots: [`example ${SENT}`, ""] }); // blank-string element → invalid
  const stub = mkStub({ header });
  type W = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const orig = { log: console.log, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  let out = "";
  let err = "";
  let r;
  try {
    console.log = (...a: unknown[]): void => { out += a.map(String).join(" "); };
    console.error = (...a: unknown[]): void => { err += a.map(String).join(" "); };
    (process.stdout as unknown as W).write = (c: unknown): boolean => { out += String(c); return true; };
    (process.stderr as unknown as W).write = (c: unknown): boolean => { err += String(c); return true; };
    r = await runPass2Core({ row, members, bundle: bad, manifest: syntheticManifest(bad), config: syntheticConfig({ chunkMax: 500 }), port: stub });
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    (process.stdout as unknown as W).write = orig.out as unknown as W["write"];
    (process.stderr as unknown as W).write = orig.err as unknown as W["write"];
  }
  assert.equal(r.status, "pending");
  if (r.status === "pending") {
    assert.equal(r.reason, "validation_failed");
    assert.equal(r.detail.code, "few_shots_invalid");
  }
  assert.equal(stub.calls.length, 0, "zero port calls on malformed fewShots");
  const json = JSON.stringify(r);
  const md = r.status === "pending" ? `| ${r.reason} | ${r.detail.code} |` : "";
  const typed = r.status === "pending" ? [r.reason, r.detail.code].join("|") : "";
  for (const face of [out, err, json, md, typed]) assert.ok(!face.includes(SENT), "no example bytes on any face");
  assert.equal(out, "");
  assert.equal(err, "");
});

// --- E11 determinism (timezone / two-run) ---

test("E11: identical result across two runs and across process TZ changes", async () => {
  const header = mkHeader(syntheticEpisode(CHUNKED).row);
  const build = (): Pass2CoreInput => mkInput(CHUNKED, 30, mkStub({ header })).input;
  const origTz = process.env["TZ"];
  try {
    process.env["TZ"] = "America/New_York";
    const a = await runPass2Core(build());
    process.env["TZ"] = "Pacific/Kiritimati";
    const b = await runPass2Core(build());
    const c = await runPass2Core(build());
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
  } finally {
    if (origTz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = origTz;
  }
});

// --- B07 raw prompt/output/error sentinels are 0 across five faces; Erratum A sealed constant ---

test("B07: raw prompt/output/error sentinels never leak (stdout/stderr/JSON/Markdown/typed-result); a throw yields unexpected_exception; two runs byte-equal", async () => {
  const NAME_SENT = "UNIQ_ERROR_NAME_SENTINEL_B07"; // adversarial Error.name (Erratum A)
  const MSG_SENT = "UNIQ_ERROR_MESSAGE_SENTINEL_B07"; // adversarial Error.message
  const PROMPT_SENT = "UNIQ_PROMPT_SENTINEL_B07"; // enters the rendered prompt via member content
  const OUT_SENT = "UNIQ_OUTPUT_SENTINEL_B07"; // enters raw model output that fails validation

  const members: MemberSpec[] = [
    { role: "owner", offsetSec: 0, content: `plan ${PROMPT_SENT} here`, messageId: "m-1" },
    { role: "companion", offsetSec: 60, content: "noted", messageId: "m-2" },
  ];
  const header = mkHeader(syntheticEpisode(members).row);
  const throwStub = (): DeterministicEpisodeSummarizer => mkStub({ header, throwOn: "episode", throwName: NAME_SENT, throwMessage: MSG_SENT });
  // a model whose raw output carries OUT_SENT inside a persona-violating claim → V1 hard-fail
  const outLeakStub = mkStub({ header, episode: () => ({ ok: true, rawJson: JSON.stringify({ ...JSON.parse(validEpisodeJson(header)), claims: [{ text: `用户 ${OUT_SENT}`, kind: "event", evidence_message_ids: ["m-1"] }] }), servedModel: null }) });

  type W = { write: (chunk: unknown, ...rest: unknown[]) => boolean };
  const orig = { log: console.log, error: console.error, info: console.info, warn: console.warn, debug: console.debug, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  let out = "";
  let err = "";
  let rThrow1, rThrow2, rOut;
  try {
    console.log = console.info = console.warn = console.debug = (...a: unknown[]): void => { out += a.map(String).join(" ") + "\n"; };
    console.error = (...a: unknown[]): void => { err += a.map(String).join(" ") + "\n"; };
    (process.stdout as unknown as W).write = (c: unknown): boolean => { out += String(c); return true; };
    (process.stderr as unknown as W).write = (c: unknown): boolean => { err += String(c); return true; };
    rThrow1 = await runPass2Core(mkInput(members, 500, throwStub()).input);
    rThrow2 = await runPass2Core(mkInput(members, 500, throwStub()).input);
    rOut = await runPass2Core(mkInput(members, 500, outLeakStub).input);
  } finally {
    console.log = orig.log; console.error = orig.error; console.info = orig.info; console.warn = orig.warn; console.debug = orig.debug;
    (process.stdout as unknown as W).write = orig.out as unknown as W["write"];
    (process.stderr as unknown as W).write = orig.err as unknown as W["write"];
  }

  // Erratum A: an unexpected throw maps to the SEALED constant — never Error.name.
  assert.equal(rThrow1.status, "pending");
  if (rThrow1.status === "pending") {
    assert.equal(rThrow1.reason, "model_error");
    assert.equal(rThrow1.detail.code, "unexpected_exception");
  }
  // two runs of the same throw are byte-equal
  assert.deepEqual(rThrow1, rThrow2);
  assert.equal(JSON.stringify(rThrow1), JSON.stringify(rThrow2));
  // the output-leak run failed validation (V1), not by surfacing the raw output
  assert.equal(rOut.status, "pending");
  if (rOut.status === "pending") assert.equal(rOut.detail.code, "V1");

  // Five faces × every sentinel = zero occurrences.
  const faceOf = (r: typeof rThrow1): { json: string; md: string; typed: string } => {
    const json = JSON.stringify(r);
    const md = r.status === "pending" ? `| ${r.status} | ${r.reason} | ${r.detail.code} | ${r.detail.location ?? ""} | ${r.diagnostics.notes.join(",")} |` : `| candidate |`;
    const typed = r.status === "pending" ? [r.status, r.reason, r.detail.code, r.detail.location ?? "", ...r.diagnostics.notes].join("|") : "candidate";
    return { json, md, typed };
  };
  for (const r of [rThrow1, rOut]) {
    const f = faceOf(r);
    for (const [name, face] of [["stdout", out], ["stderr", err], ["json", f.json], ["markdown", f.md], ["typed", f.typed]] as const) {
      for (const s of [NAME_SENT, MSG_SENT, PROMPT_SENT, OUT_SENT]) {
        assert.ok(!face.includes(s), `${name} must not carry ${s}`);
      }
    }
  }
  // the core itself emits nothing to stdout/stderr
  assert.equal(out, "");
  assert.equal(err, "");
});
