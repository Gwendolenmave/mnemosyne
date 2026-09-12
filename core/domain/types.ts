/**
 * Platform-neutral domain types for the Delos CLI MVP vertical slice.
 * Nothing in this file may reference a concrete provider, transport, or SDK.
 */

export interface PromptSection {
  /** Logical prompt name: identity | relationship | response-style | memory-policy. */
  name: string;
  /** Path relative to the repository root, e.g. "prompts/identity.md". */
  path: string;
  /** SHA-256 hex digest of the file content as loaded. */
  sha256: string;
  /** Verbatim file content. */
  content: string;
}

export interface PromptBundle {
  sections: PromptSection[];
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  text: string;
  /**
   * Stable Delos message id, when known. Optional for backward
   * compatibility: legacy call sites build {role, text} only. The
   * token-aware recent window renders it as structured provenance so the
   * model can distinguish and reference individual turns.
   */
  messageId?: string;
  /** ISO-8601 instant the message was persisted, when known. */
  atIso?: string;
  /**
   * True when this assistant message was Companion-initiated (a proactive
   * episode with no paired user message). Marks self-echo so the context
   * builder can isolate it from real dialogue (Proactive Echo Guard).
   * Absent/false for user messages and ordinary assistant replies.
   */
  proactive?: boolean;
}

/**
 * Provider-supplied reasoning, kept strictly separate from the final answer.
 * Only a provider that exposes a real, INDEPENDENT thinking channel populates
 * it — the headless Claude adapter reads Claude Code `stream-json` `thinking`
 * content blocks (verified 2026-07-13), which arrive as their own events,
 * distinct from the `text`/`result` answer. It is display- and audit-only: it
 * MUST never enter conversation history, long-term memory, summaries, or
 * embeddings, and it is never translated. A model that merely writes a
 * `<details>Thinking</details>` block inside its final text is NOT this — that
 * leaked container is stripped from the body by the reply sanitizer and is not
 * reasoning.
 */
export interface AssistantThinking {
  /** Origin tag. "reasoning" = a real, independent model thinking channel. */
  source: "reasoning";
  /** Thinking text in the model's own language; preserved verbatim. */
  text: string;
}

export interface TurnSuccess {
  ok: true;
  replyText: string;
  /** Independent reasoning for this turn, when the provider exposed one. */
  thinking?: AssistantThinking;
}

export interface TurnFailure {
  ok: false;
  /** Safe, user-facing description. Never raw stderr or a stack trace. */
  failure: string;
  /**
   * True when a proactive turn was invalidated because real user
   * activity arrived during generation: the generated text was discarded
   * before assistant persistence. Not a retriable model failure.
   */
  superseded?: true;
}

export type TurnOutcome = TurnSuccess | TurnFailure;
