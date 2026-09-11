import { isEpisodeId } from "../domain/episode.js";
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
 * UTF-16 code units: query <= 600 and optional time hint <= 120. Oversized
 * inputs fail closed after consuming their attempt slot and never reach the
 * projection.
 *
 * Returned structured Episode payloads also share a cumulative Unicode
 * code-point budget (24k by default). The accounting is over the exact JSON
 * representation of the public hit arrays, so ids, provenance metadata and
 * visible text all count. A result that would exceed the remaining budget is
 * discarded wholesale and grants no new same-turn authorization. Hosts may
 * choose another positive safe-integer ceiling explicitly.
 */
export class TurnScopedEpisodeRecallSession {
  private readonly returned = new Set<string>();
  private readonly availableBeforeIso: string | null;
  private readonly maxCallAttempts: number;
  private readonly maxReturnedCodePoints: number;
  private callAttempts = 0;
  private returnedCodePoints = 0;

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

  /** Search bounded history and authorize only the hits actually returned. */
  search(request: EpisodeRecallSearchRequest): readonly EpisodeHistoryHit[] {
    if (!this.consumeAttempt()) return [];
    if (!Number.isFinite(request.limit)) return [];
    const limit = Math.floor(request.limit);
    if (limit <= 0 || limit > EPISODE_HISTORY_MAX_RESULTS) return [];
    if (typeof request.query !== "string") return [];
    if (codePointLength(request.query) > EPISODE_RECALL_MAX_QUERY_CODE_POINTS) return [];
    if (request.timeHint !== undefined && request.timeHint !== null) {
      if (typeof request.timeHint !== "string") return [];
      if (codePointLength(request.timeHint) > EPISODE_RECALL_MAX_TIME_HINT_CODE_POINTS) return [];
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
      return [];
    }
    if (!this.validReturnedHits(hits, limit)) return [];
    if (!this.acceptReturnedPayload(hits)) return [];
    this.record(hits);
    return hits;
  }

  /**
   * Resolve exactly one deterministic next Episode after a same-turn anchor.
   * The raw adjacent id is not authorized until exact read succeeds and proves
   * the same id, preventing a stale/malformed projection result from widening
   * later-turn capability.
   */
  followup(afterEpisodeId: string): readonly EpisodeHistoryHit[] {
    if (!this.consumeAttempt()) return [];
    if (!this.returned.has(afterEpisodeId)) return [];

    let ids: readonly string[];
    try {
      ids = this.adjacency.adjacent({
        anchorEpisodeId: afterEpisodeId,
        direction: "next",
        availableBeforeIso: this.availableBeforeIso,
        limit: 1,
      });
    } catch {
      return [];
    }
    if (ids.length > 1) return [];
    if (ids.length === 0) return [];
    if (!isEpisodeId(ids[0]!)) return [];

    const hits = this.readExact(ids);
    if (hits.length !== 1 || hits[0]!.episodeId !== ids[0]) return [];
    if (!this.acceptReturnedPayload(hits)) return [];
    this.record(hits);
    return hits;
  }

  /**
   * Read 1..2 complete Episode hits, but only from ids already returned by
   * this same session. Unknown ids fail before the read source is invoked.
   */
  read(episodeIds: readonly string[]): readonly EpisodeHistoryHit[] {
    if (!this.consumeAttempt()) return [];
    if (episodeIds.length < 1 || episodeIds.length > EPISODE_HISTORY_MAX_READ_IDS) return [];
    const unique = new Set<string>();
    for (const id of episodeIds) {
      if (!isEpisodeId(id) || unique.has(id) || !this.returned.has(id)) return [];
      unique.add(id);
    }
    const hits = this.readExact(episodeIds);
    return this.acceptReturnedPayload(hits) ? hits : [];
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

  private readExact(ids: readonly string[]): readonly EpisodeHistoryHit[] {
    let hits: readonly EpisodeHistoryHit[];
    try {
      hits = this.reader.read({
        episodeIds: ids,
        availableBeforeIso: this.availableBeforeIso,
      });
    } catch {
      return [];
    }
    if (hits.length !== ids.length || !this.validReturnedHits(hits, ids.length)) return [];
    for (let index = 0; index < ids.length; index += 1) {
      if (hits[index]!.episodeId !== ids[index]) return [];
    }
    return hits;
  }

  private validReturnedHits(hits: readonly EpisodeHistoryHit[], limit: number): boolean {
    if (!Array.isArray(hits) || hits.length > limit) return false;
    const seen = new Set<string>();
    for (const hit of hits) {
      if (hit === null || typeof hit !== "object" || !isEpisodeId(hit.episodeId) || seen.has(hit.episodeId)) {
        return false;
      }
      seen.add(hit.episodeId);
    }
    return true;
  }

  private record(hits: readonly EpisodeHistoryHit[]): void {
    for (const hit of hits) this.returned.add(hit.episodeId);
  }
}
