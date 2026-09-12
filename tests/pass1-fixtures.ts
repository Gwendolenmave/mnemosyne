/**
 * Shared L1-T02 Pass1 test fixtures (NOT a test file). Synthetic-only:
 * placeholder terms, 2099-01-0x dates, no real content. Provides the
 * synthetic config/lexicon builders and a transcript/override JSONL writer
 * that uses the production on-disk conventions (UTC-Z filename stamp + event
 * shape) so the offline loader parses exactly what production would emit.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computePass1ConfigHash,
  type FictionLexicon,
  type Pass1Config,
  type VersionedPass1LexiconBundle,
} from "../core/domain/episode-pass1.js";
import { loadPass1Transcripts } from "../adapters/transcripts/local/pass1-transcript-loader.js";
import type { Pass1OverrideEvent } from "../core/services/episode-pass1-boundaries.js";
import type { Pass1EngineInput } from "../core/services/episode-pass1.js";

// --- config / lexicon builders ---------------------------------------------

// Entries are ascending-sorted by term (config governance, Erratum 1):
// EXIT-STRONG < META-WEAK < PLAY-STRONG < PLAY-WEAK. Matching is order-independent.
export function syntheticFiction(): FictionLexicon {
  return {
    version: "synthetic-test-v0",
    entries: [
      { term: "EXIT-STRONG", mode: "exit", strength: "strong", cooccur: null, negctx: null },
      {
        term: "META-WEAK",
        mode: "meta",
        strength: "weak",
        cooccur: { requires: "au_term", window: "same_message" },
        negctx: null,
      },
      { term: "PLAY-STRONG", mode: "enactment", strength: "strong", cooccur: null, negctx: null },
      {
        term: "PLAY-WEAK",
        mode: "enactment",
        strength: "weak",
        cooccur: { requires: "fiction_signal", window: { adjacentTurns: 2 } },
        negctx: { terms: ["NOT"], charWindow: 4 },
      },
    ],
  };
}

export function syntheticLexicons(fiction: FictionLexicon = syntheticFiction()): VersionedPass1LexiconBundle {
  return {
    // All term lists NFC-normalized, deduped, ascending-sorted (governance, Erratum 1).
    continuation: { version: "synthetic-test-v0", terms: ["CONT-BACK", "CONT-SCENE"] },
    stopwords: { version: "synthetic-test-v0", words: ["了", "的"] },
    au: {
      version: "synthetic-test-v0",
      entries: [
        { au_id: "au-alpha", unique_terms: ["ALPHA-CITY", "ALPHA-KEEP"], shared_terms: ["SHARED-NAME"], default_sensitivity: "normal" },
        { au_id: "au-beta", unique_terms: ["BETA-KEEP", "BETA-TOWER"], shared_terms: ["SHARED-NAME"], default_sensitivity: "sensitive" },
      ],
    },
    fiction,
    project: { version: "synthetic-test-v0", terms: [{ term: "PROJ-BUILD", weight: 2 }, { term: "PROJ-SPEC", weight: 2 }] },
    relationship: { version: "synthetic-test-v0", terms: [{ term: "REL-US", weight: 2 }] },
    schedule: { version: "synthetic-test-v0", terms: [{ term: "PLAN-DATE", weight: 2 }, { term: "PLAN-SET", weight: 2 }] },
    sensitivity: { version: "synthetic-test-v0", entries: [{ term: "SENS-WORD", level: "intimate" }] },
  };
}

export function makeConfig(overrides: Partial<Pass1Config> = {}): Pass1Config {
  return {
    indexVersion: "p1-v1",
    expectedConfigHash: `sha256:${"0".repeat(64)}`,
    summaryVersion: "sum-synthetic-v0",
    thresholds: {
      gapHardMinutes: 90,
      gapSoftMinutes: 30,
      windowTurns: 5,
      topicJaccardMin: 0.08,
      auAssignMin: 3,
      auLeadMin: 2,
      continuationLeadMin: null,
    },
    lexicons: syntheticLexicons(),
    defaultRealms: {
      version: "synthetic-test-v0",
      entries: [
        { conversation_id: "c-20990101-0001", default_realm: "reality", au_id: null },
        { conversation_id: "c-20990101-0002", default_realm: "au", au_id: "au-alpha" },
      ],
    },
    ...overrides,
  };
}

/** A config whose expectedConfigHash matches its content (no drift). */
export function validConfig(overrides: Partial<Pass1Config> = {}): Pass1Config {
  const cfg = makeConfig(overrides);
  return { ...cfg, expectedConfigHash: computePass1ConfigHash(cfg) };
}

// --- transcript / override JSONL writers -----------------------------------

export interface FixtureMessage {
  role: "owner" | "companion";
  /** Seconds after the conversation's base instant. */
  offsetSec: number;
  /** Extra milliseconds on top of offsetSec (exact-boundary fixtures, §11). */
  offsetMs?: number;
  content: string;
  messageId: string;
  turnId?: string | null;
  proactive?: boolean;
}

export interface FixtureConversation {
  conversationId: string;
  /** Base instant, canonical UTC ISO Z. */
  baseUtc: string;
  messages: readonly FixtureMessage[];
}

/** Production UTC-Z filename stamp (matches JsonlTranscriptStore). */
function stampOf(baseUtc: string): string {
  return new Date(baseUtc).toISOString().replace(/[:.]/g, "-");
}

/** Write one `*.jsonl` per conversation (production filename + event shape). Returns file paths. */
export function writePass1Transcripts(dir: string, conversations: readonly FixtureConversation[]): string[] {
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const conv of conversations) {
    const baseMs = Date.parse(conv.baseUtc);
    const filePath = join(dir, `${stampOf(conv.baseUtc)}-${conv.conversationId}.jsonl`);
    const lines = conv.messages.map((m) => {
      const event: Record<string, unknown> = {
        timestamp: new Date(baseMs + m.offsetSec * 1000 + (m.offsetMs ?? 0)).toISOString(),
        type: m.role === "owner" ? "user_message_persisted" : "assistant_message_persisted",
        content: m.content,
        message_id: m.messageId,
        proactive: m.proactive === true,
      };
      if (m.turnId !== undefined && m.turnId !== null) event["turn_id"] = m.turnId;
      return JSON.stringify(event);
    });
    writeFileSync(filePath, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
    paths.push(filePath);
  }
  return paths;
}

/** Write raw lines (may include deliberately malformed lines) to a transcript file verbatim. */
export function writeRawTranscript(dir: string, fileName: string, lines: readonly string[]): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

/** Write an append-only override JSONL (boundary/field events). */
export function writePass1Overrides(dir: string, fileName: string, events: readonly Record<string, unknown>[]): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);
  writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : ""), "utf8");
  return filePath;
}

/** Read an override JSONL into engine events (append order = file order + line). */
export function loadOverrideEvents(dir: string, fileName: string): Pass1OverrideEvent[] {
  const raw = readFileSync(join(dir, fileName), "utf8");
  const out: Pass1OverrideEvent[] = [];
  let order = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    out.push({ raw: JSON.parse(line) as Record<string, unknown>, order });
    order += 1;
  }
  return out;
}

/** Load transcripts (+ optional overrides) from a dir into a Pass1 engine input. */
export function buildEngineInput(dir: string, config: Pass1Config, overridesFileName?: string): Pass1EngineInput {
  const loaded = loadPass1Transcripts(dir);
  return {
    messages: loaded.messages,
    skippedNonMessage: loaded.skippedNonMessage,
    malformed: loaded.malformed,
    overrideEvents: overridesFileName === undefined ? [] : loadOverrideEvents(dir, overridesFileName),
    config,
  };
}
