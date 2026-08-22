/**
 * T05C CLI: `npm run health -- [check|reconstruct|schedule]`.
 *
 * Exit codes, because a scheduler is the caller:
 *
 *   0   HEALTHY   (possibly after silent automatic repairs)
 *   10  DEGRADED  one path isolated; the rest of the system is intact
 *   20  HALT      a fault where continuing could destroy truth
 *   30  usage
 *
 * Exception-only by construction: a HEALTHY run prints the receipt to stdout for
 * the journal and writes NOTHING to stderr. Owner hears from this job when something
 * is wrong, which is the operator covenant, not when it worked.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type HealthPaths, reconstructionOptions, runHealth } from "../health-runtime.js";
import { HEALTH_CHECK_IDS } from "../../../core/services/reliability-core.js";
import { systemdUserTimerUnits } from "../../platform/systemd-scheduler.js";
import type { ScheduledJob } from "../../../core/ports/backup-ports.js";

export const HEALTH_JOB: ScheduledJob = {
  id: "delos-health",
  description: "Delos health check: single writer, queue arithmetic, integrity, backup freshness",
  schedule: "hourly:07",
  catchUpMissed: true,
  timeoutSeconds: 5 * 60,
};

function resolvePaths(): HealthPaths {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const rootDir = resolve(here, "..", "..", "..", "..");
  const dataDir = join(rootDir, "data");
  const stateBase = process.env["DELOS_STATE_BASE"] ?? join(homedir(), ".delos");
  const episodeProjection = join(dataDir, "memory", "episodes.db");
  return {
    mnemosynePath: join(dataDir, "memory", "delos-memory.db"),
    episodeProjectionPath: episodeProjection,
    backlogPath: join(dataDir, "memory", "decision-backlog.db"),
    telegramStateDir: join(dataDir, "telegram"),
    lockPath: join(dataDir, "telegram", "lock"),
    backupRoot: process.env["DELOS_BACKUP_ROOT"] ?? join(stateBase, "backups"),
    receiptRoot: process.env["DELOS_RECEIPT_ROOT"] ?? join(stateBase, "receipts"),
    stateVolumePath: dataDir,
    backupFreshnessBoundHours: 26,
    // A turn Owner just had should become memory within the hour. The historical
    // backfill is measured by progress instead, not by this.
    liveQueueSloSeconds: 3600,
    freeBytesFloor: 512 * 1024 * 1024,
    pollerCommandFragment: "adapters/runtime/telegram/main.js",
    providerEgressProxyUrl: process.env["HTTPS_PROXY"] ?? null,
    providerCredentialClaudeBin: process.env["DELOS_CLAUDE_BIN"] ?? null,
    providerCredentialFilePath: join(homedir(), ".claude", ".credentials.json"),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const verb = argv[0] ?? "check";

  if (verb === "check") {
    const out = await runHealth(resolvePaths());
    const lines = [`verdict    ${out.receipt.verdict}`];
    for (const c of out.receipt.checks) {
      lines.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.id.padEnd(26)} ${c.detail}`);
    }
    if (out.repairsApplied.length > 0) {
      lines.push("repairs    (applied silently; recorded, not escalated)");
      for (const r of out.repairsApplied) lines.push(`  - ${r}`);
    }
    if (out.receiptPath !== null) lines.push(`receipt    ${out.receiptPath}`);
    process.stdout.write(lines.join("\n") + "\n");
    if (out.receipt.operatorLine !== "") process.stderr.write(out.receipt.operatorLine + "\n");
    return out.receipt.verdict === "HEALTHY" ? 0 : out.receipt.verdict === "DEGRADED" ? 10 : 20;
  }

  if (verb === "reconstruct") {
    // Report only. Rebuilding a derived artifact is a mutation, so it belongs to a
    // named job with a rollback, not to a `--dry-run`-less flag on a status verb.
    const available = ["transcripts", "mnemosyne:memory_events", "mnemosyne:memory_items",
      "mnemosyne:memory_tags"];
    for (const p of reconstructionOptions(available)) {
      process.stdout.write(
        `${p.safe ? "REBUILDABLE" : "REFUSED    "} ${p.target.padEnd(26)} `
        + (p.safe ? `from ${p.derivedFrom.join(", ")}` : p.refusal ?? "") + "\n");
    }
    return 0;
  }

  if (verb === "schedule") {
    const units = systemdUserTimerUnits(HEALTH_JOB, {
      workingDirectory: resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", ".."),
      execStart: "/usr/bin/env node build/adapters/runtime/cli/health-main.js check",
    });
    process.stdout.write(`# ${units.serviceName}\n${units.serviceUnit}\n`);
    process.stdout.write(`# ${units.timerName}\n${units.timerUnit}\n`);
    return 0;
  }

  process.stdout.write([
    "delos health — unattended reliability check",
    "",
    "  check        run every check, apply the automatic repairs, write a receipt",
    "  reconstruct  report which derived artifacts may be rebuilt, and which may not",
    "  schedule     print the systemd user units for the hourly job",
    "",
    `checks: ${HEALTH_CHECK_IDS.join(", ")}`,
    "exit: 0 healthy | 10 degraded | 20 halt | 30 usage",
    "",
  ].join("\n"));
  return 30;
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
