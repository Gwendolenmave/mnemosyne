import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readEpisodeHistoryByIdsFromSqlite } from "../adapters/projections/sqlite/episode-history-read-source.js";

const hash = (ch: string) => `sha256:${ch.repeat(64).slice(0, 64)}`;
const ep = (ch: string) => `ep-${ch.repeat(32).slice(0, 32)}`;

function payload(sourceHash: string, title: string, summary: string) {
  return JSON.stringify({
    payload_version: "pl-v1",
    title,
    summary,
    claims: [],
    temporal_hints: [],
    entities_model: [],
    uncertain_flags: [],
    summary_confidence: null,
    domain_suggestion: null,
    sensitivity: "normal",
    provenance: {
      source_hash: sourceHash,
      effective_realm: "reality",
      effective_au_id: null,
      effective_domain: "daily",
      generator: null,
      created_at: "2026-09-01T09:00:00+08:00",
      source_basis: "owner_override",
    },
    message_evidence_coverage: "none",
  });
}

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE episodes (
    episode_id TEXT PRIMARY KEY, realm TEXT NOT NULL, au_id TEXT, domain TEXT NOT NULL,
    started_at_utc TEXT NOT NULL, ended_at_utc TEXT NOT NULL, status TEXT NOT NULL,
    sensitivity TEXT NOT NULL, title TEXT NOT NULL, source_hash TEXT NOT NULL,
    published_payload TEXT
  )`);
  return db;
}

function insert(db: DatabaseSync, input: {
  id: string; title: string; summary: string; sourceHash: string; ended: string; published?: string | null;
}) {
  const published = input.published === undefined
    ? payload(input.sourceHash, input.title, input.summary)
    : input.published;
  db.prepare(
    "INSERT INTO episodes VALUES (?, 'reality', NULL, 'daily', ?, ?, 'closed', 'normal', ?, ?, ?)",
  ).run(input.id, "2026-09-01T10:00:00+08:00", input.ended, input.title, input.sourceHash, published);
}

test("exact Episode reads preserve request order and expose validated summaries", () => {
  const db = fixture();
  const a = ep("a");
  const b = ep("b");
  insert(db, { id: a, title: "First", summary: "first summary", sourceHash: hash("a"), ended: "2026-09-01T10:10:00+08:00" });
  insert(db, { id: b, title: "Second", summary: "second summary", sourceHash: hash("b"), ended: "2026-09-01T11:10:00+08:00" });
  const hits = readEpisodeHistoryByIdsFromSqlite({ db, request: { episodeIds: [b, a] } });
  assert.deepEqual(hits.map((hit) => hit.episodeId), [b, a]);
  assert.deepEqual(hits.map((hit) => hit.summary), ["second summary", "first summary"]);
  db.close();
});

test("unknown, duplicate, malformed, stale, and over-ceiling reads fail closed all-or-nothing", () => {
  const db = fixture();
  const a = ep("a");
  const b = ep("b");
  const stale = ep("c");
  insert(db, { id: a, title: "First", summary: "first summary", sourceHash: hash("a"), ended: "2026-09-01T10:10:00+08:00" });
  insert(db, { id: b, title: "Second", summary: "second summary", sourceHash: hash("b"), ended: "2026-09-01T12:10:00+08:00" });
  insert(db, { id: stale, title: "Stale", summary: "stale summary", sourceHash: hash("c"), ended: "2026-09-01T10:20:00+08:00", published: payload(hash("d"), "Stale", "stale summary") });

  assert.deepEqual(readEpisodeHistoryByIdsFromSqlite({ db, request: { episodeIds: [a, ep("f")] } }), []);
  assert.deepEqual(readEpisodeHistoryByIdsFromSqlite({ db, request: { episodeIds: [a, a] } }), []);
  assert.deepEqual(readEpisodeHistoryByIdsFromSqlite({ db, request: { episodeIds: [stale] } }), []);
  assert.deepEqual(readEpisodeHistoryByIdsFromSqlite({ db, request: { episodeIds: [a, b], availableBeforeIso: "2026-09-01T11:00:00+08:00" } }), []);
  assert.deepEqual(readEpisodeHistoryByIdsFromSqlite({ db, request: { episodeIds: [a], availableBeforeIso: "not-a-date" } }), []);
  db.close();
});

test("exact Episode read works under SQLite query_only", () => {
  const db = fixture();
  const a = ep("a");
  insert(db, { id: a, title: "First", summary: "first summary", sourceHash: hash("a"), ended: "2026-09-01T10:10:00+08:00" });
  db.exec("PRAGMA query_only = ON");
  assert.deepEqual(
    readEpisodeHistoryByIdsFromSqlite({ db, request: { episodeIds: [a] } }).map((hit) => hit.episodeId),
    [a],
  );
  db.close();
});
