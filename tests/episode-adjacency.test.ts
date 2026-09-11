import test from "node:test";
import assert from "node:assert/strict";
import { selectAdjacentEpisodeIds } from "../core/services/episode-adjacency.js";

const ep = (hex: string) => `ep-${hex.repeat(32).slice(0, 32)}`;

const anchor = ep("a");
const next1 = ep("b");
const next2 = ep("c");
const otherConversation = ep("d");
const unpublished = ep("e");

const rows = [
  {
    episodeId: anchor,
    channel: "telegram",
    thread: "conversation-alpha",
    startedAtIso: "2026-09-01T10:00:00+08:00",
    endedAtIso: "2026-09-01T10:10:00+08:00",
    published: true,
  },
  {
    episodeId: next2,
    channel: "telegram",
    thread: "conversation-alpha",
    startedAtIso: "2026-09-01T12:00:00+08:00",
    endedAtIso: "2026-09-01T12:10:00+08:00",
    published: true,
  },
  {
    episodeId: next1,
    channel: "telegram",
    thread: "conversation-alpha",
    startedAtIso: "2026-09-01T11:00:00+08:00",
    endedAtIso: "2026-09-01T11:10:00+08:00",
    published: true,
  },
  {
    episodeId: otherConversation,
    channel: "telegram",
    thread: "conversation-beta",
    startedAtIso: "2026-09-01T10:30:00+08:00",
    endedAtIso: "2026-09-01T10:40:00+08:00",
    published: true,
  },
  {
    episodeId: unpublished,
    channel: "telegram",
    thread: "conversation-alpha",
    startedAtIso: "2026-09-01T10:20:00+08:00",
    endedAtIso: "2026-09-01T10:25:00+08:00",
    published: false,
  },
] as const;

test("adjacency stays inside one authoritative conversation and is chronologically stable", () => {
  assert.deepEqual(
    selectAdjacentEpisodeIds({
      request: { anchorEpisodeId: anchor, direction: "next", limit: 2 },
      rows,
      witnesses: [{ episodeId: anchor, conversationId: "conversation-alpha" }],
    }),
    [next1, next2],
  );
});

test("adjacency honors a strict replay ceiling", () => {
  assert.deepEqual(
    selectAdjacentEpisodeIds({
      request: {
        anchorEpisodeId: anchor,
        direction: "next",
        availableBeforeIso: "2026-09-01T11:30:00+08:00",
        limit: 3,
      },
      rows,
    }),
    [next1],
  );
});

test("adjacency fails closed when a conversation witness disagrees", () => {
  assert.deepEqual(
    selectAdjacentEpisodeIds({
      request: { anchorEpisodeId: anchor, direction: "next", limit: 3 },
      rows,
      witnesses: [{ episodeId: anchor, conversationId: "conversation-beta" }],
    }),
    [],
  );
});

test("adjacency fails closed for malformed anchors, ceilings, and limits", () => {
  assert.deepEqual(
    selectAdjacentEpisodeIds({
      request: { anchorEpisodeId: "not-an-episode", direction: "next", limit: 1 },
      rows,
    }),
    [],
  );
  assert.deepEqual(
    selectAdjacentEpisodeIds({
      request: { anchorEpisodeId: anchor, direction: "next", availableBeforeIso: "not-a-date", limit: 1 },
      rows,
    }),
    [],
  );
  assert.deepEqual(
    selectAdjacentEpisodeIds({
      request: { anchorEpisodeId: anchor, direction: "next", limit: 0 },
      rows,
    }),
    [],
  );
});
