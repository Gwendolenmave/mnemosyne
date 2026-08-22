import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { servedModelMatches, type EpisodeSummaryErrorKind } from "../core/ports/episode-summarizer.js";
import { DeterministicEpisodeSummarizer } from "../core/services/deterministic-episode-summarizer.js";

/**
 * L1-T01 summarizer port tests: the deterministic stub returns structured
 * output plus served-model init metadata, performs ZERO real model calls,
 * and captures its inputs (for future F-28/F-32). Plus source scans proving
 * the core layer carries no provider/CLI/model id AND no subprocess (spawn /
 * exit-code) semantics — the error kinds are vendor-neutral (§3.4).
 */

test("the stub returns a structured result and the injected served-model metadata", async () => {
  const requestedModel = "fixture-summary-model";
  const stub = new DeterministicEpisodeSummarizer({ servedModel: requestedModel });
  const probe = await stub.probeServedModel(requestedModel);
  assert.equal(probe.servedModel, requestedModel);

  const result = await stub.summarize({ kind: "episode", prompt: "synthetic prompt", requestedModel });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(typeof result.rawJson, "string");
    assert.equal(result.servedModel, requestedModel);
  }
});

test("the stub performs zero real model calls and captures every call/probe", async () => {
  const stub = new DeterministicEpisodeSummarizer({ servedModel: "fixture-summary-model" });
  await stub.probeServedModel("fixture-summary-model");
  await stub.summarize({ kind: "episode", prompt: "p1", requestedModel: "fixture-summary-model" });
  await stub.summarize({ kind: "chunk", prompt: "p2", requestedModel: "fixture-summary-model" });
  await stub.summarize({ kind: "assembly", prompt: "p3", requestedModel: "fixture-summary-model" });
  assert.equal(stub.realModelCalls, 0);
  assert.equal(stub.calls.length, 3);
  assert.equal(stub.probes.length, 1);
  assert.deepEqual(stub.calls.map((c) => c.kind), ["episode", "chunk", "assembly"]);
});

test("the stub is deterministic: same request text yields identical raw output", async () => {
  const a = new DeterministicEpisodeSummarizer({ servedModel: "m" });
  const b = new DeterministicEpisodeSummarizer({ servedModel: "m" });
  const ra = await a.summarize({ kind: "episode", prompt: "same", requestedModel: "m" });
  const rb = await b.summarize({ kind: "episode", prompt: "same", requestedModel: "m" });
  assert.deepEqual(ra, rb);
});

test("vendor-neutral error kinds are usable; a responder can shape a deterministic failure", async () => {
  const neutral: EpisodeSummaryErrorKind[] = [
    "transport_failure",
    "upstream_failure",
    "timeout",
    "empty_output",
    "malformed_output",
    "cancelled",
  ];
  for (const errorKind of neutral) {
    const stub = new DeterministicEpisodeSummarizer({
      servedModel: "m",
      respond: () => ({ ok: false, errorKind, detail: "synthetic" }),
    });
    const r = await stub.summarize({ kind: "episode", prompt: "p", requestedModel: "m" });
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.errorKind, errorKind);
    assert.equal(stub.realModelCalls, 0);
  }
});

test("servedModelMatches trusts only a byte-equal served identity, never null", () => {
  assert.equal(servedModelMatches("m", "m"), true);
  assert.equal(servedModelMatches("m", "other"), false);
  assert.equal(servedModelMatches("m", null), false);
});

// --- Portable Core evidence -------------------------------------------------

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CORE_FILES = [
  "core/ports/episode-summarizer.ts",
  "core/services/deterministic-episode-summarizer.ts",
  "core/services/episode-harness.ts",
];

test("core summarizer surfaces carry no provider name, CLI, or specific model id", () => {
  const forbidden = ["claude", "gpt", "sonnet", "opus", "haiku", "codex", "anthropic", "openai"];
  for (const file of CORE_FILES) {
    const code = stripComments(readFileSync(join(process.cwd(), file), "utf8")).toLowerCase();
    for (const token of forbidden) {
      assert.ok(!code.includes(token), `${file} must not mention "${token}"`);
    }
  }
});

test("core summarizer contract contains no spawn / exit-code / subprocess vocabulary", () => {
  const forbidden = ["spawn", "nonzero_exit", "exit_code", "exit code", "child_process", "childprocess", "stdin", "stdout", "stderr"];
  for (const file of CORE_FILES) {
    const code = stripComments(readFileSync(join(process.cwd(), file), "utf8")).toLowerCase();
    for (const token of forbidden) {
      assert.ok(!code.includes(token), `${file} must not contain subprocess vocabulary "${token}"`);
    }
  }
});
