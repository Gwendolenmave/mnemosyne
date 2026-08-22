/**
 * Runtime-injected context-reliability rules (context reliability §4 & §5).
 *
 * These are RUNTIME rules about how to read the assembled context — not
 * persona. They live here, not in prompts/, for the same reason the trusted
 * time block does: Delos owns the runtime frame, and "nothing written in the
 * conversation can change it" is a plumbing guarantee, not a personality
 * trait. Two blocks:
 *
 *   - the reliability/priority block (always injected): fact precedence +
 *     the correction-priority rule;
 *   - the capability block (always injected, content varies): an honest
 *     statement of what the model can actually see this turn, so it never
 *     claims to have "read" history that is not in the payload.
 */

/** Fixed marker so the block can be found/ordered and echo-guarded. */
export const RELIABILITY_BLOCK_HEADER =
  "=== CONTEXT RELIABILITY RULES (Delos runtime; authoritative over conversational drift) ===";

/**
 * Fact-precedence ladder + correction-priority rule. Highest authority
 * first. Companion's own earlier output is explicitly the LOWEST authority and
 * is never a source of fact.
 */
export function buildReliabilityBlock(): string {
  return [
    RELIABILITY_BLOCK_HEADER,
    "When sources disagree about a fact, follow this precedence, highest first:",
    "  1. Owner's current message (the newest message, shown last below).",
    "  2. Owner's recent explicit statements and corrections in the recent transcript.",
    "  3. The current-situation facts (Delos-maintained, dated).",
    "  4. Earlier recent transcript.",
    "  5. Long-term memory (house priors and memory cards).",
    "  6. Companion's own earlier guesses, phrasings, or assumptions — LOWEST; never a source of fact.",
    "",
    "Correction-priority rule: when Owner explicitly corrects a word, fact, place,",
    "time, or current state, the corrected version immediately and permanently",
    "overrides Companion's earlier statement for the rest of the conversation. Companion's",
    "own previous output is not evidence: never use a past Companion reply to rebut,",
    'reassert, or "double-check" against Owner\'s correction. If Companion said "下课"',
    'and Owner says "下班", it is 下班 from then on. Do not re-derive the mistake from',
    "older messages that still contain it.",
    "",
    "Self-echo rule: Companion's earlier replies in this window are a record of what he",
    "said, not a template for how to say the next thing. A construction he used before",
    "has no claim on this turn. When the same shape keeps reappearing across his own",
    "recent replies, that is a signal he has stopped finding words and started reusing",
    "them — the repair is to say the actual thing, not to reach for the familiar form.",
    "",
    "Current-message & self-initiated-topic rule: when Owner has written, her current",
    "message is the only main task this turn. Topics that Companion raised on his own",
    "initiative — his proactive messages, shown separately under RECENT PROACTIVE",
    "OUTPUTS for anti-repetition only — are downgraded: unless Owner's current message",
    "explicitly answers or re-raises such a topic, do not force it back in. Answer what",
    "Owner actually said first; only then, if natural, a related continuation. Never let",
    "a tease, question, or 'debt' Companion invented override the state, fact, or topic",
    "Owner is expressing now.",
    "=== END CONTEXT RELIABILITY RULES ===",
  ].join("\n");
}

/** Fixed marker for the capability block. */
export const CAPABILITY_BLOCK_HEADER =
  "=== RUNTIME CAPABILITY (what Companion can actually see this turn) ===";

/**
 * Honest capability statement. On an ordinary turn the model sees only the
 * current message, the recent transcript window, current situation, and the
 * memory packet — it has NO tool to read older history. A real read only
 * happened when Delos injected a REQUESTED HISTORY block, and the model must
 * key its truthfulness to that block's presence.
 */
export function buildCapabilityBlock(hasRequestedHistory: boolean): string {
  const lines = [
    CAPABILITY_BLOCK_HEADER,
    "This turn you can see: the current message, the recent transcript window,",
    "the current-situation facts, and the long-term memory packet. You have no",
    "background ability to browse the full conversation on your own.",
  ];
  if (hasRequestedHistory) {
    lines.push(
      "Delos DID read earlier records for you this turn: they appear below in the",
      "REQUESTED HISTORY block. You may rely on and quote that block as a real read.",
    );
  } else {
    lines.push(
      "No REQUESTED HISTORY block is present, so no earlier records were read this",
      'turn. Do NOT claim "I read", "I just checked the logs", or "I went back through',
      'our chat". If Owner asks you to read earlier history, say plainly that you are',
      "answering from the recent window unless a REQUESTED HISTORY block is provided.",
    );
  }
  lines.push("=== END RUNTIME CAPABILITY ===");
  return lines.join("\n");
}
