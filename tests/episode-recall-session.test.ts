import test from "node:test";
import assert from "node:assert/strict";
import {
  EPISODE_RECALL_MAX_CALL_ATTEMPTS,
  EPISODE_RECALL_MAX_QUERY_CODE_POINTS,
  EPISODE_RECALL_MAX_RETURNED_CODE_POINTS,
  EPISODE_RECALL_MAX_TIME_HINT_CODE_POINTS,
  TurnScopedEpisodeRecallSession,
} from "../core/services/episode-recall-session.js";
import type { EpisodeHistoryHit } from "../core/services/episode-history.js";

const ep = (ch: string) => `ep-${ch.repeat(32).slice(0, 32)}`;
const hash = (ch: string) => `sha256:${ch.repeat(64).slice(0, 64)}`;

function hit(id: string, title: string): EpisodeHistoryHit {
  return {
    episodeId: id,
    realm: "reality",
    auId: null,
    domain: "daily",
    title,
    summary: `${title} summary`,
    startedAtIso: "2026-09-01T10:00:00+08:00",
    endedAtIso: "2026-09-01T10:10:00+08:00",
    status: "closed",
    sensitivity: "normal",
    sourceHash: hash(id.at(-1) ?? "a"),
  };
}

const a = ep("a");
const b = ep("b");
const c = ep("c");

function fixture(options: { maxCallAttempts?: number; maxReturnedCodePoints?: number } = {}) {
  let searchCalls = 0;
  let adjacencyCalls = 0;
  let readCalls = 0;
  const byId = new Map([[a, hit(a, "A")], [b, hit(b, "B")], [c, hit(c, "C")]]);
  const session = new TurnScopedEpisodeRecallSession(
    {
      search(request) {
        searchCalls += 1;
        return request.query === "first" ? [byId.get(a)!] : [];
      },
    },
    {
      adjacent(request) {
        adjacencyCalls += 1;
        if (request.anchorEpisodeId === a) return [b];
        if (request.anchorEpisodeId === b) return [c];
        return [];
      },
    },
    {
      read(request) {
        readCalls += 1;
        const hits = request.episodeIds.map((id) => byId.get(id));
        return hits.every((value) => value !== undefined) ? hits as EpisodeHistoryHit[] : [];
      },
    },
    {
      availableBeforeIso: "2026-09-02T00:00:00+08:00",
      maxCallAttempts: options.maxCallAttempts ?? 8,
      maxReturnedCodePoints: options.maxReturnedCodePoints ?? EPISODE_RECALL_MAX_RETURNED_CODE_POINTS,
    },
  );
  return {
    session,
    counts: () => ({ searchCalls, adjacencyCalls, readCalls }),
  };
}

test("search authorizes exact read only for ids actually returned in this turn", () => {
  const { session, counts } = fixture();
  assert.deepEqual(session.read([a]), []);
  assert.equal(counts().readCalls, 0, "unknown id must fail before storage read");

  assert.deepEqual(session.search({ query: "first", limit: 3 }).map((item) => item.episodeId), [a]);
  assert.deepEqual(session.read([a]).map((item) => item.episodeId), [a]);
  assert.equal(counts().readCalls, 1);
});

test("follow-up is same-turn only and successful neighbors become the next legal anchor", () => {
  const { session, counts } = fixture();
  assert.deepEqual(session.followup(a), []);
  assert.equal(counts().adjacencyCalls, 0, "unseen anchor must fail before adjacency storage call");

  session.search({ query: "first", limit: 3 });
  assert.deepEqual(session.followup(a).map((item) => item.episodeId), [b]);
  assert.deepEqual(session.followup(b).map((item) => item.episodeId), [c]);
  assert.deepEqual(session.read([b, c]).map((item) => item.episodeId), [b, c]);
});

test("a new session does not inherit authorization from the previous turn", () => {
  const first = fixture();
  first.session.search({ query: "first", limit: 3 });
  assert.deepEqual(first.session.read([a]).map((item) => item.episodeId), [a]);

  const second = fixture();
  assert.deepEqual(second.session.read([a]), []);
  assert.equal(second.counts().readCalls, 0);
});

test("malformed source responses fail closed without widening authorization", () => {
  let readCalls = 0;
  const session = new TurnScopedEpisodeRecallSession(
    { search: () => [hit(a, "A"), hit(a, "duplicate")] },
    { adjacent: () => [b, c] },
    { read: () => { readCalls += 1; return [hit(b, "B")]; } },
  );

  assert.deepEqual(session.search({ query: "x", limit: 3 }), []);
  assert.deepEqual(session.read([a]), []);
  assert.equal(readCalls, 0);
});

test("search enforces non-blank query/time-hint and Unicode bounds before source access", () => {
  assert.equal(EPISODE_RECALL_MAX_QUERY_CODE_POINTS, 600);
  assert.equal(EPISODE_RECALL_MAX_TIME_HINT_CODE_POINTS, 120);

  let searchCalls = 0;
  const session = new TurnScopedEpisodeRecallSession(
    { search: () => { searchCalls += 1; return []; } },
    { adjacent: () => [] },
    { read: () => [] },
    { maxCallAttempts: 8 },
  );

  assert.deepEqual(session.search({ query: "", limit: 1 }), []);
  assert.deepEqual(session.search({ query: "   \t\n", limit: 1 }), []);
  assert.equal(searchCalls, 0, "blank model-facing queries must fail before source search");

  assert.deepEqual(session.search({ query: "😀".repeat(600), limit: 1 }), []);
  assert.equal(searchCalls, 1, "600 Unicode code points remain admissible");

  assert.deepEqual(session.search({ query: "😀".repeat(601), limit: 1 }), []);
  assert.equal(searchCalls, 1, "oversized query must fail before source search");

  assert.deepEqual(session.search({ query: "x", timeHint: "   ", limit: 1 }), []);
  assert.equal(searchCalls, 1, "blank optional time hint must fail before source search");

  assert.deepEqual(session.search({ query: "x", timeHint: "界".repeat(120), limit: 1 }), []);
  assert.equal(searchCalls, 2, "120-code-point time hint remains admissible");

  assert.deepEqual(session.search({ query: "x", timeHint: "界".repeat(121), limit: 1 }), []);
  assert.equal(searchCalls, 2, "oversized time hint must fail before source search");
});

test("returned structured payloads share a cumulative Unicode code-point budget", () => {
  assert.equal(EPISODE_RECALL_MAX_RETURNED_CODE_POINTS, 24_000);
  const firstHit = hit(a, "😀".repeat(20));
  const firstCost = [...JSON.stringify([firstHit])].length;
  let searchCalls = 0;
  let readCalls = 0;
  const session = new TurnScopedEpisodeRecallSession(
    { search: () => { searchCalls += 1; return [firstHit]; } },
    { adjacent: () => [] },
    { read: () => { readCalls += 1; return [firstHit]; } },
    { maxCallAttempts: 4, maxReturnedCodePoints: firstCost },
  );

  assert.deepEqual(session.search({ query: "first", limit: 1 }).map((item) => item.episodeId), [a]);
  assert.equal(searchCalls, 1);
  assert.deepEqual(session.read([a]), [], "second payload would exceed the shared return budget");
  assert.equal(readCalls, 1, "budget is checked against the validated result returned by the source");
});

test("an over-budget search result grants no authorization", () => {
  const oversized = hit(a, "界".repeat(80));
  let readCalls = 0;
  const session = new TurnScopedEpisodeRecallSession(
    { search: () => [oversized] },
    { adjacent: () => [] },
    { read: () => { readCalls += 1; return [oversized]; } },
    { maxCallAttempts: 4, maxReturnedCodePoints: 10 },
  );

  assert.deepEqual(session.search({ query: "first", limit: 1 }), []);
  assert.deepEqual(session.read([a]), []);
  assert.equal(readCalls, 0, "discarded search results must not widen exact-read authorization");
});

test("default shared attempt ledger caps the whole recall turn and fails closed before sources", () => {
  assert.equal(EPISODE_RECALL_MAX_CALL_ATTEMPTS, 4);
  const { session, counts } = fixture({ maxCallAttempts: EPISODE_RECALL_MAX_CALL_ATTEMPTS });

  assert.deepEqual(session.read([a]), []); // attempt 1: unauthorized, no source read
  assert.deepEqual(session.search({ query: "first", limit: 3 }).map((item) => item.episodeId), [a]); // 2
  assert.deepEqual(session.read([a]).map((item) => item.episodeId), [a]); // 3
  assert.deepEqual(session.followup(a).map((item) => item.episodeId), [b]); // 4

  const before = counts();
  assert.deepEqual(session.followup(b), []); // exhausted: no adjacency or exact-read source call
  assert.deepEqual(session.read([b]), []); // still exhausted: no source call
  assert.deepEqual(counts(), before);
});

test("session budget overrides must be positive safe integers", () => {
  const history = { search: () => [] };
  const adjacency = { adjacent: () => [] };
  const reader = { read: () => [] };

  assert.throws(
    () => new TurnScopedEpisodeRecallSession(history, adjacency, reader, { maxCallAttempts: 0 }),
    /positive safe integer/,
  );
  assert.throws(
    () => new TurnScopedEpisodeRecallSession(history, adjacency, reader, { maxCallAttempts: 1.5 }),
    /positive safe integer/,
  );
  assert.throws(
    () => new TurnScopedEpisodeRecallSession(history, adjacency, reader, { maxReturnedCodePoints: 0 }),
    /positive safe integer/,
  );
  assert.throws(
    () => new TurnScopedEpisodeRecallSession(history, adjacency, reader, { maxReturnedCodePoints: 1.5 }),
    /positive safe integer/,
  );
});
