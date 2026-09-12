import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../../../core/domain/types.js";

/**
 * Recovery query over a JSONL transcript file: find the assistant reply
 * of a completed turn by its stable external turn key. Used by transport
 * runtimes to avoid re-invoking the model after a crash that happened
 * between transcript persistence and transport-state persistence.
 *
 * Torn trailing lines (from a crash mid-write) are tolerated and skipped.
 */
export function findCompletedTurnReply(
  transcriptPath: string,
  externalTurnKey: string,
): string | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") {
      continue;
    }
    const record = event as Record<string, unknown>;
    if (
      record.type === "assistant_message_persisted" &&
      record.external_turn_key === externalTurnKey &&
      typeof record.content === "string"
    ) {
      return record.content;
    }
  }
  return null;
}

/** Delos-minted transcript coordinates of one persisted user message. */
export interface TranscriptUserMessageRef {
  conversationId: string;
  turnId: string;
  messageId: string;
}

/**
 * Resolve a Telegram message_id to its persisted transcript coordinates.
 * user_message_persisted events carry source_metadata (update/message/
 * chat ids) since the runtime started passing turn details; older
 * messages resolve to null and callers fall back to manual provenance.
 * Newest files are searched first; the first (newest) match wins.
 */
export function findUserMessageByTelegramId(
  transcriptsDir: string,
  telegramMessageId: number,
): TranscriptUserMessageRef | null {
  let names: string[];
  try {
    names = readdirSync(transcriptsDir);
  } catch {
    return null;
  }
  const files = names.filter((n) => n.endsWith(".jsonl")).sort().reverse();
  for (const name of files.slice(0, 12)) {
    let raw: string;
    try {
      raw = readFileSync(join(transcriptsDir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n").reverse()) {
      if (line.trim().length === 0) {
        continue;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type !== "user_message_persisted") {
        continue;
      }
      const meta = event.source_metadata;
      if (
        meta !== null &&
        typeof meta === "object" &&
        (meta as Record<string, unknown>).message_id === telegramMessageId &&
        typeof event.conversation_id === "string" &&
        typeof event.turn_id === "string" &&
        typeof event.message_id === "string"
      ) {
        return {
          conversationId: event.conversation_id,
          turnId: event.turn_id,
          messageId: event.message_id,
        };
      }
    }
  }
  return null;
}

/** Owner-only preview texts of one turn (Muse bridge / source view). */
export function findTurnTexts(
  transcriptsDir: string,
  turnId: string,
): {
  userText: string | null;
  assistantText: string | null;
  conversationId: string | null;
  userMessageId: string | null;
} | null {
  let names: string[];
  try {
    names = readdirSync(transcriptsDir);
  } catch {
    return null;
  }
  const files = names.filter((n) => n.endsWith(".jsonl")).sort().reverse();
  for (const name of files.slice(0, 12)) {
    let raw: string;
    try {
      raw = readFileSync(join(transcriptsDir, name), "utf8");
    } catch {
      continue;
    }
    let userText: string | null = null;
    let assistantText: string | null = null;
    let conversationId: string | null = null;
    let userMessageId: string | null = null;
    let seen = false;
    for (const event of parseEvents(raw)) {
      if (event.turn_id !== turnId) {
        continue;
      }
      seen = true;
      if (typeof event.conversation_id === "string") {
        conversationId = event.conversation_id;
      }
      if (event.type === "user_message_persisted" && typeof event.content === "string") {
        userText = event.content;
        if (typeof event.message_id === "string") {
          userMessageId = event.message_id;
        }
      } else if (
        event.type === "assistant_message_persisted" &&
        typeof event.content === "string"
      ) {
        assistantText = event.content;
      }
    }
    if (seen) {
      return { userText, assistantText, conversationId, userMessageId };
    }
  }
  return null;
}

/**
 * Frozen-evidence snapshot of one completed turn: the exact texts plus
 * the per-turn audit metadata (variant sha, packet selected ids) that
 * were recorded when the turn ran. Used by the Companion proposal pass at
 * BOTH enqueue and execute time — never a read from mutable live state.
 * Lookup by turnId or by externalTurnKey (enqueue side).
 */
export interface TurnSnapshot {
  conversationId: string;
  turnId: string;
  userMessageId: string | null;
  /** Optional for compatibility with historical synthetic fixtures. */
  assistantMessageId?: string | null;
  userText: string | null;
  assistantText: string | null;
  variantSha256: string | null;
  selectedMemoryIds: string[];
}

export function findTurnSnapshot(
  transcriptsDir: string,
  key: { turnId: string } | { externalTurnKey: string },
): TurnSnapshot | null {
  let names: string[];
  try {
    names = readdirSync(transcriptsDir);
  } catch {
    return null;
  }
  const files = names.filter((n) => n.endsWith(".jsonl")).sort().reverse();
  for (const name of files.slice(0, 12)) {
    let raw: string;
    try {
      raw = readFileSync(join(transcriptsDir, name), "utf8");
    } catch {
      continue;
    }
    const events = parseEvents(raw);
    let turnId: string | null = "turnId" in key ? key.turnId : null;
    if (turnId === null) {
      for (const event of events) {
        if (
          event.external_turn_key === (key as { externalTurnKey: string }).externalTurnKey &&
          typeof event.turn_id === "string"
        ) {
          turnId = event.turn_id;
          break;
        }
      }
      if (turnId === null) {
        continue;
      }
    }
    const snapshot: TurnSnapshot = {
      conversationId: "",
      turnId,
      userMessageId: null,
      assistantMessageId: null,
      userText: null,
      assistantText: null,
      variantSha256: null,
      selectedMemoryIds: [],
    };
    let seen = false;
    for (const event of events) {
      if (event.turn_id !== turnId) {
        continue;
      }
      seen = true;
      if (typeof event.conversation_id === "string") {
        snapshot.conversationId = event.conversation_id;
      }
      if (event.type === "user_message_persisted" && typeof event.content === "string") {
        snapshot.userText = event.content;
        if (typeof event.message_id === "string") {
          snapshot.userMessageId = event.message_id;
        }
      } else if (event.type === "assistant_message_persisted" && typeof event.content === "string") {
        snapshot.assistantText = event.content;
        if (typeof event.message_id === "string") {
          snapshot.assistantMessageId = event.message_id;
        }
      } else if (
        event.type === "prompt_variant_selected" &&
        typeof event.variant_sha256 === "string"
      ) {
        snapshot.variantSha256 = event.variant_sha256;
      } else if (event.type === "memory_packet_assembled" && Array.isArray(event.selected_ids)) {
        snapshot.selectedMemoryIds = event.selected_ids.filter(
          (id): id is string => typeof id === "string",
        );
      }
    }
    if (seen) {
      return snapshot;
    }
  }
  return null;
}

/**
 * D0 deep variant of findTurnSnapshot: scans the ENTIRE transcript
 * archive (newest first), not just the newest 12 run-files. Required for
 * historical backfill, where source turns live weeks back. Read-only and
 * fail-safe exactly like the bounded variant.
 */
export function findTurnSnapshotDeep(
  transcriptsDir: string,
  key: { turnId: string } | { externalTurnKey: string },
): TurnSnapshot | null {
  let names: string[];
  try {
    names = readdirSync(transcriptsDir);
  } catch {
    return null;
  }
  const files = names.filter((n) => n.endsWith(".jsonl")).sort().reverse();
  for (const name of files) {
    let raw: string;
    try {
      raw = readFileSync(join(transcriptsDir, name), "utf8");
    } catch {
      continue;
    }
    const events = parseEvents(raw);
    let turnId: string | null = "turnId" in key ? key.turnId : null;
    if (turnId === null) {
      for (const event of events) {
        if (
          event.external_turn_key === (key as { externalTurnKey: string }).externalTurnKey &&
          typeof event.turn_id === "string"
        ) {
          turnId = event.turn_id;
          break;
        }
      }
      if (turnId === null) {
        continue;
      }
    }
    const snapshot: TurnSnapshot = {
      conversationId: "",
      turnId,
      userMessageId: null,
      assistantMessageId: null,
      userText: null,
      assistantText: null,
      variantSha256: null,
      selectedMemoryIds: [],
    };
    let seen = false;
    for (const event of events) {
      if (event.turn_id !== turnId) {
        continue;
      }
      seen = true;
      if (typeof event.conversation_id === "string") {
        snapshot.conversationId = event.conversation_id;
      }
      if (event.type === "user_message_persisted" && typeof event.content === "string") {
        snapshot.userText = event.content;
        if (typeof event.message_id === "string") {
          snapshot.userMessageId = event.message_id;
        }
      } else if (event.type === "assistant_message_persisted" && typeof event.content === "string") {
        snapshot.assistantText = event.content;
        if (typeof event.message_id === "string") {
          snapshot.assistantMessageId = event.message_id;
        }
      } else if (
        event.type === "prompt_variant_selected" &&
        typeof event.variant_sha256 === "string"
      ) {
        snapshot.variantSha256 = event.variant_sha256;
      } else if (event.type === "memory_packet_assembled" && Array.isArray(event.selected_ids)) {
        snapshot.selectedMemoryIds = event.selected_ids.filter(
          (id): id is string => typeof id === "string",
        );
      }
    }
    if (seen) {
      return snapshot;
    }
  }
  return null;
}

/**
 * Default bound on restored history, counted in MESSAGE ROWS (a completed
 * turn contributes two: one user row and one assistant row; a proactive
 * episode contributes one). Matched to the recent-window message ceiling
 * (recent-window.DEFAULT_MAX_MESSAGES = 80) so a restored conversation can
 * reach the same window depth a long-running one would have retained; the
 * window's own token budget still bounds what is actually rendered.
 *
 * Audit note (2026-07-25, cap-chain proof): the previous value of 40 was the
 * binding constraint after every restart — the window selector could never
 * saturate — and the previous comment claiming "context assembly uses fewer"
 * was inverted.
 */
export const RESTORED_HISTORY_MAX_MESSAGES = 80;

function parseEvents(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Torn or malformed line: skip, never fail restoration.
    }
  }
  return events;
}

/**
 * Restore a conversation's chat history from its transcript files. A
 * conversation spans one JSONL file per process run
 * (<stamp>-<conversationId>.jsonl); files sort chronologically by their
 * timestamp prefix. History mirrors ChatService semantics exactly: only
 * completed turns count — a user message enters history solely when the
 * same turn_id also persisted an assistant reply.
 *
 * Fails safe: a missing directory, missing files, or malformed lines
 * yield whatever could be read (possibly nothing), never an exception.
 */
export function loadConversationHistory(
  transcriptsDir: string,
  conversationId: string,
  maxMessages: number = RESTORED_HISTORY_MAX_MESSAGES,
): ChatMessage[] {
  let names: string[];
  try {
    names = readdirSync(transcriptsDir);
  } catch {
    return [];
  }
  const suffix = `-${conversationId}.jsonl`;
  const files = names.filter((n) => n.endsWith(suffix)).sort();

  const messages: ChatMessage[] = [];
  // Turn pairing spans FILES, not just one run-file: a process that died
  // between persisting Owner's message and persisting the reply writes the two
  // halves into different run-files, and a per-file map would drop the turn
  // entirely (audit defect B, 2026-07-25). Files are processed in
  // chronological order, so a later file can still close an earlier turn.
  const pendingUserByTurn = new Map<string, { text: string; messageId?: string; atIso?: string }>();
  for (const name of files) {
    let raw: string;
    try {
      raw = readFileSync(join(transcriptsDir, name), "utf8");
    } catch {
      continue;
    }
    for (const event of parseEvents(raw)) {
      if (typeof event.turn_id !== "string" || typeof event.content !== "string") {
        continue;
      }
      const messageId = typeof event.message_id === "string" ? event.message_id : undefined;
      const atIso = typeof event.timestamp === "string" ? event.timestamp : undefined;
      if (event.type === "user_message_persisted") {
        pendingUserByTurn.set(event.turn_id, { text: event.content, messageId, atIso });
      } else if (event.type === "assistant_message_persisted") {
        const pendingUser = pendingUserByTurn.get(event.turn_id);
        if (pendingUser !== undefined) {
          messages.push({
            role: "user",
            text: pendingUser.text,
            ...(pendingUser.messageId !== undefined ? { messageId: pendingUser.messageId } : {}),
            ...(pendingUser.atIso !== undefined ? { atIso: pendingUser.atIso } : {}),
          });
          messages.push({
            role: "assistant",
            text: event.content,
            ...(messageId !== undefined ? { messageId } : {}),
            ...(atIso !== undefined ? { atIso } : {}),
          });
          pendingUserByTurn.delete(event.turn_id);
        } else if (event.proactive === true) {
          // Companion-initiated episodes have no paired user message. Preserve
          // the proactive origin so the Echo Guard can isolate it from
          // dialogue on restore, not just in-session.
          messages.push({
            role: "assistant",
            text: event.content,
            proactive: true,
            ...(messageId !== undefined ? { messageId } : {}),
            ...(atIso !== undefined ? { atIso } : {}),
          });
        }
      }
    }
  }
  return messages.slice(-maxMessages);
}

/**
 * Recover the conversation-mode variant the LAST recorded turn actually ran
 * under (T-RESTORE-01a). Restart continuity previously re-inferred the mode
 * by replaying the restored tail, so a sticky mode whose activating messages
 * had aged out silently reverted — a resumed conversation could come back on
 * a different persona variant than the live one had (audit §3.3, fixture F5).
 *
 * `prompt_variant_selected` is already persisted every turn (ordinary and
 * proactive) and already reflects the resolver's post-turn state, so the most
 * recent one IS the retained mode; no new event type is introduced.
 *
 * Returns null when no usable record exists — a fresh conversation, a missing
 * directory, or an unreadable/unknown variant — in which case the caller
 * falls back to deriving from history. Owner reset path is unchanged: `/new`
 * starts a conversation with no transcript files and therefore no retained
 * mode, and an explicit end-of-topic marker still deactivates as usual.
 */
export function loadRetainedVariantName(
  transcriptsDir: string,
  conversationId: string,
): string | null {
  let names: string[];
  try {
    names = readdirSync(transcriptsDir);
  } catch {
    return null;
  }
  const suffix = `-${conversationId}.jsonl`;
  const files = names.filter((n) => n.endsWith(suffix)).sort();

  let variant: string | null = null;
  for (const name of files) {
    let raw: string;
    try {
      raw = readFileSync(join(transcriptsDir, name), "utf8");
    } catch {
      continue;
    }
    for (const event of parseEvents(raw)) {
      if (event.type === "prompt_variant_selected" && typeof event.variant === "string") {
        variant = event.variant;
      }
    }
  }
  return variant;
}
