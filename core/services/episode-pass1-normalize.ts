/**
 * L1-T02 Pass1 normalization (§2.1 / §5.2): partition messages by
 * conversation, stably sort each partition by (epochMs, messageId), detect
 * duplicate (conversation_id, message_id), and assemble atomic turns.
 *
 * Pure and deterministic — no I/O, no clock, no locale. Turn rules (§5.2):
 * one atomic turn per non-proactive turn_id (user + its reply); each
 * proactive message its own turn (P-1 blocking happens later in boundaries);
 * a message with no turn_id is never guessed into a group; an assistant turn
 * with no user message is an orphan (counted); boundaries never fall inside
 * a turn.
 */

import type { Pass1Message, Pass1Turn } from "../domain/episode-pass1.js";

export interface Pass1DuplicateKey {
  conversationId: string;
  messageId: string;
}

export interface Pass1Partition {
  conversationId: string;
  turns: readonly Pass1Turn[];
}

export interface Pass1PartitionResult {
  partitions: readonly Pass1Partition[];
  /** Duplicate (conversation_id, message_id) keys — a hard self-validation failure (§10). */
  duplicates: readonly Pass1DuplicateKey[];
}

/** Stable order for messages within a partition/turn: (epochMs, messageId). */
function byEpochThenId(a: Pass1Message, b: Pass1Message): number {
  if (a.epochMs !== b.epochMs) return a.epochMs - b.epochMs;
  return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}

function assembleTurns(conversationId: string, sorted: readonly Pass1Message[]): Pass1Turn[] {
  // Group into turn buckets by a deterministic key.
  const buckets = new Map<string, Pass1Message[]>();
  const order: string[] = [];
  const push = (key: string, msg: Pass1Message): void => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(msg);
  };
  for (const msg of sorted) {
    if (msg.proactive) {
      push(`p:${msg.messageId}`, msg); // each proactive message is its own turn
    } else if (msg.turnId !== null) {
      push(`t:${msg.turnId}`, msg); // one atomic turn per non-proactive turn_id
    } else {
      push(`s:${msg.messageId}`, msg); // no turn_id → its own turn, never guessed into a group
    }
  }

  const turns: Pass1Turn[] = order.map((key) => {
    const bucket = buckets.get(key)!.slice().sort(byEpochThenId);
    const epochs = bucket.map((m) => m.epochMs);
    const proactive = bucket.every((m) => m.proactive);
    const hasOwner = bucket.some((m) => m.role === "owner");
    const hasCompanion = bucket.some((m) => m.role === "companion");
    return {
      turnKey: key,
      conversationId,
      messages: bucket,
      startedAtEpochMs: Math.min(...epochs),
      endedAtEpochMs: Math.max(...epochs),
      proactive,
      orphanAssistant: !proactive && hasCompanion && !hasOwner,
    };
  });

  // Deterministic turn order: (startedAtEpochMs, earliest messageId in turn).
  turns.sort((a, b) => {
    if (a.startedAtEpochMs !== b.startedAtEpochMs) return a.startedAtEpochMs - b.startedAtEpochMs;
    const ai = a.messages[0]!.messageId;
    const bi = b.messages[0]!.messageId;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  return turns;
}

export function partitionAndAssemble(messages: readonly Pass1Message[]): Pass1PartitionResult {
  const byConversation = new Map<string, Pass1Message[]>();
  for (const msg of messages) {
    let list = byConversation.get(msg.conversationId);
    if (list === undefined) {
      list = [];
      byConversation.set(msg.conversationId, list);
    }
    list.push(msg);
  }

  const duplicates: Pass1DuplicateKey[] = [];
  const partitions: Pass1Partition[] = [];
  for (const conversationId of [...byConversation.keys()].sort()) {
    const sorted = byConversation.get(conversationId)!.slice().sort(byEpochThenId);
    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const msg of sorted) {
      if (seen.has(msg.messageId) && !reported.has(msg.messageId)) {
        duplicates.push({ conversationId, messageId: msg.messageId });
        reported.add(msg.messageId);
      }
      seen.add(msg.messageId);
    }
    partitions.push({ conversationId, turns: assembleTurns(conversationId, sorted) });
  }

  return { partitions, duplicates };
}
