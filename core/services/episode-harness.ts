/**
 * Offline evaluation harness — generic engine (L1-T01 foundation, §4.7).
 *
 * Reuses the mindstream-fixtures methodology: a declarative fixture expands
 * to a temporary transcript JSONL in an isolated directory, checks run
 * against it, and assertions touch ONLY metadata (counts, spans, ids,
 * hashes) — never message or summary text. Load-bearing, tested properties:
 * determinism (a fixed injected clock, no randomness), byte-stable report
 * products, strict Asia/Shanghai +08:00 timestamps (never a naive `Z`
 * label), path-safe identifiers, and a failure report even when a check
 * throws.
 *
 * This engine is generic on purpose: it imports no adapter and no episode
 * payload logic — only the shared format primitives (isShanghaiIso) and the
 * fixed +08 offset — so it stays in the core layer. The concrete T01
 * foundation checks live in scripts/episode-foundation-checks.ts. The two
 * run modes — fixtures (default) and replay (real history) — both have a
 * clear entry here, but replay is explicitly NOT implemented in T01: it
 * would read real transcripts, which this ticket forbids.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isShanghaiIso } from "../domain/episode.js";
import { SHANGHAI_OFFSET_MS } from "./time-labels.js";

/** Render an epoch-ms as a strict +08:00 ISO instant (never a `Z` label). */
export function toShanghaiIso(epochMs: number): string {
  const shifted = new Date(epochMs + SHANGHAI_OFFSET_MS).toISOString();
  return `${shifted.slice(0, 23)}+08:00`;
}

// Path-safe identifier: no separators, no "..", no control characters.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`${label} must be a non-empty short identifier`);
  }
  if (!SAFE_SEGMENT.test(value) || value === "." || value === ".." || value.includes("..")) {
    throw new Error(
      `${label} must not be "." / ".." or contain path separators, "..", or control characters: "${value}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Declarative fixture (synthetic input). Later tickets extend this with
// override sequences, AU-lexicon hits, typed fiction signals, default_realm
// config, and expected-assertion blocks; T01 uses only the message sequence.
// ---------------------------------------------------------------------------

export interface HarnessFixtureMessage {
  role: "user" | "assistant";
  /** Minutes after the fixture's fixed base instant. Deterministic; never a wall clock. */
  offsetMinutes: number;
  content: string;
  messageId: string;
  turnId?: string;
  proactive?: boolean;
}

export interface HarnessFixture {
  id: string;
  conversationId: string;
  /** Fixed base instant, a strict +08:00 ISO string. Every message time derives from this. */
  baseIso: string;
  messages: HarnessFixtureMessage[];
}

export interface ExpandedFixture {
  filePath: string;
  lineCount: number;
  messageIds: string[];
}

/**
 * Expand a fixture into a transcript JSONL matching the real on-disk event
 * shape (type/content/message_id/turn_id/proactive + timestamp), written
 * into `dir`. baseIso and every derived message timestamp are strict +08:00
 * (no naive `Z`). fixture id and conversation id are path-safe so the
 * derived filename cannot escape `dir`. Returns metadata only; never reads
 * or writes real transcripts.
 */
export function expandFixtureToJsonl(fixture: HarnessFixture, dir: string): ExpandedFixture {
  assertSafeSegment(fixture.id, "fixture.id");
  assertSafeSegment(fixture.conversationId, "fixture.conversationId");
  if (!isShanghaiIso(fixture.baseIso)) {
    throw new Error(
      `fixture ${fixture.id}: baseIso must be a +08:00 ISO instant (no Z / naive), got "${fixture.baseIso}"`,
    );
  }
  const baseMs = Date.parse(fixture.baseIso);
  mkdirSync(dir, { recursive: true });
  const stamp = fixture.baseIso.replace(/[:.+]/g, "-");
  const filePath = join(dir, `${stamp}-${fixture.conversationId}.jsonl`);
  const messageIds: string[] = [];
  const lines = fixture.messages.map((m) => {
    messageIds.push(m.messageId);
    // The on-disk transcript archive stores canonical UTC ISO `Z` (matching
    // JsonlTranscriptStore); ONLY the fixture DECLARATION time (baseIso) and
    // the report builtAt are +08:00. Same instant, different render (Errata 1).
    const timestamp = new Date(baseMs + m.offsetMinutes * 60_000).toISOString();
    const event: Record<string, unknown> = {
      timestamp,
      type: m.role === "user" ? "user_message_persisted" : "assistant_message_persisted",
      content: m.content,
      message_id: m.messageId,
      proactive: m.proactive === true,
    };
    if (m.turnId !== undefined) {
      event["turn_id"] = m.turnId;
    }
    return JSON.stringify(event);
  });
  writeFileSync(filePath, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
  return { filePath, lineCount: lines.length, messageIds };
}

// ---------------------------------------------------------------------------
// Check registry. A check receives its own isolated work directory and the
// injected build instant; it returns metadata-only assertions.
// ---------------------------------------------------------------------------

export interface HarnessAssertion {
  key: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface HarnessCheckResult {
  id: string;
  name: string;
  status: "PASS" | "FAIL";
  assertions: HarnessAssertion[];
}

export interface HarnessRunContext {
  /** Isolated work directory unique to this check; safe to write freely. */
  workDir: string;
  /** Injected build instant (strict +08:00 ISO); the only clock the harness sees. */
  builtAt: string;
}

export interface HarnessCheck {
  id: string;
  name: string;
  run: (ctx: HarnessRunContext) => Promise<HarnessCheckResult> | HarnessCheckResult;
}

/** Metadata equality assertion (string-compared; never carries message text). */
export function eq(key: string, expected: unknown, actual: unknown): HarnessAssertion {
  const e = String(expected);
  const a = String(actual);
  return { key, expected: e, actual: a, pass: e === a };
}

/** Boolean condition assertion. */
export function ok(key: string, condition: boolean): HarnessAssertion {
  return { key, expected: "true", actual: String(condition), pass: condition };
}

/** Fold a check's assertions into a result (PASS iff every assertion passes). */
export function resultFrom(id: string, name: string, assertions: HarnessAssertion[]): HarnessCheckResult {
  return { id, name, status: assertions.every((a) => a.pass) ? "PASS" : "FAIL", assertions };
}

export interface HarnessReport {
  mode: "fixtures";
  builtAt: string;
  total: number;
  passed: number;
  failed: number;
  checks: HarnessCheckResult[];
  /**
   * Honest scope ledger: capabilities NOT exercised in this run, so nothing
   * downstream can mistake T01's foundation checks for full acceptance. The
   * F-01..F-49 fixtures require Pass1/Pass2 and are not implemented here.
   */
  notInScope: string[];
}

export interface HarnessRunOptions {
  /** Parent isolated directory; each check gets its own subdirectory under it. */
  workDir: string;
  /** Injected build instant; must be a strict +08:00 ISO string. */
  builtAt: string;
  mode?: "fixtures" | "replay";
  notInScope?: string[];
}

/**
 * Run the registered checks in fixtures mode. Each check gets an isolated,
 * uniquely-named subdirectory so runs never collide and stay repeatable; a
 * check whose id is unsafe or duplicated is rejected before it can overwrite
 * or escape the work directory. A check that THROWS still yields a FAIL
 * result (never an unreported exception), so the report is always produced.
 * Replay mode is a declared entry point but throws in T01 — it would read
 * real transcripts, which this ticket forbids; a silent no-op would read as
 * "covered".
 */
export async function runHarness(
  checks: readonly HarnessCheck[],
  options: HarnessRunOptions,
): Promise<HarnessReport> {
  if (options.mode === "replay") {
    throw new Error(
      "replay mode (real-history full replay) is not implemented in L1-T01; " +
        "it requires Pass1/Pass2 and reads real transcripts, both out of scope",
    );
  }
  if (!isShanghaiIso(options.builtAt)) {
    throw new Error(`builtAt must be a +08:00 ISO instant (no Z / naive), got "${options.builtAt}"`);
  }
  const seen = new Set<string>();
  const results: HarnessCheckResult[] = [];
  for (const check of checks) {
    assertSafeSegment(check.id, "check.id");
    if (seen.has(check.id)) {
      throw new Error(`duplicate check id "${check.id}" — check ids must be unique`);
    }
    seen.add(check.id);
    const checkDir = join(options.workDir, check.id);
    mkdirSync(checkDir, { recursive: true });
    try {
      results.push(await check.run({ workDir: checkDir, builtAt: options.builtAt }));
    } catch (error) {
      // Record only a STABLE error CATEGORY (a sanitized Error.name) — never
      // the raw message, which in a future real replay could carry transcript
      // content. The category is the ONLY thing that reaches the report AND
      // stderr; the raw message goes NOWHERE by default (Errata 4 +
      // micro-erratum). Any future detailed debugging must be an explicit,
      // default-off entry forbidden in CI/Relay — not implemented here.
      const category =
        error instanceof Error && typeof error.name === "string"
          ? error.name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error"
          : "Error";
      console.error(`[episode-harness] check ${check.id} threw (${category})`);
      results.push({
        id: check.id,
        name: check.name,
        status: "FAIL",
        assertions: [{ key: "threw", expected: "no exception", actual: category, pass: false }],
      });
    }
  }
  const passed = results.filter((r) => r.status === "PASS").length;
  return {
    mode: "fixtures",
    builtAt: options.builtAt,
    total: results.length,
    passed,
    failed: results.length - passed,
    checks: results,
    notInScope: options.notInScope ?? [],
  };
}

// ---------------------------------------------------------------------------
// Report products — machine JSON + human Markdown. Both are byte-stable for
// a given report (fixed builtAt, path-free content) and carry no message
// text. Objects are built in fixed field order, so JSON.stringify is stable;
// Markdown cells are escaped so a `|` or newline can never break the table.
// ---------------------------------------------------------------------------

export function renderReportJson(report: HarnessReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/** Escape a value for a Markdown table cell (never breaks row/column structure). */
function mdCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function renderReportMarkdown(report: HarnessReport): string {
  const lines: string[] = [];
  lines.push("# L1 Episode Projection — Offline Harness Report (T01 foundation)");
  lines.push("");
  lines.push(`- mode: ${report.mode}`);
  lines.push(`- built_at: ${report.builtAt}`);
  lines.push(`- checks: ${report.passed}/${report.total} PASS (${report.failed} FAIL)`);
  lines.push("");
  lines.push("| check | name | status |");
  lines.push("| --- | --- | --- |");
  for (const c of report.checks) {
    lines.push(`| ${mdCell(c.id)} | ${mdCell(c.name)} | ${c.status} |`);
  }
  lines.push("");
  lines.push("## Assertions (metadata only)");
  for (const c of report.checks) {
    lines.push("");
    lines.push(`### ${mdCell(c.id)} — ${c.status}`);
    lines.push("| key | expected | actual | pass |");
    lines.push("| --- | --- | --- | --- |");
    for (const a of c.assertions) {
      lines.push(`| ${mdCell(a.key)} | ${mdCell(a.expected)} | ${mdCell(a.actual)} | ${a.pass ? "yes" : "NO"} |`);
    }
  }
  lines.push("");
  lines.push("## Not in T01 scope (not run, not PASS)");
  if (report.notInScope.length === 0) {
    lines.push("- (none listed)");
  } else {
    for (const item of report.notInScope) {
      lines.push(`- ${mdCell(item)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
