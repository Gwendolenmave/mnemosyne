import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openMnemosyne } from "../adapters/memory/sqlite/mnemosyne-facade.js";
import { buildMemoryReadPacket } from "../core/services/anamnesis.js";
import { MnemosyneGovernanceService } from "../core/services/mnemosyne-governance.js";

function buildService(dbPath: string) {
  const handle = openMnemosyne(dbPath);
  const service = new MnemosyneGovernanceService({
    store: handle.store,
    backup: (label) => ({ path: `${dbPath}.synthetic-backup-${label}` }),
    audit: () => undefined,
  });
  return { handle, service };
}

function retrievalBodies(handle: ReturnType<typeof openMnemosyne>, query: string): string[] {
  const packet = buildMemoryReadPacket({
    source: handle.store,
    query,
    scene: { mode: "ordinary", intimacyActive: false },
    nowIso: "2026-08-20T00:00:00.000Z",
  });
  return packet.memories.map((memory) => memory.body);
}

test("brand-new empty container is fresh before any event-derived projection exists", () => {
  const root = mkdtempSync(join(tmpdir(), "mnemosyne-projection-empty-"));
  const dbPath = join(root, "delos-memory.db");
  const handle = openMnemosyne(dbPath);
  try {
    assert.deepEqual(handle.store.projectionFreshness(), {
      fresh: true,
      authoritativeSeq: 0,
      projectedSeq: null,
    });
    assert.deepEqual(handle.store.listItems(), []);
    assert.deepEqual(handle.store.listPriors(), []);
  } finally {
    handle.log.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-commit crash cannot resurrect an owner-revoked memory after reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "mnemosyne-projection-revoke-"));
  const dbPath = join(root, "delos-memory.db");
  const { handle, service } = buildService(dbPath);
  let firstClosed = false;
  let reopened: ReturnType<typeof openMnemosyne> | null = null;
  try {
    const body = "synthetic projection recovery revoke sentinel";
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
    assert.deepEqual(retrievalBodies(handle, "projection recovery revoke"), [body]);

    // Commit authoritative revoke/retrieval-off events, then simulate a process
    // crash before disposable projections can publish the new event prefix.
    handle.store.rebuildProjections = async () => {
      throw new Error("synthetic crash after authoritative event commit");
    };
    await assert.rejects(
      service.revoke(proposed.memoryId, "owner", "synthetic owner revoke"),
      /synthetic crash after authoritative event commit/u,
    );

    // Same-process reads fail closed as soon as event truth outruns the
    // projection watermark; they may not consume the old active row.
    assert.throws(
      () => handle.store.getItem(proposed.memoryId),
      /mnemosyne projection is stale/u,
    );

    handle.log.close();
    firstClosed = true;

    // Reopen deterministically refolds from memory_events before exposing the
    // facade. The committed owner revoke therefore wins.
    reopened = openMnemosyne(dbPath);
    const recovered = reopened.store.getItem(proposed.memoryId);
    assert.notEqual(recovered, undefined);
    assert.equal(recovered!.lifecycle_state, "revoked");
    assert.equal(recovered!.retrieval, "disabled");
    assert.deepEqual(retrievalBodies(reopened, "projection recovery revoke"), []);
    assert.equal(reopened.store.projectionFreshness().fresh, true);
  } finally {
    if (!firstClosed) {
      handle.log.close();
    }
    reopened?.log.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-commit crash cannot lose a committed human approval after reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "mnemosyne-projection-approve-"));
  const dbPath = join(root, "delos-memory.db");
  const { handle, service } = buildService(dbPath);
  let firstClosed = false;
  let reopened: ReturnType<typeof openMnemosyne> | null = null;
  try {
    const body = "synthetic projection recovery approval sentinel";
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
    assert.deepEqual(retrievalBodies(handle, "projection recovery approval"), []);

    handle.store.rebuildProjections = async () => {
      throw new Error("synthetic crash after approval event commit");
    };
    await assert.rejects(
      service.approve(proposed.memoryId, "owner"),
      /synthetic crash after approval event commit/u,
    );
    assert.throws(
      () => handle.store.getItem(proposed.memoryId),
      /mnemosyne projection is stale/u,
    );

    handle.log.close();
    firstClosed = true;
    reopened = openMnemosyne(dbPath);
    const recovered = reopened.store.getItem(proposed.memoryId);
    assert.notEqual(recovered, undefined);
    assert.equal(recovered!.approval_state, "confirmed");
    assert.deepEqual(retrievalBodies(reopened, "projection recovery approval"), [body]);
    assert.equal(reopened.store.projectionFreshness().fresh, true);
  } finally {
    if (!firstClosed) {
      handle.log.close();
    }
    reopened?.log.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two connections cannot commit a revoke between freshness proof and derived read", async () => {
  const root = mkdtempSync(join(tmpdir(), "mnemosyne-projection-concurrency-"));
  const dbPath = join(root, "delos-memory.db");
  const writer = buildService(dbPath);
  let reader: ReturnType<typeof openMnemosyne> | null = null;
  try {
    const body = "synthetic projection concurrency sentinel";
    const proposed = await writer.service.propose({
      body,
      scope: "relationship",
      sensitivity: "normal",
      importance: 2,
      evidence: { kind: "manual" },
      proposedBy: "owner",
    });
    assert.equal(proposed.status, "ok");
    if (proposed.status !== "ok") return;
    assert.equal((await writer.service.approve(proposed.memoryId, "owner")).status, "ok");

    reader = openMnemosyne(dbPath);
    writer.handle.log.db.exec("PRAGMA busy_timeout = 0");
    reader.log.db.exec("PRAGMA busy_timeout = 0");

    const originalFreshness = reader.store.projectionFreshness.bind(reader.store);
    let blockedAttempt: Promise<unknown> | null = null;
    let armed = true;
    reader.store.projectionFreshness = () => {
      const freshness = originalFreshness();
      if (armed) {
        armed = false;
        // This hook runs after the freshness SELECT but before getItem's
        // derived-table SELECT. The reader already owns BEGIN IMMEDIATE, so a
        // second governed connection cannot enter its own write transaction
        // inside the critical window.
        blockedAttempt = writer.service.revoke(
          proposed.memoryId,
          "owner",
          "synthetic concurrent owner revoke",
        );
      }
      return freshness;
    };

    const beforeCommit = reader.store.getItem(proposed.memoryId);
    reader.store.projectionFreshness = originalFreshness;
    assert.notEqual(beforeCommit, undefined);
    assert.equal(beforeCommit!.lifecycle_state, "active");
    assert.notEqual(blockedAttempt, null);
    await assert.rejects(blockedAttempt!, /locked|busy/u);

    const revoked = await writer.service.revoke(
      proposed.memoryId,
      "owner",
      "synthetic concurrent owner revoke after reader commit",
    );
    assert.equal(revoked.status, "ok");

    const afterCommit = reader.store.getItem(proposed.memoryId);
    assert.notEqual(afterCommit, undefined);
    assert.equal(afterCommit!.lifecycle_state, "revoked");
    assert.equal(afterCommit!.retrieval, "disabled");
    assert.deepEqual(retrievalBodies(reader, "projection concurrency"), []);
  } finally {
    writer.handle.log.close();
    reader?.log.close();
    rmSync(root, { recursive: true, force: true });
  }
});
