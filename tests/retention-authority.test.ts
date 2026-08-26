import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dispatchPortableRetention,
  isPortableRetentionRequest,
  type PortableRetentionRequest,
} from "../core/services/retention-authority.js";

function request(
  evidenceCodes: PortableRetentionRequest["evidenceCodes"],
  auId: string | null = null,
): PortableRetentionRequest {
  return { schemaVersion: 1, evidenceCodes, auId };
}

test("portable retention request validation is exact and fail-closed", () => {
  assert.equal(isPortableRetentionRequest(request([])), true);
  assert.equal(
    isPortableRetentionRequest({ schemaVersion: 1, evidenceCodes: ["stable_preference"], auId: null, extra: true }),
    false,
  );
  assert.equal(
    isPortableRetentionRequest({ schemaVersion: 1, evidenceCodes: ["stable_preference", "stable_preference"], auId: null }),
    false,
  );
  assert.equal(
    isPortableRetentionRequest({ schemaVersion: 1, evidenceCodes: ["unknown"], auId: null }),
    false,
  );
  assert.equal(
    isPortableRetentionRequest({ schemaVersion: 1, evidenceCodes: ["exact_au_setting"], auId: "Synthetic AU" }),
    false,
  );
  assert.equal(
    isPortableRetentionRequest({ schemaVersion: 1, evidenceCodes: ["stable_relationship"], auId: "synthetic-au" }),
    false,
  );
  assert.equal(dispatchPortableRetention({ bad: "shape" }).destination, "quarantine");
  assert.equal(dispatchPortableRetention({ bad: "shape" }).reasonCode, "invalid_request");
});

test("no retention evidence creates no admission", () => {
  const result = dispatchPortableRetention(request([]));
  assert.deepEqual(result, {
    schemaVersion: 1,
    destination: "none",
    reasonCode: "no_retention_signal",
    longTermCandidateAdmissionAllowed: false,
    governedCorrectionAdmissionAllowed: false,
    writePerformed: false,
  });
});

test("volatile and time-limited evidence terminate before long-term admission", () => {
  for (const code of ["volatile_state", "session_only", "time_limited_state"] as const) {
    const result = dispatchPortableRetention(request([code]));
    assert.equal(result.destination, "session_continuity");
    assert.equal(result.reasonCode, "volatile_session_only");
    assert.equal(result.longTermCandidateAdmissionAllowed, false);
    assert.equal(result.writePerformed, false);
  }
});

test("episodic evidence terminates at rebuildable episode authority", () => {
  const result = dispatchPortableRetention(request(["episodic_continuity"]));
  assert.equal(result.destination, "episode_projection");
  assert.equal(result.reasonCode, "episodic_projection_only");
  assert.equal(result.longTermCandidateAdmissionAllowed, false);
});

test("stable durable evidence is the positive control for long-term admission", () => {
  for (const code of ["stable_relationship", "stable_preference", "durable_project"] as const) {
    const result = dispatchPortableRetention(request([code]));
    assert.equal(result.destination, "governed_long_term");
    assert.equal(result.reasonCode, "durable_candidate");
    assert.equal(result.longTermCandidateAdmissionAllowed, true);
    assert.equal(result.governedCorrectionAdmissionAllowed, false);
  }
});

test("exact AU setting requires an exact host-owned AU identity", () => {
  const missing = dispatchPortableRetention(request(["exact_au_setting"]));
  assert.equal(missing.destination, "quarantine");
  assert.equal(missing.reasonCode, "au_scope_required");
  assert.equal(missing.longTermCandidateAdmissionAllowed, false);

  const exact = dispatchPortableRetention(request(["exact_au_setting"], "synthetic-au"));
  assert.equal(exact.destination, "governed_long_term");
  assert.equal(exact.longTermCandidateAdmissionAllowed, true);
});

test("shortest lifetime wins over simultaneous durable evidence", () => {
  const volatilePlusPreference = dispatchPortableRetention(
    request(["time_limited_state", "stable_preference"]),
  );
  assert.equal(volatilePlusPreference.destination, "session_continuity");
  assert.equal(volatilePlusPreference.longTermCandidateAdmissionAllowed, false);

  const episodicPlusRelationship = dispatchPortableRetention(
    request(["episodic_continuity", "stable_relationship"]),
  );
  assert.equal(episodicPlusRelationship.destination, "episode_projection");
  assert.equal(episodicPlusRelationship.longTermCandidateAdmissionAllowed, false);

  const sessionPlusEpisodePlusProject = dispatchPortableRetention(
    request(["session_only", "episodic_continuity", "durable_project"]),
  );
  assert.equal(sessionPlusEpisodePlusProject.destination, "session_continuity");
  assert.equal(sessionPlusEpisodePlusProject.longTermCandidateAdmissionAllowed, false);
});

test("correction uses a distinct governed repair lane and mixed correction evidence quarantines", () => {
  const correction = dispatchPortableRetention(request(["explicit_correction"]));
  assert.equal(correction.destination, "governed_correction");
  assert.equal(correction.longTermCandidateAdmissionAllowed, false);
  assert.equal(correction.governedCorrectionAdmissionAllowed, true);

  const mixed = dispatchPortableRetention(
    request(["explicit_correction", "stable_relationship"]),
  );
  assert.equal(mixed.destination, "quarantine");
  assert.equal(mixed.reasonCode, "mixed_correction_evidence");
  assert.equal(mixed.longTermCandidateAdmissionAllowed, false);
  assert.equal(mixed.governedCorrectionAdmissionAllowed, false);
});
