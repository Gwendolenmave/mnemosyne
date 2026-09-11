import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { selectAdjacentEpisodeIdsFromSqlite } from "../adapters/projections/sqlite/episode-adjacency-source.js";

const ep = (hex: string) => `ep-${hex.repeat(32).slice(0, 32)}`;

const anchor = ep("1");
const next1 = ep("2");
const next2 = ep("3");
const otherConversation = ep("4");
const unpublished = ep("5");

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE episodes (
      episode_id TEXT NOT NULL PRIMARY KEY,
      channel TEXT NOT NULL,
      thread TEXT NOT NULL,
      started_at_utc TEXT NOT NULL,
      ended_at_utc TEXT NOT NULL,
      published_payload TEXT
    );
    CREATE TABLE episode_messages (
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      episode_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, message_id)
    );
  `);
  return db;
}

function addEpisode(
  db: DatabaseSync,
  input: {
    id: string;
    channel?: string;
    thread?: string;
    start: string;
    end: string;
    published?: boolean;
  },
): void {
  db.prepare(
    "INSERT INTO episodes (episode_id, channel, thread, started_at_utc, ended_at_utc, published_payload) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    input.id,
    input.channel ?? "telegram",
    input.thread ?? "conversation-alpha",
    input.start,
    input.end,
    input.published === false ? null : "{}",
  );
}

function seed(db: DatabaseSync): void {
  addEpisode(db, {
    id: anchor,
    start: "2026-09-01T10:00:00+08:00",
    end: "2026-09-01T10:10:00+08:00",
  });
  addEpisode(db, {
    id: next2,
    start: "2026-09-01T12:00:00+08:00",
    end: "2026-09-01T12:10:00+08:00",
  });
  addEpisode(db, {
    id: next1,
    start: "2026-09-01T11:00:00+08:00",
    end: "2026-09-01T11:10:00+08:00",
  });
  addEpisode(db, {
    id: otherConversation,
    thread: "conversation-beta",
    start: "2026-09-01T10:30:00+08:00",
    end: "2026-09-01T10:40:00+08:00",
  });
  addEpisode(db, {
    id: unpublished,
    start: "2026-09-01T10:20:00+08:00",
    end: "2026-09-01T10:25:00+08:00",
    published: false,
  });
  db.prepare(
    "INSERT INTO episode_messages (conversation_id, message_id, episode_id, seq) VALUES (?, ?, ?, ?)",
  ).run("conversation-alpha", "msg-anchor", anchor, 1);
}

test("SQLite adjacency stays read-only, conversation-scoped, and chronological", () => {
  const db = createDb();
  seed(db);
  db.exec("PRAGMA query_only = ON");

  assert.deepEqual(
    selectAdjacentEpisodeIdsFromSqlite({
      db,
      request: { anchorEpisodeId: anchor, direction: "next", limit: 2 },
    }),
    [next1, next2],
  );

  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM episodes").get() as { count: number }).count,
    5,
  );
  db.close();
});

test("SQLite adjacency honors the replay ceiling", () => {
  const db = createDb();
  seed(db);
  assert.deepEqual(
    selectAdjacentEpisodeIdsFromSqlite({
      db,
      request: {
        anchorEpisodeId: anchor,
        direction: "next",
        availableBeforeIso: "2026-09-01T11:30:00+08:00",
        limit: 3,
      },
    }),
    [next1],
  );
  db.close();
});

test("SQLite adjacency fails closed when the anchor witness disagrees", () => {
  const db = createDb();
  seed(db);
  db.prepare("UPDATE episode_messages SET conversation_id = ? WHERE episode_id = ?").run(
    "conversation-beta",
    anchor,
  );
  assert.deepEqual(
    selectAdjacentEpisodeIdsFromSqlite({
      db,
      request: { anchorEpisodeId: anchor, direction: "next", limit: 3 },
    }),
    [],
  );
  db.close();
});

test("SQLite adjacency fails closed for invalid limits and ceilings", () => {
  const db = createDb();
  seed(db);
  assert.deepEqual(
    selectAdjacentEpisodeIdsFromSqlite({
      db,
      request: { anchorEpisodeId: anchor, direction: "next", limit: Number.NaN },
    }),
    [],
  );
  assert.deepEqual(
    selectAdjacentEpisodeIdsFromSqlite({
      db,
      request: {
        anchorEpisodeId: anchor,
        direction: "next",
        availableBeforeIso: "not-a-date",
        limit: 1,
      },
    }),
    [],
  );
  db.close();
});
