import test from "node:test";
import assert from "node:assert/strict";
import { TurnScopedEpisodeRecallSession } from "../core/services/episode-recall-session.js";
import type { EpisodeHistoryHit } from "../core/services/episode-history.js";

const episodeId = `ep-${"c".repeat(32)}`;
const hit: EpisodeHistoryHit = {
  episodeId,
  realm: "reality",
  auId: null,
  domain: "daily",
  title: "synthetic episode",
  summary: "synthetic summary",
  startedAtIso: "2026-09-01T10:00:00Z",
  endedAtIso: "2026-09-01T10:05:00Z",
  status: "closed",
  sensitivity: "normal",
  sourceHash: `sha256:${"d".repeat(64)}`,
};

test("lastDecision separates empty, invalid, limited and returned outcomes", () => {
  const session = new TurnScopedEpisodeRecallSession(
    { search: (request) => request.query === "hit" ? [hit] : [] },
    { adjacent: () => [] },
    { read: () => [hit] },
    { maxCallAttempts: 4, maxReturnedCodePoints: 24_000 },
  );

  assert.deepEqual(session.search({ query: "none", limit: 1 }), []);
  assert.deepEqual(session.lastDecision(), { status: "empty" });

  assert.deepEqual(session.read([episodeId]), []);
  assert.deepEqual(session.lastDecision(), { status: "failed", reason: "invalid_arguments" });

  assert.deepEqual(session.search({ query: "hit", limit: 1 }), [hit]);
  assert.deepEqual(session.lastDecision(), { status: "returned" });

  assert.deepEqual(session.read([episodeId]), [hit]);
  assert.deepEqual(session.lastDecision(), { status: "returned" });

  assert.deepEqual(session.followup(episodeId), []);
  assert.deepEqual(session.lastDecision(), { status: "limited", reason: "attempt_limit" });
});

test("malformed source output is execution failure, not a genuine empty result", () => {
  const duplicate = { ...hit, title: "duplicate synthetic episode" };
  const session = new TurnScopedEpisodeRecallSession(
    { search: () => [hit, duplicate] },
    { adjacent: () => [] },
    { read: () => [] },
  );

  assert.deepEqual(session.search({ query: "x", limit: 3 }), []);
  assert.deepEqual(session.lastDecision(), { status: "failed", reason: "execution_failed" });
});

test("payload rejection is a result limit and does not widen authorization", () => {
  let readCalls = 0;
  const session = new TurnScopedEpisodeRecallSession(
    { search: () => [hit] },
    { adjacent: () => [] },
    { read: () => { readCalls += 1; return [hit]; } },
    { maxCallAttempts: 4, maxReturnedCodePoints: 1 },
  );

  assert.deepEqual(session.search({ query: "hit", limit: 1 }), []);
  assert.deepEqual(session.lastDecision(), { status: "limited", reason: "result_limit" });
  assert.deepEqual(session.read([episodeId]), []);
  assert.equal(readCalls, 0);
  assert.deepEqual(session.lastDecision(), { status: "failed", reason: "invalid_arguments" });
});
