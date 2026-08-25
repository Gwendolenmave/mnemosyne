import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveProvenanceAxes,
  foldMnemosyneEvents,
  validateMnemosyneStream,
  type CanonicalSourceBasis,
  type MnemosyneEnvelope,
} from "../core/domain/mnemosyne.js";

const CANONICAL_BASES: readonly CanonicalSourceBasis[] = [
  "explicit",
  "observed",
  "inferred",
  "imported",
];

test("canonical provenance source bases remain orthogonal to proposal origin", () => {
  for (const sourceBasis of CANONICAL_BASES) {
    assert.deepEqual(
      deriveProvenanceAxes({
        source_basis: sourceBasis,
        proposal_origin: "backfill",
      }),
      { evidenceBasis: sourceBasis, proposalOrigin: "backfill" },
    );
  }
});

test("legacy public provenance remains readable without rewriting history", () => {
  assert.deepEqual(
    deriveProvenanceAxes({ source_basis: "user_stated", requested_by: "owner" }),
    { evidenceBasis: "explicit", proposalOrigin: "owner_request" },
  );
  assert.deepEqual(deriveProvenanceAxes({ source_basis: "companion_self" }), {
    evidenceBasis: null,
    proposalOrigin: "companion_self",
  });
  assert.deepEqual(deriveProvenanceAxes({ source_basis: "muse_suggestion" }), {
    evidenceBasis: null,
    proposalOrigin: "muse_signal",
  });
});

test("canonical imported basis validates and survives the governance fold", () => {
  const memoryId = "00000000-0000-4000-8000-000000000001";
  const stream: MnemosyneEnvelope[] = [
    {
      eventId: "synthetic-attributes",
      occurredAt: "2026-08-26T00:00:00.000Z",
      actor: "system",
      event: {
        type: "attributes_set",
        memoryId,
        title: "Synthetic imported memory",
        tags: ["synthetic"],
        scope: "project",
        sensitivity: "normal",
        importance: 2,
        sourceBasis: "imported",
      },
    },
    {
      eventId: "synthetic-provenance",
      occurredAt: "2026-08-26T00:00:01.000Z",
      actor: "system",
      event: {
        type: "provenance_set",
        memoryId,
        roles: {
          source_basis: "imported",
          proposal_origin: "backfill",
          authored_by: "companion",
        },
      },
    },
  ];

  const validated = validateMnemosyneStream(stream);
  assert.equal(validated.ok, true);

  const overlay = foldMnemosyneEvents(stream).overlays.get(memoryId);
  assert.ok(overlay);
  assert.equal(overlay.sourceBasis, "imported");
  assert.deepEqual(deriveProvenanceAxes(overlay.provenance), {
    evidenceBasis: "imported",
    proposalOrigin: "backfill",
  });
});

test("unknown source-basis values fail closed at the event boundary", () => {
  const invalidAttributes = validateMnemosyneStream([
    {
      eventId: "bad-attributes",
      occurredAt: "2026-08-26T00:00:00.000Z",
      actor: "system",
      event: {
        type: "attributes_set",
        memoryId: "00000000-0000-4000-8000-000000000002",
        title: "Synthetic invalid basis",
        tags: [],
        scope: "global",
        sensitivity: "normal",
        importance: 1,
        sourceBasis: "guessed",
      },
    },
  ]);
  assert.equal(invalidAttributes.ok, false);
  if (!invalidAttributes.ok) {
    assert.ok(invalidAttributes.issues.some((issue) => issue.path.endsWith(".sourceBasis")));
  }

  const invalidProvenance = validateMnemosyneStream([
    {
      eventId: "bad-provenance",
      occurredAt: "2026-08-26T00:00:00.000Z",
      actor: "system",
      event: {
        type: "provenance_set",
        memoryId: "00000000-0000-4000-8000-000000000003",
        roles: { source_basis: "guessed" },
      },
    },
  ]);
  assert.equal(invalidProvenance.ok, false);
  if (!invalidProvenance.ok) {
    assert.ok(
      invalidProvenance.issues.some((issue) => issue.path.endsWith(".roles.source_basis")),
    );
  }
});
