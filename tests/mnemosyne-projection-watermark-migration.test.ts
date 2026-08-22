import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import { buildMemoryReadPacket } from "../core/services/anamnesis.js";
import { MnemosyneGovernanceService } from "../core/services/mnemosyne-governance.js";

const PROJECTION_WATERMARK_KEY = "mnemosyne_projection_event_seq_v1";

test("opening a pre-watermark non-empty container rebuilds before reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "mnemosyne-pre-watermark-"));
  const dbPath = join(root, "delos-memory.db");
  const first = openMnemosyne(dbPath);
  let reopened: ReturnType<typeof openMnemosyne> | null = null;
  let firstClosed = false;
  try {
    const service = new MnemosyneGovernanceService({
      store: first.store,
      backup: (label) => ({ path: `${dbPath}.synthetic-backup-${label}` }),
      audit: () => undefined,
    });
    const body = "synthetic pre-watermark migration sentinel";
    const proposed = await service.propose({
      body,
      scope: "relationship",
      sensitivity: "normal",
      importance: 2,
      evidence: { kind: "manual" },
      proposedBy: "owner",
    });
    assert.equal(proposed.status, "ok");
    if (proposed.status !== "ok") return;
    assert.equal((await service.approve(proposed.memoryId, "owner")).status, "ok");

    const before = first.store.projectionFreshness();
    assert.equal(before.fresh, true);
    assert.notEqual(before.projectedSeq, null);

    // Simulate an otherwise-valid database created before projection
    // watermarks existed. Event truth and derived rows remain; only the proof
    // that binds them to the same event prefix is absent.
    first.log.db.prepare("DELETE FROM meta WHERE key = ?").run(PROJECTION_WATERMARK_KEY);
    assert.equal(first.store.projectionFreshness().fresh, false);

    first.log.close();
    firstClosed = true;
    reopened = openMnemosyne(dbPath);

    const after = reopened.store.projectionFreshness();
    assert.equal(after.fresh, true);
    assert.equal(after.projectedSeq, after.authoritativeSeq);
    assert.ok(after.authoritativeSeq > 0);

    const packet = buildMemoryReadPacket({
      source: reopened.store,
      query: "pre-watermark migration sentinel",
      scene: { mode: "ordinary", intimacyActive: false },
      nowIso: "2026-08-20T00:00:00.000Z",
    });
    assert.deepEqual(packet.memories.map((memory) => memory.body), [body]);
  } finally {
    if (!firstClosed) first.log.close();
    reopened?.log.close();
    rmSync(root, { recursive: true, force: true });
  }
});
