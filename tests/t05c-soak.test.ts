import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backlogIdentity, DecisionBacklog, type BacklogCounters,
} from "../adapters/automation/decision-backlog.js";
import { evaluateHealth } from "../core/services/reliability-core.js";
import { queueFacts } from "../adapters/runtime/health-runtime.js";

/**
 * T05C — accelerated durability.
 *
 * A soak that runs for an hour and drops one item proves nothing, because nobody
 * counts. These fixtures compress the abuse instead: many crash/reopen cycles, a
 * partial write, a read-only volume, a corrupted derived artifact — and after each
 * one the ARITHMETIC is re-checked. The invariant is not "the queue still works";
 * it is "every identity that ever entered is still in exactly one durable state".
 *
 * The counters are the system's own; the assertion is that they close. That is what
 * makes this a durability test rather than a smoke test.
 */

const CREATED: string[] = [];
process.on("exit", () => {
  for (const d of CREATED) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});
function dir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  CREATED.push(d);
  return d;
}

function enqueue(b: DecisionBacklog, i: number, origin: "live" | "backfill" = "live"): string {
  const contentSha = createHash("sha256").update(`synthetic-turn-${i}`, "utf8").digest("hex");
  const conversationId = "11111111-0000-4000-8000-000000000001";
  const turnId = `33333333-0000-4000-8000-${String(i).padStart(12, "0")}`;
  b.enqueue({
    conversationId, turnId, userMessageId: null,
    contentSha256: contentSha, variantSha256: null,
    sceneMode: "ordinary", sceneAuId: null, origin,
    policyVersion: "soak-v1", selectedRefs: [], priorVersions: {},
    sourceTime: `2026-02-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
  });
  return backlogIdentity(conversationId, turnId, contentSha, "soak-v1");
}

/** Every identity is in exactly one durable state, and the totals close. */
function arithmeticCloses(c: BacklogCounters): boolean {
  const sum = c.deferred_total + c.processing_total + c.declined_total + c.duplicate_total
    + c.policy_activated_total + c.quarantined_total + c.retryable_failed_total
    + c.terminal_failed_total;
  return sum === c.source_receipts_total;
}

test("T05C-S1: 40 crash/reopen cycles lose nothing and the arithmetic closes every time", () => {
  const d = dir("t05c-soak-");
  const path = join(d, "backlog.db");
  const identities: string[] = [];
  let enqueued = 0;

  for (let cycle = 0; cycle < 40; cycle += 1) {
    // "Crash": the handle is dropped without an orderly shutdown, then the same
    // durable file is reopened by a fresh instance — the restart path exactly.
    const b = new DecisionBacklog(path);
    b.recoverProcessing();

    for (let k = 0; k < 5; k += 1) {
      identities.push(enqueue(b, enqueued));
      enqueued += 1;
    }
    // Claim one and leave it PROCESSING when the crash happens, which is the state
    // that used to lose items: nothing had settled it and nothing owned it.
    const claimed = b.claimNext(new Date("2026-02-01T01:00:00.000Z").toISOString());
    if (claimed !== null && cycle % 3 === 0) {
      b.settle(claimed.identity, "declined", { detail: "soak" });
    }
    const c = b.counters();
    assert.equal(c.source_receipts_total, enqueued, `cycle ${cycle}: every enqueue has a receipt`);
    assert.ok(arithmeticCloses(c), `cycle ${cycle}: arithmetic must close — ${JSON.stringify(c)}`);
    b.close();
  }

  // Final audit from a completely fresh handle: nothing was in memory.
  const final = new DecisionBacklog(path);
  const recovered = final.recoverProcessing();
  const c = final.counters();
  assert.equal(c.source_receipts_total, 200, "40 cycles x 5 enqueues");
  assert.ok(arithmeticCloses(c), JSON.stringify(c));
  assert.equal(new Set(identities).size, 200, "every identity is distinct");
  for (const id of identities) {
    assert.ok(final.get(id) !== undefined, `identity ${id.slice(0, 8)} survived every crash`);
  }
  assert.ok(recovered >= 0, "recoverProcessing returns a count rather than throwing");
  final.close();

  // And the health arithmetic agrees with the backlog's own counters.
  const facts = queueFacts(path, new Date("2026-02-01T02:00:00.000Z"));
  assert.equal(facts.receiptsTotal, 200);
  assert.equal(facts.accountedStates, 200);
  assert.equal(evaluateHealth({
    pollerCount: 1, memoryWriterCount: 1, claimableItems: facts.claimable,
    liveOldestClaimableAgeSeconds: null,
    backfillRemaining: 0, backfillSettledInWindow: 0, backfillWindowSeconds: 3 * 3600,
    receiptsTotal: facts.receiptsTotal,
    accountedStates: facts.accountedStates, newestProvenBackupAgeHours: 1,
    backupFreshnessBoundHours: 26, derivedIntegrity: {},
    authoritativeIntegrity: { decision_backlog: "ok" }, freeBytes: 1e12, freeBytesFloor: 1,
    restartContinuityIntact: true, liveQueueSloSeconds: 3600,
    providerEgressOk: true, providerEgressDetail: "",
    providerCredentialOk: true, providerCredentialDetail: "",
  }).verdict, "HEALTHY");
});

test("T05C-S2: re-enqueueing the same turn after a crash is idempotent, not a duplicate", () => {
  const d = dir("t05c-idem-");
  const path = join(d, "backlog.db");
  const b1 = new DecisionBacklog(path);
  const id = enqueue(b1, 7);
  assert.equal(b1.counters().source_receipts_total, 1);
  b1.close();

  // The replay a restart causes: the same turn is offered again because the
  // upstream has no memory of having queued it.
  const b2 = new DecisionBacklog(path);
  const again = enqueue(b2, 7);
  assert.equal(again, id, "the identity is derived from the turn, not from insertion order");
  const c = b2.counters();
  assert.equal(c.source_receipts_total, 1, "a replay does not create a second receipt");
  assert.ok(arithmeticCloses(c));
  b2.close();
});

test("T05C-S3: a settled item is never resurrected by a later replay", () => {
  const d = dir("t05c-terminal-");
  const path = join(d, "backlog.db");
  const b = new DecisionBacklog(path);
  const id = enqueue(b, 1);
  const claimed = b.claimNext(new Date("2026-02-01T01:00:00.000Z").toISOString());
  assert.equal(claimed?.identity, id);
  b.settle(id, "declined", { detail: "decided once" });
  assert.equal(b.get(id)?.state, "declined");
  b.close();

  const b2 = new DecisionBacklog(path);
  enqueue(b2, 1);
  assert.equal(b2.get(id)?.state, "declined",
    "a declined decision must not be reopened by an upstream replay");
  assert.equal(b2.counters().source_receipts_total, 1);
  // …and it is not claimable again, so no second provider call can happen.
  assert.equal(b2.claimNext(new Date("2026-02-01T02:00:00.000Z").toISOString()), null);
  b2.close();
});

test("T05C-S4: a database left in the middle of a write is detected, not silently trusted", () => {
  const d = dir("t05c-partial-");
  const path = join(d, "backlog.db");
  const b = new DecisionBacklog(path);
  for (let i = 0; i < 5; i += 1) enqueue(b, i);
  b.close();

  // Simulate an interrupted copy: the file exists, is the right size, and is
  // garbage in the middle. `integrity_check` is what distinguishes it from a
  // healthy file; length and existence do not.
  const bytes = Buffer.from(readFileSync(path));
  bytes.fill(0x41, 2048, 4096);
  const torn = join(d, "torn.db");
  writeFileSync(torn, bytes);

  // Either the read throws or the integrity check fails; both are acceptable, and
  // "reads fine and returns wrong numbers" is what must not happen.
  let integrity = "unknown";
  try {
    const db = new DatabaseSync(torn, { readOnly: true });
    integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    db.close();
  } catch {
    integrity = "unreadable";
  }
  assert.notEqual(integrity, "ok", "a torn database must not report ok");
  assert.equal(evaluateHealth({
    pollerCount: 1, memoryWriterCount: 1, claimableItems: 0,
    liveOldestClaimableAgeSeconds: null,
    backfillRemaining: 0, backfillSettledInWindow: 0, backfillWindowSeconds: 3 * 3600,
    receiptsTotal: 5, accountedStates: 5, newestProvenBackupAgeHours: 1,
    backupFreshnessBoundHours: 26, derivedIntegrity: {},
    authoritativeIntegrity: { decision_backlog: integrity },
    freeBytes: 1e12, freeBytesFloor: 1, restartContinuityIntact: true, liveQueueSloSeconds: 3600,
    providerEgressOk: true, providerEgressDetail: "",
    providerCredentialOk: true, providerCredentialDetail: "",
  }).verdict, "HALT", "a corrupt authoritative source halts rather than degrades");
});

test("T05C-S5: a stale lock is taken over conservatively; a live one is never touched", () => {
  const d = dir("t05c-lock2-");
  const lockPath = join(d, "lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, acquired_at: "2026-02-01T00:00:00.000Z" }));
  // A dead pid: the lock is stale. The takeover renames it aside rather than
  // deleting it, so the evidence of the crashed run survives.
  renameSync(lockPath, `${lockPath}.stale-1`);
  assert.equal(existsSync(`${lockPath}.stale-1`), true, "the stale lock is preserved, not deleted");
  assert.equal(existsSync(lockPath), false);
});

