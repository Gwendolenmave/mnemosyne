import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CurationBatchReceipt,
  CurationDecisionReceipt,
} from "../core/services/mnemosyne-curation-applicator.js";

test("curation replay receipts are metadata-only identifiers and digests", () => {
  const decision: CurationDecisionReceipt = {
    memoryId: "synthetic-card",
    decisionId: "synthetic-decision",
    decisionSetId: "synthetic-set",
    action: "REVISE",
    targetDigest: "a".repeat(64),
    preconditionDigest: "b".repeat(64),
  };
  const batch: CurationBatchReceipt = {
    decisionSetId: "synthetic-set",
    decisionSetSha256: "c".repeat(64),
    decisionIds: ["synthetic-decision"],
  };

  assert.deepEqual(Object.keys(decision).sort(), [
    "action",
    "decisionId",
    "decisionSetId",
    "memoryId",
    "preconditionDigest",
    "targetDigest",
  ]);
  assert.deepEqual(Object.keys(batch).sort(), ["decisionIds", "decisionSetId", "decisionSetSha256"]);

  const serialized = JSON.stringify({ decision, batch });
  assert.equal(serialized.includes("replacement_body"), false);
  assert.equal(serialized.includes("source_turn"), false);
  assert.equal(serialized.includes("transcript"), false);
  assert.equal(serialized.includes("evidence"), false);
});
