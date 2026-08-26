import assert from "node:assert/strict";
import { test } from "node:test";
import { Curation } from "../index.js";

test("root package exposes formal curation through one stable facade", () => {
  assert.equal(typeof Curation.Contract.sha256Canonical, "function");
  assert.equal(typeof Curation.Contract.preflightCurationDecisionSet, "function");
  assert.equal(typeof Curation.Applicator, "object");
  assert.equal(typeof Curation.GovernanceWriter, "object");
});
