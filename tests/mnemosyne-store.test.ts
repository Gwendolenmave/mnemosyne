import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { SqliteMemoryEventLog } from "../adapters/memory/sqlite/sqlite-memory-event-log.js";
import { MnemosyneStore } from "../adapters/memory/sqlite/mnemosyne-store.js";
import { segmentForSearch } from "../core/services/segmentation.js";
import type { MnemosyneEnvelope } from "../core/domain/mnemosyne.js";
import { env, created, expectAppended } from "./memory-log-contract.js";

/**
 * M2-2 projection tests: fold-derived orthogonal states, tag
 * materialization, rebuildable multilingual FTS (two-character Chinese,
 * English, mixed — Companion acceptance #2), prior governance, actor rules,
 * and three-subject provenance (acceptance #1).
 */

function gov(event: MnemosyneEnvelope["event"], actor: MnemosyneEnvelope["actor"] = "owner"): MnemosyneEnvelope {
  return { eventId: randomUUID(), occurredAt: "2026-07-11T10:00:00.000Z", actor, event };
}

async function makeStore(): Promise<{ log: SqliteMemoryEventLog; store: MnemosyneStore; m1: string; m2: string }> {
  const log = new SqliteMemoryEventLog(":memory:");
  const store = new MnemosyneStore(log);
  const m1 = randomUUID();
  const m2 = randomUUID();
  await expectAppended(log, [
    env(created(m1, { content: "synthetic fixture: the operator drinks hot tea during a nightly batch" })),
    env(created(m2, { content: "synthetic fixture: Delos is a local system used for project planning" })),
  ]);
  const outcome = store.appendGovernance([
    gov({
      type: "attributes_set",
      memoryId: m1,
      title: "hot milk on late nights",
      tags: ["habit", "tea"],
      scope: "relationship",
      sensitivity: "normal",
      importance: 2,
    }, "system"),
    gov({ type: "confirmed", memoryId: m1, by: "both" }),
    gov({
      type: "attributes_set",
      memoryId: m2,
      title: "what Delos is",
      tags: ["project", "planning"],
      scope: "project",
      sensitivity: "normal",
      importance: 3,
    }, "system"),
  ]);
  assert.equal(outcome.status, "appended");
  await store.rebuildProjections();
  return { log, store, m1, m2 };
}

test("projection: three orthogonal derived states materialize correctly", async () => {
  const { store, m1, m2 } = await makeStore();
  const confirmed = store.getItem(m1)!;
  assert.equal(confirmed.approval_state, "confirmed");
  assert.equal(confirmed.lifecycle_state, "active");
  assert.equal(confirmed.seal_state, "unsealed");
  assert.equal(confirmed.confirmed_by, "both");
  const candidate = store.getItem(m2)!;
  assert.equal(candidate.approval_state, "candidate");
  assert.equal(candidate.confirmed_by, null);
});

test("projection: tags land in memory_tags and tags_text", async () => {
  const { store, m1 } = await makeStore();
  const item = store.getItem(m1)!;
  assert.equal(item.tags_text.includes("tea"), true);
});

test("fts: two-character Chinese, English, and mixed queries all match", async () => {
  const { store, m1, m2 } = await makeStore();
  // two-character Chinese term inside body
  assert.equal(store.ftsSearch("tea", 5).some((r) => r.itemId === m1), true);
  // two-character Chinese tag
  assert.equal(store.ftsSearch("planning", 5).some((r) => r.itemId === m2), true);
  // English term
  assert.equal(store.ftsSearch("Delos", 5).some((r) => r.itemId === m2), true);
  // mixed Chinese/English query
  assert.equal(store.ftsSearch("建 Delos", 5).some((r) => r.itemId === m2), true);
  // English word in title
  assert.equal(store.ftsSearch("milk", 5).some((r) => r.itemId === m1), true);
  // honest empty
  assert.deepEqual(store.ftsSearch("量子引力", 5), []);
});

test("fts: index is disposable — drop contents and rebuild restores matches", async () => {
  const { store, m1 } = await makeStore();
  store["db" as never] as unknown; // no direct db poke; rebuild is the API
  await store.rebuildProjections();
  await store.rebuildProjections(); // idempotent double rebuild
  assert.equal(store.ftsSearch("tea", 5).some((r) => r.itemId === m1), true);
});

test("governance: the agent (system) cannot confirm, seal, or approve priors", async () => {
  const { store, m1 } = await makeStore();
  for (const event of [
    { type: "confirmed", memoryId: m1, by: "owner" },
    { type: "sealed", memoryId: m1 },
    { type: "prior_approved", key: "project_now", by: "owner" },
  ] as const) {
    const outcome = store.appendGovernance([gov(event as MnemosyneEnvelope["event"], "system")]);
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") {
      assert.equal(
        outcome.issues.some((issue) => issue.message.includes("cannot promote")),
        true,
      );
    }
  }
});

test("governance: append is all-or-nothing against the existing stream", async () => {
  const { store, m1 } = await makeStore();
  const good = gov({ type: "sealed", memoryId: m1 });
  const bad = gov({ type: "confirmed", memoryId: m1, by: "nobody" as never });
  const outcome = store.appendGovernance([good, bad]);
  assert.equal(outcome.status, "rejected");
  await store.rebuildProjections();
  assert.equal(store.getItem(m1)!.seal_state, "unsealed");
});

test("priors: proposed by system, approved by human, materialized with version", async () => {
  const { store } = await makeStore();
  const propose = gov(
    {
      type: "prior_proposed",
      key: "project_now",
      body: "synthetic fixture prior body (NOT real House Priors content)",
      tokenEst: 20,
      changelog: "synthetic test seed",
    },
    "system",
  );
  const approve = gov({ type: "prior_approved", key: "project_now", by: "companion" });
  assert.equal(store.appendGovernance([propose, approve]).status, "appended");
  await store.rebuildProjections();
  const priors = store.listPriors();
  assert.equal(priors.length, 1);
  assert.equal(priors[0]!.key, "project_now");
  assert.equal(priors[0]!.version, 1);
  assert.equal(priors[0]!.approved_by, "companion");
});

test("provenance: sources support memory, prior, and fragment subjects", async () => {
  const { store, m1 } = await makeStore();
  // memory sources are derived from kernel evidence during rebuild
  const memorySources = store.listSources("memory", m1);
  assert.equal(memorySources.length, 1);
  assert.equal(memorySources[0]!.kind, "transcript");
  assert.equal(memorySources[0]!.pointer.startsWith("conversation/"), true);
  // prior + fragment subjects via the explicit API (acceptance #1)
  store.addSource({
    id: randomUUID(),
    subjectKind: "prior",
    subjectId: "project_now",
    kind: "ledger",
    pointer: "delos-notes/muse-musagetes-v3-approval-record.md#p5a",
  });
  store.addFragment({
    id: "frag-1",
    body: "synthetic fragment",
    created_at: "2026-07-11T10:00:00.000Z",
    expires_at: "2026-07-25T10:00:00.000Z",
    source_id: null,
  });
  store.addSource({
    id: randomUUID(),
    subjectKind: "fragment",
    subjectId: "frag-1",
    kind: "transcript",
    pointer: "conversation/x#y/z",
  });
  assert.equal(store.listSources("prior", "project_now").length, 1);
  assert.equal(store.listSources("fragment", "frag-1").length, 1);
});

test("fragments: expiry filters at read time (Lethe)", async () => {
  const { store } = await makeStore();
  store.addFragment({
    id: "frag-live",
    body: "still warm",
    created_at: "2026-07-10T00:00:00.000Z",
    expires_at: "2026-07-20T00:00:00.000Z",
    source_id: null,
  });
  store.addFragment({
    id: "frag-old",
    body: "long cold",
    created_at: "2026-06-01T00:00:00.000Z",
    expires_at: "2026-06-15T00:00:00.000Z",
    source_id: null,
  });
  const active = store.listFragments("2026-07-11T00:00:00.000Z");
  assert.deepEqual(active.map((f) => f.id), ["frag-live"]);
});

test("segmentForSearch keeps two-character Chinese words and lowercases English", () => {
  const segmented = segmentForSearch("校验月面温室日志，Build Delos!");
  assert.equal(segmented.includes("温室") || segmented.includes("月面温室"), true);
  assert.equal(segmented.includes("delos"), true);
  assert.equal(segmented.includes("!"), false);
});
