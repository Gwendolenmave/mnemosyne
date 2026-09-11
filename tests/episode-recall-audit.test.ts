import test from "node:test";
import assert from "node:assert/strict";
import { AuditedEpisodeRecallSession, type EpisodeRecallAuditEvent } from "../core/services/episode-recall-audit.js";
import { TurnScopedEpisodeRecallSession } from "../core/services/episode-recall-session.js";
import type { EpisodeHistoryHit } from "../core/services/episode-history.js";

const episodeId = `ep-${"a".repeat(32)}`;
const sourceHash = `sha256:${"b".repeat(64)}`;

const privateLookingHit: EpisodeHistoryHit = {
  episodeId,
  realm: "reality",
  auId: null,
  domain: "daily",
  title: "synthetic private-looking title",
  summary: "synthetic private-looking summary",
  startedAtIso: "2026-09-01T10:00:00+08:00",
  endedAtIso: "2026-09-01T10:10:00+08:00",
  status: "closed",
  sensitivity: "normal",
  sourceHash,
};

function underlying(): TurnScopedEpisodeRecallSession {
  return new TurnScopedEpisodeRecallSession(
    { search: (request) => request.query === "secret-query" ? [privateLookingHit] : [] },
    { adjacent: () => [] },
    { read: (request) => request.episodeIds[0] === episodeId ? [privateLookingHit] : [] },
  );
}

test("audit receipts contain only operation metadata, never recall content or identifiers", () => {
  const events: EpisodeRecallAuditEvent[] = [];
  const session = new AuditedEpisodeRecallSession(underlying(), (event) => events.push(event));

  assert.deepEqual(session.search({ query: "secret-query", timeHint: "secret-time", limit: 3 }), [privateLookingHit]);
  assert.deepEqual(session.read([episodeId]), [privateLookingHit]);
  assert.deepEqual(session.followup(episodeId), []);

  assert.deepEqual(events, [
    { sequence: 1, operation: "search", requestedCount: 3, returnedCount: 1, outcome: "returned" },
    { sequence: 2, operation: "read", requestedCount: 1, returnedCount: 1, outcome: "returned" },
    { sequence: 3, operation: "followup", requestedCount: 1, returnedCount: 0, outcome: "empty" },
  ]);

  const serialized = JSON.stringify(events);
  for (const forbidden of ["secret-query", "secret-time", episodeId, sourceHash, privateLookingHit.title, privateLookingHit.summary]) {
    assert.equal(serialized.includes(forbidden), false, `audit receipt leaked ${forbidden}`);
  }
});

test("a throwing audit sink cannot change recall results or authorization", () => {
  const session = new AuditedEpisodeRecallSession(underlying(), () => { throw new Error("sink failed"); });

  assert.deepEqual(session.search({ query: "secret-query", limit: 1 }).map((hit) => hit.episodeId), [episodeId]);
  assert.deepEqual(session.read([episodeId]).map((hit) => hit.episodeId), [episodeId]);
});
