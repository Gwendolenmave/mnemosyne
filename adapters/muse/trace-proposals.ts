/**
 * Muse shadow proposal pointers for the governance bridge. Traces are
 * pointer-only by G1 design (no text on disk); the deterministic link to
 * conversation content is the explicit turn_id, which equals the
 * transcript turn_id minted by ChatService for the same turn — proven by
 * ID equality, not hashes. Trace content itself never enters prompts or
 * memory; this reader only surfaces {traceId, turnId, memoryAction}.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MuseProposalPointer, MuseProposalSource } from "../telegram/governance.js";

export class MuseTraceProposalSource implements MuseProposalSource {
  constructor(private readonly tracesDir: string) {}

  list(): MuseProposalPointer[] {
    let names: string[];
    try {
      names = readdirSync(this.tracesDir);
    } catch {
      return [];
    }
    const proposals: MuseProposalPointer[] = [];
    for (const name of names.filter((n) => n.endsWith(".jsonl")).sort()) {
      let raw: string;
      try {
        raw = readFileSync(join(this.tracesDir, name), "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        let trace: Record<string, unknown>;
        try {
          trace = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (trace.invalid_for_metrics !== false) {
          continue;
        }
        const verdict = trace.verdict_summary;
        if (verdict === null || typeof verdict !== "object") {
          continue;
        }
        const memoryAction = (verdict as Record<string, unknown>).memory_action;
        if (typeof memoryAction !== "string" || memoryAction === "none") {
          continue;
        }
        if (typeof trace.trace_id !== "string" || typeof trace.turn_id !== "string") {
          continue;
        }
        proposals.push({
          traceId: trace.trace_id,
          turnId: trace.turn_id,
          memoryAction,
          seq: proposals.length,
        });
      }
    }
    return proposals;
  }
}
