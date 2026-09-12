import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodesProjectionDb } from "../adapters/projections/sqlite/episodes-projection-db.js";
import { Pass1WriteRefusedError, writePass1Result } from "../adapters/projections/sqlite/episode-pass1-writer.js";
import { runPass1 } from "../core/services/episode-pass1.js";
import { buildEngineInput, validConfig, writePass1Transcripts } from "./pass1-fixtures.js";
import type { Pass1Result } from "../core/domain/episode-pass1.js";

/**
 * L1-T02 P7 writer tests: single-transaction write into a fresh T01
 * episodes.db, Pass1 pending state, FTS (title/entities searchable, summary
 * empty), meta keys, membership, non-empty refusal, and schema-unchanged.
 */

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pass1w-")), "episodes.db");
}

function buildResult(): Pass1Result {
  const d = mkdtempSync(join(tmpdir(), "pass1w-src-"));
  writePass1Transcripts(d, [{
    conversationId: "c-20990101-0001",
    baseUtc: "2099-01-06T00:00:00.000Z",
    messages: [
      { role: "owner", offsetSec: 0, content: "distinctword orchard", messageId: "m-1", turnId: "t-1" },
      { role: "owner", offsetSec: 6005, content: "second segment topic", messageId: "m-2", turnId: "t-2" },
    ],
  }]);
  const out = runPass1(buildEngineInput(d, validConfig()));
  assert.ok(out.ok, out.ok ? "" : JSON.stringify(out.failure));
  return out.result;
}

test("writes all episodes, memberships, meta into a fresh episodes.db in one transaction", () => {
  const result = buildResult();
  const db = new EpisodesProjectionDb(tempDbPath());
  writePass1Result(db, result);
  const epCount = db.db.prepare("SELECT count(*) AS c FROM episodes").get() as { c: number };
  assert.equal(epCount.c, result.episodes.length);
  const memCount = db.db.prepare("SELECT count(*) AS c FROM episode_messages").get() as { c: number };
  assert.equal(memCount.c, result.memberships.length);
  const meta = new Map(
    (db.db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
  );
  assert.equal(meta.get("pass1_mode"), "synthetic_offline");
  assert.equal(meta.get("index_version"), result.report.index_version);
  assert.equal(meta.get("summary_version"), result.report.summary_version);
  assert.equal(meta.get("pass1_config_hash"), result.report.pass1_config_hash);
  db.close();
});

test("Pass1 rows carry NULL payloads and a not_run pending state", () => {
  const db = new EpisodesProjectionDb(tempDbPath());
  writePass1Result(db, buildResult());
  const rows = db.db
    .prepare("SELECT generated_payload, published_payload, generated_pending_reason, generated_pending_detail FROM episodes")
    .all() as Array<{ generated_payload: unknown; published_payload: unknown; generated_pending_reason: string; generated_pending_detail: string }>;
  for (const r of rows) {
    assert.equal(r.generated_payload, null);
    assert.equal(r.published_payload, null);
    assert.equal(r.generated_pending_reason, "not_run");
    assert.equal(r.generated_pending_detail, "pass2_not_run");
  }
  db.close();
});

test("FTS indexes title + entities but never summary (published is NULL)", () => {
  const db = new EpisodesProjectionDb(tempDbPath());
  writePass1Result(db, buildResult());
  const hit = db.db.prepare("SELECT episode_id FROM episodes_fts WHERE episodes_fts MATCH ?").all("distinctword");
  assert.equal(hit.length, 1); // title/entities carry the word
  const summaries = db.db.prepare("SELECT summary FROM episodes_fts").all() as Array<{ summary: string }>;
  assert.ok(summaries.every((s) => s.summary === ""), "summary column must be empty");
  db.close();
});

test("JSON columns are canonical (fixed key order); has_continuation stored as 0/1", () => {
  const db = new EpisodesProjectionDb(tempDbPath());
  writePass1Result(db, buildResult());
  const rows = db.db.prepare("SELECT participants, entities_lexical, continuation_links, overrides_applied_ids, has_continuation FROM episodes").all() as Array<{
    participants: string;
    entities_lexical: string;
    continuation_links: string;
    overrides_applied_ids: string;
    has_continuation: number;
  }>;
  for (const r of rows) {
    assert.doesNotThrow(() => JSON.parse(r.participants));
    assert.doesNotThrow(() => JSON.parse(r.entities_lexical));
    assert.doesNotThrow(() => JSON.parse(r.continuation_links));
    assert.doesNotThrow(() => JSON.parse(r.overrides_applied_ids));
    assert.ok(r.has_continuation === 0 || r.has_continuation === 1);
  }
  db.close();
});

test("refuses to write into a non-empty episodes.db (no rename/overwrite)", () => {
  const path = tempDbPath();
  const db = new EpisodesProjectionDb(path);
  writePass1Result(db, buildResult());
  assert.throws(() => writePass1Result(db, buildResult()), (e: unknown) => e instanceof Pass1WriteRefusedError);
  db.close();
});

test("writer adds no schema objects beyond the six T01 §1.1.6 objects", () => {
  const db = new EpisodesProjectionDb(tempDbPath());
  writePass1Result(db, buildResult());
  const names = (db.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((r) => r.name);
  for (const required of ["episodes", "episode_messages", "history_payloads", "episodes_fts", "overrides_applied", "meta"]) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
  assert.ok(!names.some((n) => n.includes("pass1")), "no pass1-specific table may be added");
  // episodes has exactly the 32 §1.1.6 columns
  const cols = db.db.prepare("PRAGMA table_info(episodes)").all() as Array<unknown>;
  assert.equal(cols.length, 32);
  db.close();
});
