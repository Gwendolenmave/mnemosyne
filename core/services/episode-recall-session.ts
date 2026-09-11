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

/**
 * Public-safe turn-scoped composition of Episode search, deterministic
 * adjacency and exact read.
 *
 * The session owns only ephemeral authorization state. It never probes storage
 * to decide whether an arbitrary id is readable: an Episode id becomes
 * readable/anchorable only after a successful search or follow-up returned the
 * corresponding validated hit in this same session. Create one instance per
 * logical model turn and discard it afterwards.
 */
export class TurnScopedEpisodeRecallSession {
  private readonly returned = new Set<string>();
  private readonly availableBeforeIso: string | null;

  constructor(
    private readonly history: EpisodeHistorySource,
    private readonly adjacency: EpisodeAdjacentIdSource,
    private readonly reader: EpisodeHistoryReadSource,
    options: { availableBeforeIso?: string | null } = {},
  ) {
    const ceiling = options.availableBeforeIso ?? null;
    if (ceiling !== null && !Number.isFinite(Date.parse(ceiling))) {
      throw new Error("availableBeforeIso must be a valid ISO timestamp or null");
    }
    this.availableBeforeIso = ceiling;
  }

  /** Search bounded history and authorize only the hits actually returned. */
  search(request: EpisodeRecallSearchRequest): readonly EpisodeHistoryHit[] {
    if (!Number.isFinite(request.limit)) return [];
    const limit = Math.floor(request.limit);
    if (limit <= 0 || limit > EPISODE_HISTORY_MAX_RESULTS) return [];
    if (typeof request.query !== "string") return [];
    if (request.timeHint !== undefined && request.timeHint !== null && typeof request.timeHint !== "string") return [];

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
    this.record(hits);
    return hits;
  }

  /**
   * Read 1..2 complete Episode hits, but only from ids already returned by
   * this same session. Unknown ids fail before the read source is invoked.
   */
  read(episodeIds: readonly string[]): readonly EpisodeHistoryHit[] {
    if (episodeIds.length < 1 || episodeIds.length > EPISODE_HISTORY_MAX_READ_IDS) return [];
    const unique = new Set<string>();
    for (const id of episodeIds) {
      if (!isEpisodeId(id) || unique.has(id) || !this.returned.has(id)) return [];
      unique.add(id);
    }
    return this.readExact(episodeIds);
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
