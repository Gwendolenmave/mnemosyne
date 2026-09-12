/**
 * L1-T02 offline Pass1 transcript loader (adapter). Reads every `*.jsonl`
 * under an injected directory, parses the SAME on-disk event shape the
 * production JsonlTranscriptStore / transcript-reader use (no new format),
 * and produces normalized Pass1Messages plus line-level diagnostics.
 *
 * Unlike the tolerant runtime reader, Pass1 needs per-line accountability
 * (§5.1): a message line that is malformed JSON, is missing
 * message_id/timestamp/content, has an illegal timestamp, or comes from a
 * file whose name yields no conversation id is recorded as `malformed`
 * (fileId + line + stable category only — NEVER the raw line or content).
 * Unknown non-message event types are counted as skipped. This adapter is
 * read-only, touches only the injected directory, and calls no model.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pass1Message } from "../../../core/domain/episode-pass1.js";

/** `<stamp>-<conversationId>.jsonl`; stamp is the production UTC-Z form (also tolerate a ±HH-MM offset stamp). */
const FILENAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(?:Z|[+-]\d{2}-\d{2})-(.+)\.jsonl$/;

/** Archive canonical UTC ISO `Z` with millisecond precision (matches Date.toISOString()). */
const ARCHIVE_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface Pass1MalformedLine {
  sourceFileId: string;
  sourceLine: number;
  /** Stable category — never raw content or exception text. */
  category:
    | "bad_json"
    | "unknown_conversation"
    | "missing_message_id"
    | "missing_content"
    | "missing_timestamp"
    | "bad_timestamp";
}

export interface Pass1LoadResult {
  messages: Pass1Message[];
  skippedNonMessage: number;
  malformed: Pass1MalformedLine[];
}

function isArchiveUtc(value: unknown): value is string {
  if (typeof value !== "string" || !ARCHIVE_UTC.test(value)) return false;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) && d.toISOString() === value;
}

/**
 * Load and normalize every transcript file under `dir`. Deterministic:
 * files are processed in sorted order, and every message carries a stable
 * sourceFileId (the file's basename) + 1-based line number.
 */
export function loadPass1Transcripts(dir: string): Pass1LoadResult {
  const messages: Pass1Message[] = [];
  const malformed: Pass1MalformedLine[] = [];
  let skippedNonMessage = 0;

  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .sort();

  for (const name of names) {
    const match = FILENAME.exec(name);
    const conversationId = match ? (match[1] as string) : null;
    const raw = readFileSync(join(dir, name), "utf8");
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.trim().length === 0) continue;
      const sourceLine = i + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed.push({ sourceFileId: name, sourceLine, category: "bad_json" });
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        malformed.push({ sourceFileId: name, sourceLine, category: "bad_json" });
        continue;
      }
      const ev = parsed as Record<string, unknown>;
      const type = ev["type"];
      if (type !== "user_message_persisted" && type !== "assistant_message_persisted") {
        skippedNonMessage += 1;
        continue;
      }
      // A message line whose file yields no conversation id is malformed.
      if (conversationId === null) {
        malformed.push({ sourceFileId: name, sourceLine, category: "unknown_conversation" });
        continue;
      }
      if (typeof ev["message_id"] !== "string" || ev["message_id"].trim().length === 0) {
        malformed.push({ sourceFileId: name, sourceLine, category: "missing_message_id" });
        continue;
      }
      if (typeof ev["content"] !== "string") {
        malformed.push({ sourceFileId: name, sourceLine, category: "missing_content" });
        continue;
      }
      if (!("timestamp" in ev) || typeof ev["timestamp"] !== "string") {
        malformed.push({ sourceFileId: name, sourceLine, category: "missing_timestamp" });
        continue;
      }
      if (!isArchiveUtc(ev["timestamp"])) {
        malformed.push({ sourceFileId: name, sourceLine, category: "bad_timestamp" });
        continue;
      }
      const timestampUtc = ev["timestamp"];
      messages.push({
        sourceFileId: name,
        sourceLine,
        conversationId,
        eventType: type,
        role: type === "user_message_persisted" ? "owner" : "companion",
        messageId: ev["message_id"],
        turnId: typeof ev["turn_id"] === "string" ? ev["turn_id"] : null,
        timestampUtc,
        epochMs: Date.parse(timestampUtc),
        contentNfc: ev["content"].normalize("NFC"),
        proactive: ev["proactive"] === true,
      });
    }
  }

  return { messages, skippedNonMessage, malformed };
}
