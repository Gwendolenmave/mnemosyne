import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  computePass1ConfigHash,
  validatePass1Config,
  type FictionLexicon,
  type Pass1Config,
} from "../core/domain/episode-pass1.js";
import { makeConfig, syntheticLexicons, validConfig } from "./pass1-fixtures.js";

/**
 * L1-T02 P1 contract tests: canonical serializer determinism, config
 * fingerprint, and config validation — drift, weak↔weak-circular fiction,
 * required versions, threshold legality, and default_realm↔au_id linkage.
 * All synthetic (synthetic-test-v0 placeholders); no real content.
 */

function expectIssue(config: Pass1Config, pathFragment: string, messageFragment?: string): void {
  const r = validatePass1Config(config);
  assert.ok(!r.ok, `expected a config issue at ${pathFragment}`);
  if (!r.ok) {
    assert.ok(
      r.issues.some((i) => i.path.includes(pathFragment) && (messageFragment === undefined || i.message.includes(messageFragment))),
      `expected ${pathFragment}${messageFragment ? ` (${messageFragment})` : ""}, got ${JSON.stringify(r.issues)}`,
    );
  }
}

// --- canonical serializer + fingerprint ------------------------------------

test("canonicalJson sorts object keys recursively and preserves array order", () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: [3, 1, 2] } });
  const b = canonicalJson({ a: { c: [3, 1, 2], d: 2 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":[3,1,2],"d":2},"b":1}');
});

test("computePass1ConfigHash is stable and independent of expectedConfigHash", () => {
  const c1 = makeConfig();
  const c2 = makeConfig({ expectedConfigHash: `sha256:${"a".repeat(64)}` });
  assert.equal(computePass1ConfigHash(c1), computePass1ConfigHash(c2));
  assert.match(computePass1ConfigHash(c1), /^sha256:[0-9a-f]{64}$/);
});

// --- config validation ------------------------------------------------------

test("a well-formed synthetic config with a matching fingerprint validates", () => {
  const r = validatePass1Config(validConfig());
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
});

test("config_bundle_drift: content changed but expectedConfigHash not re-registered", () => {
  const c = validConfig();
  const drifted: Pass1Config = { ...c, thresholds: { ...c.thresholds, gapHardMinutes: 120 } };
  expectIssue(drifted, "$.expectedConfigHash", "config_bundle_drift");
});

test("weak↔weak circular fiction (no strong / au_term ground) is rejected", () => {
  const circular: FictionLexicon = {
    version: "synthetic-test-v0",
    entries: [
      { term: "W1", mode: "enactment", strength: "weak", cooccur: { requires: "fiction_signal", window: "same_message" }, negctx: null },
      { term: "W2", mode: "enactment", strength: "weak", cooccur: { requires: "fiction_signal", window: "same_message" }, negctx: null },
    ],
  };
  const cfg = validConfig({ lexicons: syntheticLexicons(circular) });
  // recompute hash so ONLY the circular rule fires (not drift)
  const fixed: Pass1Config = { ...cfg, expectedConfigHash: computePass1ConfigHash(cfg) };
  expectIssue(fixed, "$.lexicons.fiction", "circular");
});

test("weak fiction entry without cooccur is rejected", () => {
  const bad: FictionLexicon = {
    version: "synthetic-test-v0",
    entries: [{ term: "W", mode: "enactment", strength: "weak", cooccur: null, negctx: null }],
  };
  const cfg = makeConfig({ lexicons: syntheticLexicons(bad) });
  expectIssue({ ...cfg, expectedConfigHash: computePass1ConfigHash(cfg) }, "$.lexicons.fiction.entries[0].cooccur", "weak");
});

test("empty lexicon/config versions are rejected", () => {
  const cfg = makeConfig();
  const bad = { ...cfg, lexicons: { ...cfg.lexicons, continuation: { version: "", terms: ["X"] } } };
  expectIssue({ ...bad, expectedConfigHash: computePass1ConfigHash(bad) }, "$.lexicons.continuation.version");
});

test("continuationLeadMin must be null (v1 lead branch closed)", () => {
  const cfg = makeConfig({
    thresholds: { gapHardMinutes: 90, gapSoftMinutes: 30, windowTurns: 5, topicJaccardMin: 0.08, auAssignMin: 3, auLeadMin: 2, continuationLeadMin: 4 as unknown as null },
  });
  expectIssue({ ...cfg, expectedConfigHash: computePass1ConfigHash(cfg) }, "$.thresholds.continuationLeadMin");
});

test("threshold sanity: soft < hard, positive integers", () => {
  const a = makeConfig({ thresholds: { gapHardMinutes: 30, gapSoftMinutes: 90, windowTurns: 5, topicJaccardMin: 0.08, auAssignMin: 3, auLeadMin: 2, continuationLeadMin: null } });
  expectIssue({ ...a, expectedConfigHash: computePass1ConfigHash(a) }, "$.thresholds.gapSoftMinutes");
  const b = makeConfig({ thresholds: { gapHardMinutes: 90, gapSoftMinutes: 30, windowTurns: 0, topicJaccardMin: 0.08, auAssignMin: 3, auLeadMin: 2, continuationLeadMin: null } });
  expectIssue({ ...b, expectedConfigHash: computePass1ConfigHash(b) }, "$.thresholds.windowTurns");
});

test("default_realm ↔ au_id linkage enforced", () => {
  const cfg = makeConfig();
  const bad1 = { ...cfg, defaultRealms: { version: "v", entries: [{ conversation_id: "c-x", default_realm: "au" as const, au_id: null }] } };
  expectIssue({ ...bad1, expectedConfigHash: computePass1ConfigHash(bad1) }, "$.defaultRealms.entries[0].au_id", "required");
  const bad2 = { ...cfg, defaultRealms: { version: "v", entries: [{ conversation_id: "c-x", default_realm: "reality" as const, au_id: "au-alpha" }] } };
  expectIssue({ ...bad2, expectedConfigHash: computePass1ConfigHash(bad2) }, "$.defaultRealms.entries[0].au_id", "null");
});
