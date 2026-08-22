/**
 * T05D CLI: `npm run backlog-status`.
 *
 * Reads the durable decision queue and prints progress. Read-only: it opens the
 * database with `readOnly: true`, so running it while the live worker is draining
 * cannot interfere with the drain.
 *
 * Exit codes:
 *   0   the queue is complete, draining, or has too little evidence to project
 *   10  the queue is STALLED — remaining work and nothing settling
 *   20  an INTEGRITY problem: a receipt with no durable state, i.e. a loss
 *   30  usage
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  type BacklogSnapshot, computeProgress, formatProgress, type ProgressInput,
} from "../../../core/services/backlog-progress.js";

function backlogPath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const rootDir = resolve(here, "..", "..", "..", "..");
  return process.env["DELOS_BACKLOG_DB"] ?? join(rootDir, "data", "memory", "decision-backlog.db");
}

export function readProgressInput(path: string, nowIso: string, hourlyBudget: number | null): ProgressInput {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT origin, state, COUNT(*) AS n FROM backlog_items GROUP BY 1,2").all() as
      Array<{ origin: string; state: string; n: number }>;
    const receipts = db.prepare(
      "SELECT origin, COUNT(DISTINCT r.identity) AS n FROM backlog_receipts r "
      + "JOIN backlog_items i ON i.identity = r.identity GROUP BY 1").all() as
      Array<{ origin: string; n: number }>;
    const hourly = db.prepare(
      "SELECT substr(at,1,13) AS hour, COUNT(*) AS settled FROM backlog_receipts "
      + "WHERE from_state = 'processing' AND to_state IN "
      + "('declined','duplicate','policy_activated','quarantined','failed_terminal') "
      + "GROUP BY 1 ORDER BY 1 DESC LIMIT 48").all() as
      Array<{ hour: string; settled: number }>;

    const snap = (origin: string): BacklogSnapshot => ({
      byState: Object.fromEntries(rows.filter((r) => r.origin === origin).map((r) => [r.state, r.n])),
      receipts: receipts.find((r) => r.origin === origin)?.n ?? 0,
    });
    return {
      live: snap("live"),
      backfill: snap("backfill"),
      hourlySettled: hourly,
      nowIso,
      hourlyBudget,
    };
  } finally {
    db.close();
  }
}

export function main(argv: readonly string[]): number {
  if (argv.includes("--help")) {
    process.stdout.write([
      "delos backlog-status — how far along the memory queue is",
      "",
      "Prints counts, a measured rate and a completion estimate. Never prints a",
      "memory body, title, pointer or identity: the progress type does not carry them.",
      "",
      "exit: 0 ok | 10 stalled | 20 integrity loss | 30 usage",
      "",
    ].join("\n"));
    return 30;
  }
  const path = backlogPath();
  if (!existsSync(path)) {
    process.stdout.write("no decision backlog yet\n");
    return 0;
  }
  const input = readProgressInput(path, new Date().toISOString(), null);
  const progress = computeProgress(input);
  process.stdout.write(formatProgress(progress) + "\n");
  if (!progress.arithmeticCloses) return 20;
  return progress.confidence === "stalled" ? 10 : 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
