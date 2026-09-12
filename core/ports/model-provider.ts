/**
 * Provider-neutral model contract. Core depends only on this shape;
 * concrete providers (headless Claude CLI, fakes, future adapters) live
 * under adapters/ and are injected by the composition root.
 */
import type { AssistantThinking } from "../domain/types.js";

/**
 * Truthful report of explicit Anthropic prompt-cache control. Every
 * field must reflect what the adapter can actually send or observe on
 * its wire contract — never what the underlying vendor product might do
 * internally. A provider that cannot set request fields reports false
 * even if its backend caches prompts on its own.
 */
export interface PromptCacheCapability {
  /** True only when the adapter can emit cache_control breakpoints. */
  explicitPromptCaching: boolean;
  /** Controllable cache breakpoints per request (0 when unsupported). */
  maxCacheBreakpoints: number;
  /** True when 5-minute vs 1-hour cache TTL is selectable per request. */
  ttlControl: boolean;
  /** True when metadata.user_id sticky routing is controllable. */
  stickyUserId: boolean;
  /**
   * True when usage.cache_read_input_tokens and
   * usage.cache_creation_input_tokens are observable per call.
   */
  cacheUsageMetrics: boolean;
}

/** Honest default for adapters without any explicit cache control. */
export const NO_EXPLICIT_PROMPT_CACHE: PromptCacheCapability = {
  explicitPromptCaching: false,
  maxCacheBreakpoints: 0,
  ttlControl: false,
  stickyUserId: false,
  cacheUsageMetrics: false,
};

export interface ProviderCapabilities {
  /** True only when a verified non-interactive image mechanism exists. */
  imageInput: boolean;
  /**
   * Explicit prompt-cache control; absent means NO_EXPLICIT_PROMPT_CACHE.
   * A future direct Anthropic API adapter reporting true here is the
   * only condition under which callers may emit cache fields.
   */
  promptCache?: PromptCacheCapability;
  /**
   * True ONLY when the adapter has a native tool channel that really
   * retrieves live web content AND reports back what it retrieved.
   * Absent/false means the turn runs with no web access at all.
   *
   * A provider must NOT report true because its model can be prompted to
   * talk about searching, or because the vendor product searches in some
   * other mode. Native retrieval and imitation of retrieval are different
   * capabilities (ADR 0007). Reporting true without emitting
   * `webSearches` on the result is a contract violation: callers rely on
   * that record to know what left the machine.
   */
  webSearch?: boolean;
}

/**
 * One audit record per web tool call the provider actually performed.
 *
 * This is the ONLY evidence Delos has about what left the machine, so it
 * is deliberately minimal and content-free: the exact text that egressed
 * plus the source URLs that came back. Retrieved page/result BODIES are
 * never recorded here — keeping them out is what stops external content
 * from reaching durable local stores through the audit path.
 */
export interface WebSearchRecord {
  /** "search" = a query was issued; "fetch" = one URL was retrieved. */
  kind: "search" | "fetch";
  /** Exact text that left the machine: the query string, or the URL. */
  query: string;
  /** Source URLs the call returned; empty when it returned none. */
  sources: string[];
  /**
   * True when the call did not deliver content (tool error, or the tool
   * was denied). Callers must treat a failed record as "no retrieval
   * happened" and must never present its turn as a successful search.
   */
  failed: boolean;
}

export interface ImageInput {
  /** Local file path under the runtime data root; never a remote path. */
  localPath: string;
  mimeType?: string;
}

export type ModelTurnContextKind =
  | "trusted-time"
  | "memory"
  | "proactive"
  | "restoration"
  | "reliability"
  | "capability"
  | "current-situation"
  | "requested-history"
  | "proactive-echo";

export interface ModelTurnContextPart {
  kind: ModelTurnContextKind;
  text: string;
}

export interface ProviderRuntimeEvent {
  type: "provider_thread_changed";
  reason: "static_variant_changed";
  provider: string;
  previous_thread_id: string;
  new_thread_id: string;
  previous_static_variant_sha256: string;
  new_static_variant_sha256: string;
}

/** Fixed selection requested by a provider instance, when one exists. */
export interface ProviderSelection {
  model: string;
  reasoningEffort: string | null;
}

export interface ModelRequest {
  /** Stable Delos conversation identity for stateful providers. */
  conversationId: string;
  /** Stable Delos turn identity for idempotent provider turn markers. */
  turnId: string;
  /** Selected static authority prompt; providers must carry it as system instructions. */
  systemPrompt: string;
  /** Dynamic per-turn prompt content; providers must carry it as ordinary user input. */
  dynamicPrompt: string;
  /** Current user-authored text, absent for Companion-initiated proactive turns. */
  currentUserText?: string;
  /** Compact, non-history runtime context for stateful providers. */
  contextParts?: ModelTurnContextPart[];
  /**
   * Image content parts. Callers must only attach these when the
   * provider reports imageInput capability; providers without it
   * ignore the field rather than pretending to see images.
   */
  images?: ImageInput[];
  /**
   * Explicit model override for THIS request (Model Desk probes). Absent →
   * the provider applies its configured lease/default. Never derived from
   * generated text.
   */
  model?: string | null;
  /**
   * Per-turn permission for live web retrieval. Absent/false → the
   * provider must run with no web access, which is the default for every
   * ordinary turn. Providers without the `webSearch` capability ignore
   * this field rather than pretending to search.
   *
   * Permission is granted per turn, never per session: core decides on
   * each turn whether this turn may reach the network. Companion-initiated
   * (proactive) turns never set it, so an unattended episode can never
   * spend quota or egress on retrieval.
   */
  allowWebSearch?: boolean;
}

export type ModelErrorKind =
  | "spawn_failure"
  | "timeout"
  | "nonzero_exit"
  | "empty_output"
  | "malformed_output"
  | "cleanup_failure"
  | "cancelled"
  /**
   * The provider ran out of internal steps before producing an answer —
   * e.g. a web-retrieval turn that spent its whole step budget on tool
   * calls. Distinct from `nonzero_exit` because the turn was well-formed
   * and is safely retriable; callers may say so honestly instead of
   * reporting a generic provider failure.
   */
  | "step_budget_exhausted";

export type ModelResult =
  | {
      ok: true;
      text: string;
      /**
       * Independent reasoning captured alongside the answer, when the
       * provider exposes a real thinking channel (headless Claude reads
       * stream-json `thinking` blocks). Absent for text-only providers and
       * for turns where the model produced no reasoning. Never part of
       * `text`; display/audit-only.
       */
      thinking?: AssistantThinking;
      providerEvents?: ProviderRuntimeEvent[];
      /**
       * TRUSTED served-model identity from provider metadata (stream-json
       * system/init). null/absent = unknown. Generated prose is never a
       * source for this field.
       */
      servedModel?: string | null;
      /** Trusted provider-protocol reasoning effort for this served turn. */
      servedReasoningEffort?: string | null;
      /** Scope of the trusted provider receipt; never inferred from prose. */
      servedReceiptScope?: "turn" | "thread";
      /** Provider thread carrying a thread-scoped receipt, when applicable. */
      servedReceiptThreadId?: string;
      /** Local verification time for the trusted provider receipt. */
      servedReceiptVerifiedAt?: string;
      /** Explicit selection sent by this provider instance. */
      requestedModel?: string;
      requestedReasoningEffort?: string | null;
      /**
       * Web retrieval that ACTUALLY happened this turn, read from provider
       * tool metadata — never from generated prose, which can claim a
       * search that never ran. Absent/empty = nothing was retrieved.
       *
       * A provider that was granted `allowWebSearch` and performed
       * retrieval MUST populate this. Core persists it as the durable
       * record of what left the machine.
       */
      webSearches?: WebSearchRecord[];
    }
  | { ok: false; errorKind: ModelErrorKind; detail: string };

export interface ModelProvider {
  /** Short provider label for transcripts and status lines. */
  readonly name: string;
  /** Capability report; absent means text-only. */
  readonly capabilities?: ProviderCapabilities;
  /** Fixed requested selection, when the provider is pinned per instance. */
  readonly selection?: ProviderSelection;
  generate(request: ModelRequest): Promise<ModelResult>;
  close?(): Promise<void> | void;
}
