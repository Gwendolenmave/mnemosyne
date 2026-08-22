import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPass1Transcripts } from "../adapters/transcripts/local/pass1-transcript-loader.js";
import { partitionAndAssemble } from "../core/services/episode-pass1-normalize.js";
import { writePass1Transcripts, writeRawTranscript, type FixtureConversation } from "./pass1-fixtures.js";

/**
 * L1-T02 P2 tests: offline loader (conversation-from-filename, malformed
 * line categories, unknown non-message skip, NFC) and normalization
 * (partition, stable sort, atomic turn assembly, orphan assistant, same-
 * second tie, duplicate (conv,message_id) detection). Metadata only.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pass1-"));
}

test("loader parses production event shape, maps roles, NFC-normalizes, and derives conversationId from filename", () => {
  const dir = tempDir();
  const convs: FixtureConversation[] = [
    {
      conversationId: "c-20990101-0002",
      baseUtc: "2099-01-01T06:02:00.000Z",
      messages: [
        { role: "owner", offsetSec: 0, content: "é", messageId: "m-1", turnId: "t-1" },
        { role: "companion", offsetSec: 5, content: "reply", messageId: "m-2", turnId: "t-1" },
      ],
    },
  ];
  writePass1Transcripts(dir, convs);
  const res = loadPass1Transcripts(dir);
  assert.equal(res.messages.length, 2);
  assert.equal(res.malformed.length, 0);
  const [a, b] = res.messages;
  assert.equal(a!.conversationId, "c-20990101-0002");
  assert.equal(a!.role, "owner");
  assert.equal(b!.role, "companion");
  assert.equal(a!.contentNfc, "é"); // decomposed é → composed
  assert.equal(a!.epochMs, Date.parse("2099-01-01T06:02:00.000Z"));
  assert.match(a!.timestampUtc, /Z$/);
});

test("loader records per-line malformed categories and skips unknown non-message events", () => {
  const dir = tempDir();
  writeRawTranscript(dir, "2099-01-01T14-02-00-000Z-c-mal.jsonl", [
    JSON.stringify({ type: "user_message_persisted", content: "ok", message_id: "m-1", timestamp: "2099-01-01T14:02:00.000Z" }),
    "{ this is not json",
    JSON.stringify({ type: "assistant_message_persisted", content: "no id", timestamp: "2099-01-01T14:03:00.000Z" }),
    JSON.stringify({ type: "user_message_persisted", message_id: "m-3", timestamp: "2099-01-01T14:04:00.000Z" }),
    JSON.stringify({ type: "user_message_persisted", content: "bad time", message_id: "m-4", timestamp: "not-a-time" }),
    JSON.stringify({ type: "memory_retrieval_completed", detail: "x" }),
  ]);
  const res = loadPass1Transcripts(dir);
  assert.equal(res.messages.length, 1);
  assert.equal(res.skippedNonMessage, 1);
  const cats = res.malformed.map((m) => m.category).sort();
  assert.deepEqual(cats, ["bad_json", "bad_timestamp", "missing_content", "missing_message_id"]);
  // Diagnostics carry only fileId + line + category — never content.
  assert.ok(res.malformed.every((m) => m.sourceFileId.endsWith(".jsonl") && m.sourceLine > 0));
});

test("a message line from a file whose name yields no conversation is malformed (unknown_conversation)", () => {
  const dir = tempDir();
  writeRawTranscript(dir, "not-a-valid-stamp.jsonl", [
    JSON.stringify({ type: "user_message_persisted", content: "x", message_id: "m-1", timestamp: "2099-01-01T14:02:00.000Z" }),
  ]);
  const res = loadPass1Transcripts(dir);
  assert.equal(res.messages.length, 0);
  assert.deepEqual(res.malformed.map((m) => m.category), ["unknown_conversation"]);
});

test("partition + stable sort by (epoch, messageId), and atomic turn assembly", () => {
  const dir = tempDir();
  const convs: FixtureConversation[] = [
    {
      conversationId: "c-b",
      baseUtc: "2099-01-02T00:00:00.000Z",
      messages: [{ role: "owner", offsetSec: 0, content: "b1", messageId: "m-b1", turnId: "t-b1" }],
    },
    {
      conversationId: "c-a",
      baseUtc: "2099-01-01T00:00:00.000Z",
      messages: [
        { role: "owner", offsetSec: 0, content: "a1", messageId: "m-a1", turnId: "t-a1" },
        { role: "companion", offsetSec: 3, content: "a1r", messageId: "m-a1r", turnId: "t-a1" }, // same turn → merge
        { role: "owner", offsetSec: 60, content: "a2", messageId: "m-a2", turnId: "t-a2" },
        { role: "companion", offsetSec: 90, content: "orphan", messageId: "m-orph", turnId: "t-orph" }, // no user → orphan
      ],
    },
  ];
  writePass1Transcripts(dir, convs);
  const { partitions, duplicates } = partitionAndAssemble(loadPass1Transcripts(dir).messages);
  assert.equal(duplicates.length, 0);
  assert.deepEqual(partitions.map((p) => p.conversationId), ["c-a", "c-b"]); // partitions sorted
  const a = partitions.find((p) => p.conversationId === "c-a")!;
  // 3 turns: {m-a1,m-a1r} merged, {m-a2}, {m-orph} orphan
  assert.equal(a.turns.length, 3);
  assert.equal(a.turns[0]!.messages.length, 2);
  assert.equal(a.turns[0]!.orphanAssistant, false);
  assert.equal(a.turns[2]!.orphanAssistant, true);
});

test("proactive messages each form their own turn; no turn_id is never guessed into a group", () => {
  const dir = tempDir();
  const convs: FixtureConversation[] = [
    {
      conversationId: "c-p",
      baseUtc: "2099-01-03T00:00:00.000Z",
      messages: [
        { role: "companion", offsetSec: 0, content: "p1", messageId: "m-p1", proactive: true, turnId: "t-x" },
        { role: "companion", offsetSec: 1, content: "p2", messageId: "m-p2", proactive: true, turnId: "t-x" },
        { role: "owner", offsetSec: 5, content: "u1", messageId: "m-u1" }, // no turn_id
        { role: "owner", offsetSec: 6, content: "u2", messageId: "m-u2" }, // no turn_id
      ],
    },
  ];
  writePass1Transcripts(dir, convs);
  const p = partitionAndAssemble(loadPass1Transcripts(dir).messages).partitions[0]!;
  // 2 proactive turns + 2 solo turns = 4 (proactive never merged by turn_id; no-turn_id never grouped)
  assert.equal(p.turns.length, 4);
  assert.equal(p.turns.filter((t) => t.proactive).length, 2);
});

test("same-second messages sort deterministically by messageId; duplicate (conv,message_id) is detected", () => {
  const dir = tempDir();
  const convs: FixtureConversation[] = [
    {
      conversationId: "c-tie",
      baseUtc: "2099-01-04T00:00:00.000Z",
      messages: [
        { role: "owner", offsetSec: 10, content: "z", messageId: "m-z", turnId: "t-1" },
        { role: "owner", offsetSec: 10, content: "a", messageId: "m-a", turnId: "t-2" },
        { role: "owner", offsetSec: 20, content: "dup", messageId: "m-a", turnId: "t-3" }, // duplicate id
      ],
    },
  ];
  writePass1Transcripts(dir, convs);
  const { partitions, duplicates } = partitionAndAssemble(loadPass1Transcripts(dir).messages);
  assert.deepEqual(duplicates, [{ conversationId: "c-tie", messageId: "m-a" }]);
  // first two same-second messages ordered by messageId (m-a before m-z)
  const ids = partitions[0]!.turns.flatMap((t) => t.messages.map((m) => m.messageId));
  assert.equal(ids.indexOf("m-a") < ids.indexOf("m-z"), true);
});
