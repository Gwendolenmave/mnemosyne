import test from "node:test";
import assert from "node:assert/strict";
import { TurnScopedEpisodeRecallSession } from "../core/services/episode-recall-session.js";
import type { EpisodeHistoryHit } from "../core/services/episode-history.js";

const episodeId = "ep-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const neighborId = "ep-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const sourceHash = `sha256:${"c".repeat(64)}`;

function validHit(id = episodeId): EpisodeHistoryHit {
  return {
    episodeId: id,
    realm: "reality",
    auId: null,
    domain: "daily",
    title: "Synthetic episode",
    summary: "A public-safe synthetic summary.",
    startedAtIso: "2026-09-01T10:00:00Z",
    endedAtIso: "2026-09-01T10:10:00Z",
    status: "closed",
    sensitivity: "normal",
    sourceHash,
  };
}

function malformed(overrides: Record<string, unknown>): EpisodeHistoryHit {
  return { ...validHit(), ...overrides } as EpisodeHistoryHit;
}

test("search rejects malformed typed source hits before granting exact-read authority", () => {
  const badHits = [
    malformed({ realm: "elsewhere" }),
    malformed({ realm: "au", auId: null }),
    malformed({ realm: "reality", auId: "au-should-not-exist" }),
    malformed({ domain: "unknown" }),
    malformed({ summary: "" }),
    malformed({ startedAtIso: "not-a-time" }),
    malformed({ endedAtIso: "not-a-time" }),
    malformed({ status: "draft" }),
    malformed({ sensitivity: "secret" }),
    malformed({ sourceHash: "" }),
  ];

  for (const badHit of badHits) {
    let readCalls = 0;
    const session = new TurnScopedEpisodeRecallSession(
      { search: () => [badHit] },
      { adjacent: () => [] },
      { read: () => { readCalls += 1; return [validHit()]; } },
      { maxCallAttempts: 3 },
    );

    assert.deepEqual(session.search({ query: "synthetic", limit: 1 }), []);
    assert.deepEqual(session.lastDecision(), { status: "failed", reason: "execution_failed" });
    assert.deepEqual(session.read([episodeId]), []);
    assert.equal(readCalls, 0, "malformed search results must never authorize a later exact read");
  }
});

test("follow-up exact reads validate the full hit contract before widening adjacency authority", () => {
  let adjacencyCalls = 0;
  const session = new TurnScopedEpisodeRecallSession(
    { search: () => [validHit()] },
    { adjacent: () => { adjacencyCalls += 1; return [neighborId]; } },
    { read: () => [malformed({ episodeId: neighborId, realm: "au", auId: null })] },
    { maxCallAttempts: 4 },
  );

  assert.equal(session.search({ query: "synthetic", limit: 1 }).length, 1);
  assert.deepEqual(session.followup(episodeId), []);
  assert.deepEqual(session.lastDecision(), { status: "failed", reason: "execution_failed" });
  assert.equal(adjacencyCalls, 1);

  const before = adjacencyCalls;
  assert.deepEqual(session.followup(neighborId), []);
  assert.equal(adjacencyCalls, before, "a malformed follow-up payload must not authorize the next hop");
});

test("valid AU hits retain exact AU identity and pass runtime validation", () => {
  const auHit = malformed({ realm: "au", auId: "au-synthetic" });
  const session = new TurnScopedEpisodeRecallSession(
    { search: () => [auHit] },
    { adjacent: () => [] },
    { read: () => [auHit] },
    { maxCallAttempts: 2 },
  );

  assert.deepEqual(session.search({ query: "synthetic", limit: 1 }), [auHit]);
  assert.deepEqual(session.read([episodeId]), [auHit]);
});
