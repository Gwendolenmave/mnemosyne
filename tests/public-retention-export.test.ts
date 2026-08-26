import assert from "node:assert/strict";
import { test } from "node:test";
import { Retention } from "../index.js";

test("root package exports the portable retention authority namespace", () => {
  assert.equal(Retention.PORTABLE_RETENTION_SCHEMA_VERSION, 1);
  assert.equal(
    Retention.isPortableRetentionRequest({
      schemaVersion: 1,
      evidenceCodes: ["stable_preference"],
      auId: null,
    }),
    true,
  );

  const decision = Retention.dispatchPortableRetention({
    schemaVersion: 1,
    evidenceCodes: ["time_limited_state", "stable_preference"],
    auId: null,
  });
  assert.equal(decision.destination, "session_continuity");
  assert.equal(decision.longTermCandidateAdmissionAllowed, false);
  assert.equal(decision.writePerformed, false);
});
