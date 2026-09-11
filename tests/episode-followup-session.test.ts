import test from "node:test";
import assert from "node:assert/strict";
import {
  TurnScopedEpisodeFollowupSession,
  type EpisodeAdjacentIdSource,
} from "../core/services/episode-followup-session.js";
import type { EpisodeAdjacencyRequest } from "../core/services/episode-adjacency.js";

const ep = (hex: string) => `ep-${hex.repeat(32).slice(0, 32)}`;
const anchor = ep("a");
const next1 = ep("b");
const next2 = ep("c");

function sourceFor(map: ReadonlyMap<string, readonly string[]>): {
  source: EpisodeAdjacentIdSource;
  calls: EpisodeAdjacencyRequest[];
} {
  const calls: EpisodeAdjacencyRequest[] = [];
  return {
    calls,
    source: {
      adjacent(request) {
        calls.push(request);
        return map.get(request.anchorEpisodeId) ?? [];
      },
    },
  };
}

test("unreturned Episode ids cannot probe the adjacency source", () => {
  const fake = sourceFor(new Map([[anchor, [next1]]]));
  const session = new TurnScopedEpisodeFollowupSession(fake.source);

  assert.deepEqual(session.adjacent({ afterEpisodeId: anchor, limit: 1 }), []);
  assert.equal(fake.calls.length, 0);
});

test("returned ids authorize one hop and hits become same-turn anchors", () => {
  const fake = sourceFor(new Map([
    [anchor, [next1]],
    [next1, [next2]],
  ]));
  const session = new TurnScopedEpisodeFollowupSession(fake.source);
  session.recordReturnedEpisodeIds([anchor]);

  assert.deepEqual(session.adjacent({ afterEpisodeId: anchor, limit: 1 }), [next1]);
  assert.deepEqual(session.adjacent({ afterEpisodeId: next1, limit: 1 }), [next2]);
  assert.equal(fake.calls.length, 2);
});

test("authorization is isolated to one logical turn session", () => {
  const fake = sourceFor(new Map([[anchor, [next1]]]));
  const first = new TurnScopedEpisodeFollowupSession(fake.source);
  first.recordReturnedEpisodeIds([anchor]);
  assert.deepEqual(first.adjacent({ afterEpisodeId: anchor, limit: 1 }), [next1]);

  const second = new TurnScopedEpisodeFollowupSession(fake.source);
  assert.deepEqual(second.adjacent({ afterEpisodeId: anchor, limit: 1 }), []);
  assert.equal(fake.calls.length, 1);
});

test("replay ceiling and bounded limit are forwarded without adding authority", () => {
  const fake = sourceFor(new Map([[anchor, [next1, next2]]]));
  const session = new TurnScopedEpisodeFollowupSession(fake.source);
  session.recordReturnedEpisodeIds([anchor]);

  const ceiling = "2026-09-01T12:00:00+08:00";
  assert.deepEqual(
    session.adjacent({ afterEpisodeId: anchor, availableBeforeIso: ceiling, limit: 1 }),
    [next1],
  );
  assert.deepEqual(fake.calls[0], {
    anchorEpisodeId: anchor,
    direction: "next",
    availableBeforeIso: ceiling,
    limit: 1,
  });
});

test("invalid requests, source errors, and malformed source ids fail closed", () => {
  const throwing: EpisodeAdjacentIdSource = {
    adjacent() {
      throw new Error("boom");
    },
  };
  const first = new TurnScopedEpisodeFollowupSession(throwing);
  first.recordReturnedEpisodeIds([anchor]);
  assert.deepEqual(first.adjacent({ afterEpisodeId: anchor, limit: 1 }), []);

  const malformed = sourceFor(new Map([[anchor, ["not-an-episode"]]]));
  const second = new TurnScopedEpisodeFollowupSession(malformed.source);
  second.recordReturnedEpisodeIds([anchor]);
  assert.deepEqual(second.adjacent({ afterEpisodeId: anchor, limit: 1 }), []);
  assert.deepEqual(second.adjacent({ afterEpisodeId: "not-an-episode", limit: 1 }), []);
  assert.deepEqual(second.adjacent({ afterEpisodeId: anchor, limit: 0 }), []);
  assert.deepEqual(
    second.adjacent({ afterEpisodeId: anchor, availableBeforeIso: "not-a-date", limit: 1 }),
    [],
  );
});
