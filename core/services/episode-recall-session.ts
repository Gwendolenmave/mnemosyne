import {
  isDomain,
  isEpisodeId,
  isEpisodeStatus,
  isRealm,
  isSensitivity,
} from "../domain/episode.js";
import type { EpisodeAdjacentIdSource } from "./episode-followup-session.js";
import type { EpisodeHistoryHit, EpisodeHistorySource } from "./episode-history.js";
import type { EpisodeHistoryReadSource } from "./episode-history-read.js";
import { EPISODE_HISTORY_MAX_READ_IDS } from "./episode-history-read.js";
import { EPISODE_HISTORY_MAX_RESULTS } from "./episode-history.js";

export interface EpisodeRecallSearchRequest {
  query: string;
  timeHint?: string | null;
  limit: number;
}

export type EpisodeRecallDecisionStatus = "returned" | "empty" | "failed" | "limited";
export type EpisodeRecallDecisionReason =
  | "invalid_arguments"
  | "attempt_limit"
  | "result_limit"
  | "execution_failed";

/** Content-free outcome of the most recent recall operation. */
export interface EpisodeRecallDecision {
  readonly status: EpisodeRecallDecisionStatus;
  readonly reason?: EpisodeRecallDecisionReason;
}

/** Default shared call-attempt ceiling for one logical Episode recall turn. */
export const EPISODE_RECALL_MAX_CALL_ATTEMPTS = 4;
/** Maximum Unicode code points accepted for one recall query. */
export const EPISODE_RECALL_MAX_QUERY_CODE_POINTS = 600;
/** Maximum Unicode code points accepted for one optional lexical time hint. */
export const EPISODE_RECALL_MAX_TIME_HINT_CODE_POINTS = 120;
/** Default cumulative returned structured-payload ceiling for one recall turn. */
export const EPISODE_RECALL_MAX_RETURNED_CODE_POINTS = 24_000;

function codePointLength(value: string): number {
  return [...value].length;
}

function returnedPayloadCodePoints(hits: readonly EpisodeHistoryHit[]): number {
  return codePointLength(JSON.stringify(hits));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidReturnedHit(value: unknown): value is EpisodeHistoryHit {
  if (!isRecord(value)) return false;
  if (typeof value.episodeId !== "string" || !isEpisodeId(value.episodeId)) return false;
  if (typeof value.realm !== "string" || !isRealm(value.realm)) return false;
  if (
    value.realm === "au"
      ? typeof value.auId !== "string" || value.auId.trim().length === 0
      : value.auId !== null
  ) {
    return false;
  }
  if (typeof value.domain !== "string" || !isDomain(value.domain)) return false;
  if (typeof value.title !== "string") return false;
  if (typeof value.summary !== "string" || value.summary.length === 0) return false;
  if (typeof value.startedAtIso !== "string" || !Number.isFinite(Date.parse(value.startedAtIso))) return false;
  if (typeof value.endedAtIso !== "string" || !Number.isFinite(Date.parse(value.endedAtIso))) return false;
  if (typeof value.status !== "string" || !isEpisodeStatus(value.status)) return false;
  if (typeof value.sensitivity !== "string" || !isSensitivity(value.sensitivity)) return false;
  if (typeof value.sourceHash !== "string" || value.sourceHash.trim().length === 0) return false;
  return true;
}

/**
 * Public-safe turn-scoped composition of Episode search, deterministic
 * adjacency and exact read.
 *
 * The session owns only ephemeral authorization state. It never probes storage
 * to decide whether an arbitrary id is readable: an Episode id becomes
 * readable/anchorable only after a successful search or follow-up returned the
 * corresponding validated hit in this same session. Create one instance per
 * logical model turn and discard it afterwards.
 *
 * Search, follow-up and read also share one bounded attempt ledger. Every call
 * attempt consumes one slot, including malformed/unauthorized requests, so a
 * caller cannot bypass the ceiling by repeatedly issuing calls that fail before
 * storage access. Once exhausted, later calls fail closed before invoking any
 * source and cannot widen authorization. The default is four attempts; hosts
 * may choose a stricter or larger positive safe-integer ceiling explicitly.
 *
 * Search text is bounded before any source call using Unicode code points, not
 * UTF-16 code units: query must be non-blank and <= 600; an optional time hint
 * must also be non-blank and <= 120. Invalid inputs fail closed after consuming
 * their attempt slot and never reach the projection. The lower-level history
 * primitive may still support an empty query for host-controlled recent-history
 * browsing; this stricter boundary belongs to the model-facing turn session.
 *
 * Returned structured Episode payloads also share a cumulative Unicode
 * code-point budget (24k by default). The accounting is over the exact JSON
 * representation of the public hit arrays, so ids, provenance metadata and
 * visible text all count. A result that would exceed the remaining budget is
 * discarded wholesale and grants no new same-turn authorization. Hosts may
 * choose another positive safe-integer ceiling explicitly.
 *
 * Every source result is runtime-validated before budgeting or authorization:
 * realm/AU shape, domain, timestamps, lifecycle status, sensitivity, summary
 * presence and provenance hash must all satisfy the public Episode contract.
 * A malformed custom source therefore fails closed as execution_failed and can
 * never use TypeScript-only trust to widen same-turn read/adjacency authority.
 *
 * The most recent operation also leaves a content-free decision receipt. It
 * distinguishes a genuine empty result from invalid input, attempt exhaustion,
 * result-budget exhaustion and source/contract failure without retaining query
 * text, Episode ids, payloads or provenance. Retrieval results remain the sole
 * content-bearing return value; the receipt exists only for safe observability.
 */
export class TurnScopedEpisodeRecallSession {
  private readonly returned = new Set<string>();
  private readonly availableBeforeIso: string | null;
  private readonly maxCallAttempts: number;
  private readonly maxReturnedCodePoints: number;
  private callAttempts = 0;
  private returnedCodePoints = 0;
  private decision: EpisodeRecallDecision = Object.freeze({ status: "empty" });

  constructor(
    private readonly history: EpisodeHistorySource,
    private readonly adjacency: EpisodeAdjacentIdSource,
    private readonly reader: EpisodeHistoryReadSource,
    options: {
      availableBeforeIso?: string | null;
      maxCallAttempts?: number;
      maxReturnedCodePoints?: number;
    } = {},
  ) {
    const ceiling = options.availableBeforeIso ?? null;
    if (ceiling !== null && !Number.isFinite(Date.parse(ceiling))) {
      throw new Error("availableBeforeIso must be a valid ISO timestamp or null");
    }
    const maxCallAttempts = options.maxCallAttempts ?? EPISODE_RECALL_MAX_CALL_ATTEMPTS;
    if (!Number.isSafeInteger(maxCallAttempts) || maxCallAttempts <= 0) {
      throw new Error("maxCallAttempts must be a positive safe integer");
    }
    const maxReturnedCodePoints = options.maxReturnedCodePoints ?? EPISODE_RECALL_MAX_RETURNED_CODE_POINTS;
    if (!Number.isSafeInteger(maxReturnedCodePoints) || maxReturnedCodePoints <= 0) {
      throw new Error("maxReturnedCodePoints must be a positive safe integer");
    }
    this.availableBeforeIso = ceiling;
    this.maxCallAttempts = maxCallAttempts;
    this.maxReturnedCodePoints = maxReturnedCodePoints;
  }

  /** Content-free outcome of the most recently attempted operation. */
  lastDecision(): EpisodeRecallDecision {
    return this.decision;
  }

  /** Search bounded history and authorize only the hits actually returned. */
  search(request: EpisodeRecallSearchRequest): readonly EpisodeHistoryHit[] {
    if (!this.consumeAttempt()) return this.reject("limited", "attempt_limit");
    if (!Number.isFinite(request.limit)) return this.reject("failed", "invalid_arguments");
    const limit = Math.floor(request.limit);
    if (limit <= 0 || limit > EPISODE_HISTORY_MAX_RESULTS) return this.reject("failed", "invalid_arguments");
    if (typeof request.query !== "string") return this.reject("failed", "invalid_arguments");
    if (request.query.trim().length === 0) return this.reject("failed", "invalid_arguments");
    if (codePointLength(request.query) > EPISODE_RECALL_MAX_QUERY_CODE_POINTS) {
      return this.reject("failed", "invalid_arguments");
    }
    if (request.timeHint !== undefined && request.timeHint !== null) {
      if (typeof request.timeHint !== "string") return this.reject("failed", "invalid_arguments");
      if (request.timeHint.trim().length === 0) return this.reject("failed", "invalid_arguments");
      if (codePointLength(request.timeHint) > EPISODE_RECALL_MAX_TIME_HINT_CODE_POINTS) {
        return this.reject("failed", "invalid_arguments");
      }
    }

    let hits: readonly EpisodeHistoryHit[];
    try {
      hits = this.history.search({
        query: request.query,
        timeHint: request.timeHint ?? null,
        availableBeforeIso: this.availableBeforeIso,
        limit,
      });
    } catch {
      return this.reject("failed", "execution_failed");
    }
    if (!this.validReturnedHits(hits, limit)) return this.reject("failed", "execution_failed");
    if (!this.acceptReturnedPayload(hits)) return this.reject("limited", "result_limit");
    this.record(hits);
    return this.accept(hits);
  }

  /**
   * Resolve exactly one deterministic next Episode after a same-turn anchor.
   * The raw adjacent id is not authorized until exact read succeeds and proves
   * the same id, preventing a stale/malformed projection result from widening
   * later-turn capability.
   */
  followup(afterEpisodeId: string): readonly EpisodeHistoryHit[] {
    if (!this.consumeAttempt()) return this.reject("limited", "attempt_limit");
    if (!isEpisodeId(afterEpisodeId) || !this.returned.has(afterEpisodeId)) {
      return this.reject("failed", "invalid_arguments");
    }

    let ids: readonly string[];
    try {
      ids = this.adjacency.adjacent({
        anchorEpisodeId: afterEpisodeId,
        direction: "next",
        availableBeforeIso: this.availableBeforeIso,
        limit: 1,
      });
    } catch {
      return this.reject("failed", "execution_failed");
    }
    if (!Array.isArray(ids) || ids.length > 1) return this.reject("failed", "execution_failed");
    if (ids.length === 0) return this.accept([]);
    if (!isEpisodeId(ids[0]!)) return this.reject("failed", "execution_failed");

    const hits = this.readExact(ids);
    if (hits === null) return this.reject("failed", "execution_failed");
    if (!this.acceptReturnedPayload(hits)) return this.reject("limited", "result_limit");
    this.record(hits);
    return this.accept(hits);
  }

  /**
   * Read 1..2 complete Episode hits, but only from ids already returned by
   * this same session. Unknown ids fail before the read source is invoked.
   */
  read(episodeIds: readonly string[]): readonly EpisodeHistoryHit[] {
    if (!this.consumeAttempt()) return this.reject("limited", "attempt_limit");
    if (!Array.isArray(episodeIds) || episodeIds.length < 1 || episodeIds.length > EPISODE_HISTORY_MAX_READ_IDS) {
      return this.reject("failed", "invalid_arguments");
    }
    const unique = new Set<string>();
    for (const id of episodeIds) {
      if (!isEpisodeId(id) || unique.has(id) || !this.returned.has(id)) {
        return this.reject("failed", "invalid_arguments");
      }
      unique.add(id);
    }
    const hits = this.readExact(episodeIds);
    if (hits === null) return this.reject("failed", "execution_failed");
    if (!this.acceptReturnedPayload(hits)) return this.reject("limited", "result_limit");
    return this.accept(hits);
  }

  private consumeAttempt(): boolean {
    if (this.callAttempts >= this.maxCallAttempts) return false;
    this.callAttempts += 1;
    return true;
  }

  private acceptReturnedPayload(hits: readonly EpisodeHistoryHit[]): boolean {
    const cost = returnedPayloadCodePoints(hits);
    if (cost > this.maxReturnedCodePoints - this.returnedCodePoints) return false;
    this.returnedCodePoints += cost;
    return true;
  }

  private readExact(ids: readonly string[]): readonly EpisodeHistoryHit[] | null {
    let hits: readonly EpisodeHistoryHit[];
    try {
      hits = this.reader.read({
        episodeIds: ids,
        availableBeforeIso: this.availableBeforeIso,
      });
    } catch {
      return null;
    }
    if (hits.length !== ids.length || !this.validReturnedHits(hits, ids.length)) return null;
    for (let index = 0; index < ids.length; index += 1) {
      if (hits[index]!.episodeId !== ids[index]) return null;
    }
    return hits;
  }

  private validReturnedHits(hits: readonly EpisodeHistoryHit[], limit: number): boolean {
    if (!Array.isArray(hits) || hits.length > limit) return false;
    const seen = new Set<string>();
    for (const hit of hits) {
      if (!isValidReturnedHit(hit) || seen.has(hit.episodeId)) return false;
      seen.add(hit.episodeId);
    }
    return true;
  }

  private record(hits: readonly EpisodeHistoryHit[]): void {
    for (const hit of hits) this.returned.add(hit.episodeId);
  }

  private accept(hits: readonly EpisodeHistoryHit[]): readonly EpisodeHistoryHit[] {
    this.decision = Object.freeze({ status: hits.length > 0 ? "returned" : "empty" });
    return hits;
  }

  private reject(
    status: Extract<EpisodeRecallDecisionStatus, "failed" | "limited">,
    reason: EpisodeRecallDecisionReason,
  ): readonly EpisodeHistoryHit[] {
    this.decision = Object.freeze({ status, reason });
    return [];
  }
}
