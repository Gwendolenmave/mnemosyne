import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHORITATIVE_SOURCES, backoffMs, DERIVED_ARTIFACTS, DISPOSITION, evaluateHealth,
  FAULT_KINDS, HEALTH_CHECK_IDS, NEVER_AUTO_REPAIR, planReconstruction, ruleFault,
  type Fault, type HealthObservation,
} from "../core/services/reliability-core.js";
import {
  derivedIntegrityOf, observeHealth, queueFacts, runHealth, scanProcessCount,
} from "../adapters/runtime/health-runtime.js";
import { HEALTH_JOB } from "../adapters/runtime/cli/health-main.js";
import { systemdUserTimerUnits } from "../adapters/platform/systemd-scheduler.js";

const CREATED: string[] = [];
process.on("exit", () => {
  for (const d of CREATED) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});
function disposable(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  CREATED.push(d);
  return d;
}

const HEALTHY: HealthObservation = {
  pollerCount: 1,
  memoryWriterCount: 1,
  claimableItems: 4,
  liveOldestClaimableAgeSeconds: 300,
  backfillRemaining: 800,
  backfillSettledInWindow: 41,
  backfillWindowSeconds: 3 * 3600,
  receiptsTotal: 120,
  accountedStates: 120,
  newestProvenBackupAgeHours: 3,
  backupFreshnessBoundHours: 26,
  derivedIntegrity: { fts_items: "ok" },
  authoritativeIntegrity: { mnemosyne: "ok", decision_backlog: "ok" },
  freeBytes: 10 * 1024 * 1024 * 1024,
  freeBytesFloor: 512 * 1024 * 1024,
  restartContinuityIntact: true,
  liveQueueSloSeconds: 3600,
  providerEgressOk: true,
  providerEgressDetail: "",
  providerCredentialOk: true,
  providerCredentialDetail: "",
};

// ---------------------------------------------------------------------------
// The disposition table
// ---------------------------------------------------------------------------

test("T05C-R1: every fault kind has a decided disposition", () => {
  for (const k of FAULT_KINDS) {
    assert.ok(DISPOSITION[k] !== undefined, `${k} has no disposition`);
  }
  assert.equal(Object.keys(DISPOSITION).length, FAULT_KINDS.length,
    "no disposition exists for an undeclared fault kind");
});

test("T05C-R2: the faults that must never self-repair, never do", () => {
  // This is the load-bearing row of the tranche. An automatic "repair" of an
  // authoritative source is indistinguishable from data destruction, and every
  // T05A incident began with a derived repair acquiring content authority.
  for (const k of NEVER_AUTO_REPAIR) {
    assert.notEqual(DISPOSITION[k], "auto_repair", `${k} must never auto-repair`);
    assert.notEqual(DISPOSITION[k], "retry_bounded", `${k} must not be retried into silence`);
    const ruling = ruleFault({ kind: k, detail: "d", subject: "s" }, { count: 0, budget: 3 });
    assert.equal(ruling.notifyOperator, true, `${k} must reach the operator`);
  }
  assert.equal(DISPOSITION["corrupt_authoritative_state"], "fail_closed_halt");
  assert.equal(DISPOSITION["unexplained_truth_mutation"], "fail_closed_halt");
  assert.equal(DISPOSITION["containment_breach"], "fail_closed_halt");
  assert.equal(DISPOSITION["duplicate_writer"], "fail_closed_halt");
});

test("T05C-R3: ordinary faults repair silently; a repair is still recorded", () => {
  for (const k of ["disk_full", "corrupt_derived_state", "partial_write", "stale_lock"] as const) {
    const r = ruleFault({ kind: k, detail: "d", subject: "s" }, { count: 0, budget: 3 });
    assert.equal(r.disposition, "auto_repair", k);
    assert.equal(r.notifyOperator, false, `${k} must not wake anybody up`);
    assert.match(r.action, /automatically/, "the action still says what will happen");
  }
});

test("T05C-R4: a retry becomes an exception only when its budget is exhausted", () => {
  const f: Fault = { kind: "provider_outage", detail: "timeout", subject: "provider" };
  const early = ruleFault(f, { count: 1, budget: 3 });
  assert.equal(early.disposition, "retry_bounded");
  assert.equal(early.notifyOperator, false, "a transient outage inside budget is silent");
  const late = ruleFault(f, { count: 3, budget: 3 });
  assert.equal(late.disposition, "fail_closed_degraded");
  assert.equal(late.notifyOperator, true, "an exhausted budget is an exception");
  assert.match(late.action, /isolated, the rest keeps running/);

  // Backoff grows and is capped, so a dead provider cannot become a hot loop.
  assert.ok(backoffMs(1, 0.5) < backoffMs(4, 0.5));
  assert.ok(backoffMs(50, 0.5) <= 30 * 60_000 * 1.25);
  assert.ok(backoffMs(1, 0) > 0, "jitter never collapses the delay to zero");
});

// ---------------------------------------------------------------------------
// Health, and each check's falsifiability
// ---------------------------------------------------------------------------

test("T05C-R5: a healthy system is HEALTHY and says nothing", () => {
  const r = evaluateHealth(HEALTHY);
  assert.equal(r.verdict, "HEALTHY");
  assert.deepEqual(r.faults, []);
  assert.equal(r.operatorLine, "", "silence is the success signal");
  assert.equal(r.checks.length, HEALTH_CHECK_IDS.length);
  assert.deepEqual([...r.checks].map((c) => c.id).sort(), [...HEALTH_CHECK_IDS].sort());
  for (const c of r.checks) assert.notEqual(c.detail, "", `${c.id} carries a detail when passing`);
});

test("T05C-R6: EVERY health check can be made to fail on its own", () => {
  const cases: Array<[typeof HEALTH_CHECK_IDS[number], Partial<HealthObservation>]> = [
    ["single_poller", { pollerCount: 2, memoryWriterCount: 1 }],
    ["single_memory_writer", { memoryWriterCount: 2 }],
    ["live_queue_latency", { liveOldestClaimableAgeSeconds: 2 * 3600 }],
    ["backfill_progressing", { backfillRemaining: 500, backfillSettledInWindow: 0 }],
    ["no_silent_drops", { accountedStates: 119 }],
    ["backup_freshness", { newestProvenBackupAgeHours: 100 }],
    ["derived_state_integrity", { derivedIntegrity: { fts_items: "malformed index" } }],
    ["authoritative_integrity", { authoritativeIntegrity: { mnemosyne: "page 4 corrupt" } }],
    ["disk_headroom", { freeBytes: 1024 }],
    ["restart_continuity", { restartContinuityIntact: false }],
    ["provider_egress", { providerEgressOk: false, providerEgressDetail: "blackhole" }],
    ["provider_credential", { providerCredentialOk: false, providerCredentialDetail: "corrupt" }],
  ];
  assert.equal(cases.length, HEALTH_CHECK_IDS.length, "one falsifying case per check");
  for (const [id, over] of cases) {
    const r = evaluateHealth({ ...HEALTHY, ...over });
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.id);
    assert.ok(failed.includes(id), `${id} must be able to fail; failed=${failed.join(",")}`);
  }
});

test("T05C-R7: an empty authoritative-integrity set is a failure, not a pass", () => {
  // The most dangerous hollow check: nothing was inspected, so nothing was wrong.
  const r = evaluateHealth({ ...HEALTHY, authoritativeIntegrity: {} });
  const check = r.checks.find((c) => c.id === "authoritative_integrity")!;
  assert.equal(check.ok, false);
  assert.match(check.detail, /empty set is not a pass/);
  assert.equal(r.verdict, "HALT", "unverified truth is a halt, not a warning");
});

test("T05C-R8: a second writer HALTS; a stale backup only DEGRADES", () => {
  const two = evaluateHealth({ ...HEALTHY, pollerCount: 2, memoryWriterCount: 2 });
  assert.equal(two.verdict, "HALT");
  assert.match(two.operatorLine, /duplicate_writer/);

  const stale = evaluateHealth({ ...HEALTHY, newestProvenBackupAgeHours: 400 });
  assert.equal(stale.verdict, "DEGRADED", "a stale backup must not stop the companion running");
  assert.match(stale.operatorLine, /backup_stale/);

  // A silent drop is a truth mutation, so it halts.
  const dropped = evaluateHealth({ ...HEALTHY, accountedStates: 100 });
  assert.equal(dropped.verdict, "HALT");
  assert.match(dropped.operatorLine, /unexplained_truth_mutation/);
});

test("T05C-R8b: a FAILING check can never sit above a HEALTHY verdict", () => {
  // The defect this row exists for, found on the live system: the queue's oldest
  // claimable item was past its SLO, the receipt printed
  //   FAIL queue_draining ...
  //   verdict HEALTHY
  // and nothing would ever have escalated it, because the evaluator called
  // ruleFault with a hardcoded attempt count of 0 and `queue_stalled` is
  // retry_bounded. The health check is an observer: by the time it sees a
  // retryable condition, the retry machinery has already failed to keep up.
  const stalled = evaluateHealth({ ...HEALTHY, liveOldestClaimableAgeSeconds: 2 * 3600 });
  const failing = stalled.checks.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(failing, ["live_queue_latency"], "exactly the one check fails");
  assert.notEqual(stalled.verdict, "HEALTHY",
    "a failing check must move the verdict off HEALTHY");
  assert.equal(stalled.verdict, "DEGRADED");
  assert.match(stalled.operatorLine, /queue_stalled/, "and it reaches the operator");

  // The general invariant, over every falsifying case: no check may fail while the
  // verdict stays HEALTHY unless the fault is genuinely auto-repairable.
  const cases: Array<Partial<HealthObservation>> = [
    { pollerCount: 2, memoryWriterCount: 1 }, { memoryWriterCount: 2 },
    { liveOldestClaimableAgeSeconds: 2 * 3600 },
    { backfillRemaining: 500, backfillSettledInWindow: 0 }, { accountedStates: 119 },
    { newestProvenBackupAgeHours: 100 },
    { authoritativeIntegrity: { mnemosyne: "page 4 corrupt" } },
    { restartContinuityIntact: false },
  ];
  for (const over of cases) {
    const r = evaluateHealth({ ...HEALTHY, ...over });
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.id);
    const allAutoRepairable = r.faults.every((f) => DISPOSITION[f.kind] === "auto_repair");
    if (failed.length > 0 && !allAutoRepairable) {
      assert.notEqual(r.verdict, "HEALTHY",
        `${JSON.stringify(over)} fails ${failed.join(",")} yet reports HEALTHY`);
      assert.notEqual(r.operatorLine, "", `${JSON.stringify(over)} must say something`);
    }
  }
});

test("T05C-R8c: a healthy long drain stays SILENT; only a stall or live latency speaks", () => {
  // Why the queue check is split at all. The first version measured the age of the
  // oldest claimable item against a 6h SLO. On the live system that read
  //   FAIL queue_draining  oldest claimable 23722s (SLO 21600s), 745 items
  // for an 871-item historical recovery that was draining correctly at 13.6/hour
  // and would take two days. The oldest item in an ordered backfill stays oldest
  // until it is reached, so an age-based SLO alerts continuously for the entire
  // expected duration — and an alarm that is always on is one Owner mutes, after
  // which the real alarm is invisible too.
  const longDrain = evaluateHealth({
    ...HEALTHY,
    liveOldestClaimableAgeSeconds: null,     // live turns are keeping up
    backfillRemaining: 745,                  // two days of work left
    backfillSettledInWindow: 41,             // and it IS moving
  });
  assert.equal(longDrain.verdict, "HEALTHY", "a long but progressing drain is not a fault");
  assert.equal(longDrain.operatorLine, "", "and it says nothing at all");

  // A backfill with work left and NOTHING settling is the real stall.
  const reallyStalled = evaluateHealth({
    ...HEALTHY, liveOldestClaimableAgeSeconds: null,
    backfillRemaining: 745, backfillSettledInWindow: 0,
  });
  assert.equal(reallyStalled.verdict, "DEGRADED");
  assert.match(reallyStalled.checks.find((c) => c.id === "backfill_progressing")!.detail,
    /745 remaining, 0 settled/);
  assert.match(reallyStalled.operatorLine, /historical_recovery/);

  // A live turn waiting longer than an hour is urgent even while the backfill is fine.
  const liveLate = evaluateHealth({
    ...HEALTHY, liveOldestClaimableAgeSeconds: 2 * 3600,
    backfillRemaining: 745, backfillSettledInWindow: 41,
  });
  assert.equal(liveLate.verdict, "DEGRADED");
  assert.match(liveLate.operatorLine, /live_decision_queue/);

  // A finished recovery is reported as finished, not as an empty stall.
  const done = evaluateHealth({
    ...HEALTHY, liveOldestClaimableAgeSeconds: null,
    backfillRemaining: 0, backfillSettledInWindow: 0,
  });
  assert.equal(done.verdict, "HEALTHY");
  assert.match(done.checks.find((c) => c.id === "backfill_progressing")!.detail, /complete/);
});

test("T05C-R9: an auto-repairable fault does not reach the operator line", () => {
  const full = evaluateHealth({ ...HEALTHY, freeBytes: 1024 });
  assert.ok(full.faults.some((f) => f.kind === "disk_full"), "the fault IS recorded");
  assert.equal(full.operatorLine, "", "…and it is not escalated");
  assert.equal(full.verdict, "HEALTHY", "a repairable fault does not degrade the verdict");
});

// ---------------------------------------------------------------------------
// Derived-state reconstruction
// ---------------------------------------------------------------------------

test("T05C-R10: authoritative sources are RESTORED, never rebuilt", () => {
  for (const src of AUTHORITATIVE_SOURCES) {
    const p = planReconstruction(src, [...AUTHORITATIVE_SOURCES]);
    assert.equal(p.safe, false, `${src} must never be rebuildable`);
    assert.match(p.refusal ?? "", /restore it from a proven backup/);
    assert.match(p.refusal ?? "", /fabricate the truth/);
  }
});

test("T05C-R11: a derived artifact is rebuildable only with all its inputs", () => {
  for (const [target, inputs] of Object.entries(DERIVED_ARTIFACTS)) {
    const full = planReconstruction(target, inputs);
    assert.equal(full.safe, true, `${target} with all inputs`);
    assert.deepEqual([...full.derivedFrom].sort(), [...inputs].sort());
    for (const drop of inputs) {
      const partial = planReconstruction(target, inputs.filter((i) => i !== drop));
      assert.equal(partial.safe, false, `${target} without ${drop} must refuse`);
      assert.match(partial.refusal ?? "", new RegExp(drop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
  const unknown = planReconstruction("something_invented", ["transcripts"]);
  assert.equal(unknown.safe, false);
  assert.match(unknown.refusal ?? "", /not declared derivable/);
});

// ---------------------------------------------------------------------------
// Observation against a real (synthetic) tree
// ---------------------------------------------------------------------------

function syntheticBacklog(
  path: string,
  opts: { items: number; distinctReceipts: number; origin?: "live" | "backfill" },
): void {
  const origin = opts.origin ?? "backfill";
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE migration_ledger (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE backlog_items (identity TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL, queued_at TEXT NOT NULL);
    CREATE TABLE backlog_receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL,
      at TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, detail TEXT);
  `);
  const item = db.prepare("INSERT INTO backlog_items VALUES (?,?,?,?,?,?)");
  const rec = db.prepare("INSERT INTO backlog_receipts (identity,at,from_state,to_state,detail) VALUES (?,?,?,?,?)");
  for (let i = 0; i < opts.distinctReceipts; i += 1) {
    const id = `id-${i}`;
    rec.run(id, "2026-02-01T00:00:00.000Z", null, "deferred", "enqueued");
    if (i < opts.items) item.run(id, "c", `t-${i}`, origin, "deferred", "2026-02-01T00:00:00.000Z");
  }
  db.close();
}

test("T05C-R12: queue arithmetic sees a DROP that queue length cannot", () => {
  const dir = disposable("t05c-queue-");
  const intact = join(dir, "intact.db");
  syntheticBacklog(intact, { items: 10, distinctReceipts: 10 });
  const f1 = queueFacts(intact, new Date("2026-02-01T01:00:00.000Z"));
  assert.equal(f1.receiptsTotal, 10);
  assert.equal(f1.accountedStates, 10);
  assert.equal(f1.claimable, 10);
  assert.equal(f1.liveOldestClaimableAgeSeconds, null, "the synthetic rows are backfill-less; live age is null");

  // Two identities have receipts but no row: exactly what a silent drop looks like.
  const lossy = join(dir, "lossy.db");
  syntheticBacklog(lossy, { items: 8, distinctReceipts: 10 });
  const f2 = queueFacts(lossy, new Date("2026-02-01T01:00:00.000Z"));
  assert.equal(f2.receiptsTotal, 10);
  assert.equal(f2.accountedStates, 8, "the loss is visible in the arithmetic");
  assert.equal(f2.claimable, 8, "…and INVISIBLE in the length, which is the point");

  const r = evaluateHealth({
    ...HEALTHY, receiptsTotal: f2.receiptsTotal, accountedStates: f2.accountedStates,
  });
  assert.equal(r.verdict, "HALT");
});

test("T05C-R13: a live poller running WITHOUT the lock is reported, not rounded down", () => {
  const dir = disposable("t05c-lock-");
  const stateDir = join(dir, "telegram");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ offset: 1 }));
  const backlog = join(dir, "backlog.db");
  syntheticBacklog(backlog, { items: 0, distinctReceipts: 0 });

  // No lock file at all: the lock says zero holders. The process scan is the only
  // thing that could see an unlocked poller, so the larger count must win.
  const paths = {
    mnemosynePath: join(dir, "absent.db"),
    backlogPath: backlog,
    telegramStateDir: stateDir,
    lockPath: join(stateDir, "lock"),
    backupRoot: join(dir, "backups"),
    receiptRoot: join(dir, "receipts"),
    stateVolumePath: dir,
    backupFreshnessBoundHours: 26,
    liveQueueSloSeconds: 3600,
    freeBytesFloor: 1,
    // This process is running node with this test file in its cmdline, so the
    // scan finds at least one match — a real observation, not a stub.
    pollerCommandFragment: "t05c-reliability",
  };
  const o = observeHealth(paths as never, new Date("2026-02-01T00:00:00.000Z"));
  assert.ok(o.pollerCount >= 1,
    "a process matching the poller fragment counts even with no lock held");
  assert.equal(scanProcessCount("this-fragment-matches-nothing-at-all"), 0);
  // An unobservable platform reports -1, never 0: "unknown" must not read as "none".
  assert.notEqual(scanProcessCount("t05c-reliability"), -1);
});

test("T05C-R14: a health run writes an append-only receipt and never overwrites one", async () => {
  const dir = disposable("t05c-receipt-");
  const stateDir = join(dir, "telegram");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ offset: 9 }));
  const backlog = join(dir, "backlog.db");
  syntheticBacklog(backlog, { items: 1, distinctReceipts: 1 });
  const paths = {
    mnemosynePath: join(dir, "absent.db"),
    backlogPath: backlog,
    telegramStateDir: stateDir,
    lockPath: join(stateDir, "lock"),
    backupRoot: join(dir, "backups"),
    receiptRoot: join(dir, "receipts"),
    stateVolumePath: dir,
    backupFreshnessBoundHours: 26,
    liveQueueSloSeconds: 3600,
    freeBytesFloor: 1,
    pollerCommandFragment: "no-such-process-fragment",
    providerEgressProxyUrl: null,
    providerCredentialClaudeBin: null,
    providerCredentialFilePath: null,
  } as never;

  const at = new Date("2026-02-01T00:00:00.000Z");
  const first = await runHealth(paths, at);
  assert.ok(first.receiptPath !== null, "a receipt is written");
  // The same timestamp again must NOT overwrite: receipts are append-only, so the
  // second run declines the path rather than replacing evidence.
  const second = await runHealth(paths, at);
  assert.equal(second.receiptPath, null,
    "an existing receipt is never overwritten; the run reports it could not write");
  // The verdict is still computed and returned either way.
  assert.ok(["HEALTHY", "DEGRADED", "HALT"].includes(second.receipt.verdict));
});

test("T05C-R14b: the DERIVED integrity check is real — a stale projection is detected", () => {
  // The first version of observeHealth passed an empty derived map, so
  // `derived_state_integrity` reported "0_derived_ok" on every run and could not
  // fail. It shipped, and the live run printed it as a pass. This row is the
  // control that was missing: build a real mnemosyne, break only the PROJECTION,
  // and require the check to see it.
  const d = disposable("t05c-derived-");
  const mn = join(d, "mnemosyne.db");
  const db = new DatabaseSync(mn);
  db.exec(`
    CREATE TABLE memory_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);
    CREATE VIRTUAL TABLE fts_items USING fts5(item_id UNINDEXED, title_seg, body_seg);
  `);
  for (let i = 0; i < 4; i += 1) {
    db.prepare("INSERT INTO memory_items VALUES (?,?,?)").run(`m-${i}`, "t", "b");
    db.prepare("INSERT INTO fts_items (item_id, title_seg, body_seg) VALUES (?,?,?)").run(`m-${i}`, "t", "b");
  }
  assert.equal(derivedIntegrityOf(mn, null)["fts_items"], "ok",
    "a complete projection is ok");

  // Now lose one projection row: the pages are intact, the index is wrong, and the
  // card has become unfindable. `PRAGMA integrity_check` would still say ok.
  db.prepare("DELETE FROM fts_items WHERE item_id = 'm-2'").run();
  db.close();

  const stale = derivedIntegrityOf(mn, null)["fts_items"]!;
  assert.notEqual(stale, "ok", "a projection that lost a row must not report ok");
  assert.match(stale, /covers 3 of 4/, "and it says exactly how far off it is");

  const r = evaluateHealth({ ...HEALTHY, derivedIntegrity: { fts_items: stale } });
  assert.equal(r.checks.find((c) => c.id === "derived_state_integrity")!.ok, false);
  // A derived artifact is rebuildable, so this is a silent auto-repair rather than
  // an escalation — but it is RECORDED, which is the difference that matters.
  assert.equal(r.verdict, "HEALTHY");
  assert.ok(r.faults.some((f) => f.kind === "corrupt_derived_state"));
  assert.equal(r.operatorLine, "");
});

test("T05C-R14c: observeHealth WIRES the derived check — an empty map is a regression", () => {
  // R14b tests `derivedIntegrityOf` in isolation, which is not enough: the defect
  // that shipped was in the WIRING — observeHealth passed `{}` and the real
  // function was never called. A control aimed at the function would have stayed
  // green through exactly that bug. This row goes through observeHealth.
  const d = disposable("t05c-wiring-");
  const mn = join(d, "mnemosyne.db");
  const db = new DatabaseSync(mn);
  db.exec(`
    CREATE TABLE migration_ledger (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE memory_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);
    CREATE VIRTUAL TABLE fts_items USING fts5(item_id UNINDEXED, title_seg, body_seg);
  `);
  db.prepare("INSERT INTO migration_ledger VALUES (1,'x')").run();
  for (let i = 0; i < 3; i += 1) {
    db.prepare("INSERT INTO memory_items VALUES (?,?,?)").run(`m-${i}`, "t", "b");
  }
  // Zero projection rows for three cards: maximally stale.
  db.close();

  const stateDir = join(d, "telegram");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ offset: 1 }));
  const backlog = join(d, "backlog.db");
  syntheticBacklog(backlog, { items: 0, distinctReceipts: 0 });

  const o = observeHealth({
    mnemosynePath: mn,
    episodeProjectionPath: null,
    backlogPath: backlog,
    telegramStateDir: stateDir,
    lockPath: join(stateDir, "lock"),
    backupRoot: join(d, "backups"),
    receiptRoot: join(d, "receipts"),
    stateVolumePath: d,
    backupFreshnessBoundHours: 26,
    liveQueueSloSeconds: 3600,
    freeBytesFloor: 1,
    pollerCommandFragment: "no-such-process-fragment",
    providerEgressProxyUrl: null,
    providerCredentialClaudeBin: null,
    providerCredentialFilePath: null,
  }, new Date("2026-02-01T00:00:00.000Z"));

  assert.notDeepEqual(o.derivedIntegrity, {},
    "observeHealth must actually populate the derived map, not pass an empty object");
  assert.ok("fts_items" in o.derivedIntegrity, "the projection is among the derived artifacts");
  assert.notEqual(o.derivedIntegrity["fts_items"], "ok",
    "a projection covering 0 of 3 cards must not report ok through observeHealth");
  assert.equal(evaluateHealth(o).checks.find((c) => c.id === "derived_state_integrity")!.ok, false);
});

test("T05C-R15: the health job is scheduled hourly, bounded, and catches up", () => {
  const u = systemdUserTimerUnits(HEALTH_JOB, {
    workingDirectory: "/opt/delos", execStart: "/usr/bin/env node build/x.js check",
  });
  assert.equal(u.timerName, "delos-health.timer");
  assert.match(u.timerUnit, /OnCalendar=\*-\*-\* \*:07:00/);
  assert.match(u.timerUnit, /Persistent=true/);
  assert.match(u.serviceUnit, /^TimeoutStartSec=300$/m);
  assert.equal(/RuntimeMaxSec/.test(u.serviceUnit), false);
});
