import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { searchEpisodeHistoryFromSqlite } from "../adapters/projections/sqlite/episode-history-source.js";

const hash = (ch: string) => `sha256:${ch.repeat(64).slice(0, 64)}`;
const ep = (ch: string) => `ep-${ch.repeat(32).slice(0, 32)}`;

function payload(input: { sourceHash: string; title: string; summary: string }) {
  return JSON.stringify({
    payload_version: "pl-v1",
    title: input.title,
    summary: input.summary,
    claims: [],
    temporal_hints: [],
    entities_model: [],
    uncertain_flags: [],
    summary_confidence: null,
    domain_suggestion: null,
    sensitivity: "normal",
    provenance: {
      source_hash: input.sourceHash,
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
  db.exec(`
    CREATE TABLE episodes (
      episode_id TEXT PRIMARY KEY, realm TEXT NOT NULL, au_id TEXT, domain TEXT NOT NULL,
      started_at_utc TEXT NOT NULL, ended_at_utc TEXT NOT NULL, status TEXT NOT NULL,
      sensitivity TEXT NOT NULL, title TEXT NOT NULL, source_hash TEXT NOT NULL,
      published_payload TEXT
    );
    CREATE VIRTUAL TABLE episodes_fts USING fts5(
      title, entities, summary, episode_id UNINDEXED, tokenize='unicode61'
    );
  `);
  return db;
}

function insert(db: DatabaseSync, input: {
  id: string; title: string; summary: string; started: string; ended: string; sourceHash: string;
  published?: string | null;
}) {
  const published = input.published === undefined
    ? payload({ sourceHash: input.sourceHash, title: input.title, summary: input.summary })
    : input.published;
  db.prepare(
    "INSERT INTO episodes VALUES (?, 'reality', NULL, 'daily', ?, ?, 'closed', 'normal', ?, ?, ?)",
  ).run(input.id, input.started, input.ended, input.title, input.sourceHash, published);
  if (published !== null) {
    db.prepare("INSERT INTO episodes_fts (title, entities, summary, episode_id) VALUES (?, '', ?, ?)")
      .run(input.title, input.summary, input.id);
  }
}

test("lexical history search is bounded, ranked, and carries a strict replay ceiling", () => {
  const db = fixture();
  const a = ep("a");
  const b = ep("b");
  insert(db, {
    id: a, title: "Blue train", summary: "A quiet train-window conversation", sourceHash: hash("a"),
    started: "2026-09-01T10:00:00+08:00", ended: "2026-09-01T10:10:00+08:00",
  });
  insert(db, {
    id: b, title: "Later train", summary: "Another train-window conversation", sourceHash: hash("b"),
    started: "2026-09-01T12:00:00+08:00", ended: "2026-09-01T12:10:00+08:00",
  });

  const hits = searchEpisodeHistoryFromSqlite({
    db,
    request: {
      query: "train window",
      availableBeforeIso: "2026-09-01T11:00:00+08:00",
      limit: 5,
    },
  });
  assert.deepEqual(hits.map((hit) => hit.episodeId), [a]);
  assert.equal(hits[0]?.summary, "A quiet train-window conversation");
  db.close();
});

test("empty lexical anchors fall back to recent published Episodes", () => {
  const db = fixture();
  const a = ep("a");
  const b = ep("b");
  insert(db, {
    id: a, title: "Earlier", summary: "Earlier event", sourceHash: hash("a"),
    started: "2026-09-01T10:00:00+08:00", ended: "2026-09-01T10:10:00+08:00",
  });
  insert(db, {
    id: b, title: "Later", summary: "Later event", sourceHash: hash("b"),
    started: "2026-09-01T11:00:00+08:00", ended: "2026-09-01T11:10:00+08:00",
  });
  assert.deepEqual(
    searchEpisodeHistoryFromSqlite({ db, request: { query: "", limit: 1 } }).map((hit) => hit.episodeId),
    [b],
  );
  db.close();
});

test("recent-history fallback orders absolute instants across ISO offsets", () => {
  const db = fixture();
  const earlier = ep("a");
  const later = ep("b");
  insert(db, {
    id: earlier, title: "Earlier offset", summary: "earlier offset event", sourceHash: hash("a"),
    started: "2026-09-01T10:00:00+08:00", ended: "2026-09-01T10:10:00+08:00",
  });
  insert(db, {
    id: later, title: "Later offset", summary: "later offset event", sourceHash: hash("b"),
    started: "2026-09-01T02:20:00Z", ended: "2026-09-01T03:00:00Z",
  });

  assert.deepEqual(
    searchEpisodeHistoryFromSqlite({ db, request: { query: "", limit: 1 } }).map((hit) => hit.episodeId),
    [later],
  );
  db.close();
});

test("history replay ceilings compare absolute instants across ISO offsets", () => {
  const db = fixture();
  const eligible = ep("a");
  const future = ep("b");
  insert(db, {
    id: eligible, title: "Eligible offset", summary: "offset boundary event", sourceHash: hash("a"),
    started: "2026-09-01T02:00:00Z", ended: "2026-09-01T02:20:00Z",
  });
  insert(db, {
    id: future, title: "Future offset", summary: "offset boundary event", sourceHash: hash("b"),
    started: "2026-09-01T02:40:00Z", ended: "2026-09-01T03:00:00Z",
  });

  assert.deepEqual(
    searchEpisodeHistoryFromSqlite({
      db,
      request: {
        query: "offset boundary",
        availableBeforeIso: "2026-09-01T10:30:00+08:00",
        limit: 5,
      },
    }).map((hit) => hit.episodeId),
    [eligible],
  );
  db.close();
});

test("stale or malformed published payloads fail closed", () => {
  const db = fixture();
  const stale = ep("c");
  const malformed = ep("d");
  insert(db, {
    id: stale, title: "Stale", summary: "stale candidate", sourceHash: hash("c"),
    started: "2026-09-01T10:00:00+08:00", ended: "2026-09-01T10:10:00+08:00",
    published: payload({ sourceHash: hash("e"), title: "Stale", summary: "stale candidate" }),
  });
  insert(db, {
    id: malformed, title: "Broken", summary: "broken candidate", sourceHash: hash("d"),
    started: "2026-09-01T11:00:00+08:00", ended: "2026-09-01T11:10:00+08:00",
    published: "{not-json",
  });
  assert.deepEqual(searchEpisodeHistoryFromSqlite({ db, request: { query: "candidate", limit: 5 } }), []);
  db.close();
});

test("history search is read-only and invalid requests fail closed", () => {
  const db = fixture();
  const a = ep("a");
  insert(db, {
    id: a, title: "Read only", summary: "read only history", sourceHash: hash("a"),
    started: "2026-09-01T10:00:00+08:00", ended: "2026-09-01T10:10:00+08:00",
  });
  db.exec("PRAGMA query_only = ON");
  assert.equal(searchEpisodeHistoryFromSqlite({ db, request: { query: "history", limit: 1 } }).length, 1);
  assert.deepEqual(searchEpisodeHistoryFromSqlite({ db, request: { query: "history", limit: 0 } }), []);
  assert.deepEqual(
    searchEpisodeHistoryFromSqlite({
      db,
      request: { query: "history", availableBeforeIso: "not-a-date", limit: 1 },
    }),
    [],
  );
  db.close();
});