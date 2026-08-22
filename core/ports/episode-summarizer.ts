/**
 * Provider-neutral Episode summarizer contract (§3.4, Portable Core). Core
 * depends only on this shape; the concrete ModelProvider adapter, the
 * explicit SUMMARY_MODEL configuration, and the served-model verification
 * live under adapters/ and are injected by the composition root (a later
 * ticket). This file — like the whole core layer — contains NO provider
 * name, CLI, or specific model id: `requestedModel` and `servedModel` are
 * opaque strings the pipeline carries through and compares.
 *
 * The call chain the pipeline will build on top of this port is fixed:
 *   EpisodeSummarizerPort → configured ModelProvider adapter
 *   → explicit SUMMARY_MODEL → served-model check (init metadata only)
 *   → NO fallback.
 * T01 provides the port and a deterministic stub; the real adapter and the
 * batch pipeline are not in scope.
 */

/** The three call kinds share one signature (§3.4); the pipeline builds the prompt. */
export type EpisodeSummaryRequestKind = "episode" | "chunk" | "assembly";

export interface EpisodeSummaryRequest {
  kind: EpisodeSummaryRequestKind;
  /** Fully-assembled prompt text for this call, built by the pipeline (not the port). */
  prompt: string;
  /**
   * The configured, to-be-verified SUMMARY_MODEL value — opaque to core.
   * The port passes it to the adapter; verification compares it against the
   * served-model init metadata (servedModelMatches below).
   */
  requestedModel: string;
}

/**
 * Vendor-neutral failure semantics. Core carries no subprocess assumption:
 * a future adapter maps its concrete failures (a CLI spawn error, a non-zero
 * exit code, an HTTP status, a broken socket) onto these neutral kinds —
 * `transport_failure` for "could not reach/launch the backend" and
 * `upstream_failure` for "the backend ran but failed". Specific spawn/exit
 * vocabulary must never enter the Portable Core.
 *
 * The kinds are declared as a const tuple so consumers get ONE runtime guard
 * derived from the same source as the type (G1A Erratum 4A) — TypeScript
 * unions are erased at runtime, and a contract-violating adapter must not be
 * able to smuggle arbitrary text through `errorKind`.
 */
export const EPISODE_SUMMARY_ERROR_KINDS = [
  "transport_failure",
  "upstream_failure",
  "timeout",
  "empty_output",
  "malformed_output",
  "cancelled",
] as const;

export type EpisodeSummaryErrorKind = (typeof EPISODE_SUMMARY_ERROR_KINDS)[number];

/** Runtime membership guard for the sealed error-kind set (same source as the type). */
export function isEpisodeSummaryErrorKind(v: unknown): v is EpisodeSummaryErrorKind {
  return typeof v === "string" && (EPISODE_SUMMARY_ERROR_KINDS as readonly string[]).includes(v);
}

export type EpisodeSummaryResult =
  | {
      ok: true;
      /** Raw model output text (unparsed JSON); the pipeline validates it. */
      rawJson: string;
      /**
       * TRUSTED served-model identity from the adapter's init metadata.
       * null/absent = unknown. Echoed prose and config self-report are never
       * a source for this field (§3.4).
       */
      servedModel: string | null;
    }
  | { ok: false; errorKind: EpisodeSummaryErrorKind; detail: string };

export interface EpisodeSummarizerPort {
  /** Short port label for reports and status lines. */
  readonly name: string;
  /**
   * One probe per batch: returns the served-model init metadata without
   * producing a summary. The pipeline verifies it against SUMMARY_MODEL
   * BEFORE any billed call; a mismatch pends the batch with zero real
   * calls (§3.4). null = the adapter could not report served identity.
   */
  probeServedModel(requestedModel: string): Promise<{ servedModel: string | null }>;
  /** Produce one summary call's raw output plus its served-model metadata. */
  summarize(request: EpisodeSummaryRequest): Promise<EpisodeSummaryResult>;
  close?(): Promise<void> | void;
}

/**
 * Served-model verification, pure (§3.4: "only trust init metadata, with no
 * fallback"). True only when the adapter reported a served identity that is
 * byte-equal to the configured, requested model. A null served identity
 * (unknown) never verifies. The lifecycle that reacts to a false verdict —
 * pend the batch with reason=model_unverified — is a later ticket.
 */
export function servedModelMatches(requestedModel: string, servedModel: string | null): boolean {
  return servedModel !== null && servedModel === requestedModel;
}
