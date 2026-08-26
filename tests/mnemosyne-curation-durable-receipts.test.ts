import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  foldMnemosyneEvents,
  validateMnemosyneStream,
  type MnemosyneEnvelope,
} from "../core/domain/mnemosyne.js";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";

const DECISION_ID = "1".repeat(64);
const SET_ID = "2".repeat(64);
const SET_SHA = "3".repeat(64);
const TARGET = "4".repeat(64);
const PRECONDITION = "5".repeat(64);

function decisionReceipt(): MnemosyneEnvelope {
  return {
    eventId: "curation-decision-event",
    occurredAt: "2026-08-26T08:00:00.000Z",
    actor: "companion",
    event: {
      type: "curation_decision_recorded",
      memoryId: "synthetic-card",
      decisionId: DECISION_ID,
      decisionSetId: SET_ID,
      action: "KEEP",
      targetDigest: TARGET,
      preconditionDigest: PRECONDITION,
    },
  };
}

function batchReceipt(): MnemosyneEnvelope {
  return {
    eventId: "curation-batch-event",
    occurredAt: "2026-08-26T08:00:01.000Z",
    actor: "system",
    event: {
      type: "curation_batch_recorded",
      decisionSetId: SET_ID,
      decisionSetSha256: SET_SHA,
      decisionIds: [DECISION_ID],
    },
  };
}

test("curation replay receipts are valid metadata-only governance events", () => {
  const stream = [decisionReceipt(), batchReceipt()];
  const validated = validateMnemosyneStream(stream);
  assert.equal(validated.ok, true);

  const folded = foldMnemosyneEvents(stream);
  assert.equal(folded.overlays.size, 0);
  assert.equal(folded.priors.size, 0);
  assert.equal(folded.policies.size, 0);
});

test("curation receipt validation fails closed on malformed identity and duplicate batch members", () => {
  const invalidDecision = structuredClone(decisionReceipt()) as unknown as {
    event: { decisionId: string; action: string };
  };
  invalidDecision.event.decisionId = "not-a-digest";
  invalidDecision.event.action = "NEEDS_OWNER";

  const invalidBatch = structuredClone(batchReceipt()) as unknown as {
    event: { decisionIds: string[] };
  };
  invalidBatch.event.decisionIds = [DECISION_ID, DECISION_ID];

  const result = validateMnemosyneStream([invalidDecision, invalidBatch]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.path.endsWith(".decisionId")));
  assert.ok(result.issues.some((issue) => issue.path.endsWith(".action")));
  assert.ok(result.issues.some((issue) => issue.path.endsWith(".decisionIds")));
});

test("SQLite preserves decision and set receipts across rebuild and reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mnemosyne-curation-receipts-"));
  const dbPath = join(dir, "memory.db");
  const first = openMnemosyne(dbPath);
  try {
    const appended = first.store.appendJoint([], [decisionReceipt(), batchReceipt()]);
    assert.deepEqual(appended, { status: "appended", kernel: 0, governance: 2 });
    await first.store.rebuildProjections();
    assert.equal(first.store.projectionFreshness().fresh, true);
    assert.deepEqual(
      first.store.readGovernance().map((envelope) => envelope.event.type),
      ["curation_decision_recorded", "curation_batch_recorded"],
    );
  } finally {
    first.log.close();
  }

  const reopened = openMnemosyne(dbPath);
  try {
    const events = reopened.store.readGovernance();
    assert.equal(events.length, 2);
    assert.equal(events[0]?.event.type, "curation_decision_recorded");
    assert.equal(events[1]?.event.type, "curation_batch_recorded");
    assert.equal(reopened.store.projectionFreshness().fresh, true);
    await reopened.store.rebuildProjections();
    assert.equal(reopened.store.projectionFreshness().fresh, true);
    assert.equal(reopened.store.readGovernance().length, 2);
  } finally {
    reopened.log.close();
  }
});
