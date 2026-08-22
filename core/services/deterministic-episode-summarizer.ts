/**
 * Deterministic EpisodeSummarizerPort stub (§4.7 model path). It fabricates
 * output from its input with no network, no process spawn, no filesystem,
 * and no clock/randomness — so `realModelCalls` is 0 by construction. It
 * lives in core/services alongside in-memory-memory-event-log.ts, the
 * established home for deterministic in-core test doubles.
 *
 * The stub speaks the SAME port interface a real adapter will, and carries
 * no provider name, CLI, or model id: `servedModel` is injected so tests
 * can exercise served-model verification (F-32), and every call is captured
 * so future assembly/evidence tests (F-28) can inspect prompt inputs. The
 * real ModelProvider adapter is a later ticket.
 */

import { createHash } from "node:crypto";
import type {
  EpisodeSummarizerPort,
  EpisodeSummaryRequest,
  EpisodeSummaryResult,
} from "../ports/episode-summarizer.js";

export interface DeterministicEpisodeSummarizerOptions {
  /** Served-model init metadata the stub reports (default null = unknown). */
  servedModel?: string | null;
  /**
   * Optional deterministic responder to shape a specific result (e.g. a
   * validation-failing body or a hand-built payload). Must itself be pure.
   */
  respond?: (request: EpisodeSummaryRequest) => EpisodeSummaryResult;
}

/** Stable synthetic output — same request always yields the same bytes. */
function deterministicRawJson(request: EpisodeSummaryRequest): string {
  const promptFingerprint = createHash("sha256").update(request.prompt, "utf8").digest("hex").slice(0, 12);
  return JSON.stringify({
    stub: true,
    kind: request.kind,
    prompt_sha12: promptFingerprint,
  });
}

export class DeterministicEpisodeSummarizer implements EpisodeSummarizerPort {
  readonly name = "deterministic-episode-summarizer(stub)";
  /** True model invocations this stub performs: none, ever, by construction. */
  readonly realModelCalls = 0 as const;
  /** Captured summarize inputs, for future assembly/evidence assertions (F-28). */
  readonly calls: EpisodeSummaryRequest[] = [];
  /** Captured probe inputs, for served-model verification assertions (F-32). */
  readonly probes: string[] = [];

  private readonly served: string | null;
  private readonly respond?: (request: EpisodeSummaryRequest) => EpisodeSummaryResult;

  constructor(options: DeterministicEpisodeSummarizerOptions = {}) {
    this.served = options.servedModel ?? null;
    this.respond = options.respond;
  }

  async probeServedModel(requestedModel: string): Promise<{ servedModel: string | null }> {
    this.probes.push(requestedModel);
    return { servedModel: this.served };
  }

  async summarize(request: EpisodeSummaryRequest): Promise<EpisodeSummaryResult> {
    this.calls.push(request);
    if (this.respond) {
      return this.respond(request);
    }
    return { ok: true, rawJson: deterministicRawJson(request), servedModel: this.served };
  }
}
