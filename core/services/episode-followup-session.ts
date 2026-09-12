import { isEpisodeId } from "../domain/episode.js";
import type { EpisodeAdjacencyRequest } from "./episode-adjacency.js";

/** Minimal read-only source needed for one turn-scoped Episode follow-up gate. */
export interface EpisodeAdjacentIdSource {
  adjacent(request: EpisodeAdjacencyRequest): readonly string[];
}

export interface EpisodeFollowupRequest {
  /** Must have been returned by this same session earlier in the turn. */
  afterEpisodeId: string;
  availableBeforeIso?: string | null;
  limit: number;
}

/**
 * Turn-local authorization gate for deterministic Episode multihop recall.
 *
 * The gate never probes storage to decide whether an arbitrary Episode id is a
 * valid anchor. An id becomes anchorable only after the caller explicitly
 * records that it was already returned to the model in this same session.
 * Adjacency hits are then admitted into the same set, enabling bounded
 * multi-hop traversal without widening authority across turns.
 *
 * This class owns no store, clock, lifecycle policy, or model/tool protocol.
 * Create one instance per logical model turn and discard it afterwards.
 */
export class TurnScopedEpisodeFollowupSession {
  private readonly returned = new Set<string>();

  constructor(private readonly source: EpisodeAdjacentIdSource) {}

  /** Record Episode ids that were actually exposed earlier in this turn. */
  recordReturnedEpisodeIds(ids: readonly string[]): void {
    for (const id of ids) {
      if (isEpisodeId(id)) this.returned.add(id);
    }
  }

  /**
   * Return deterministic next Episodes only when the anchor is turn-authorized.
   * Source failures, malformed output, invalid ceilings, and invalid limits all
   * fail closed. Newly returned hits become legal anchors for a later hop in
   * this same session.
   */
  adjacent(input: EpisodeFollowupRequest): string[] {
    if (!this.returned.has(input.afterEpisodeId)) return [];
    if (!Number.isFinite(input.limit)) return [];
    const limit = Math.floor(input.limit);
    if (limit <= 0) return [];

    const ceiling = input.availableBeforeIso ?? null;
    if (ceiling !== null && !Number.isFinite(Date.parse(ceiling))) return [];

    let raw: readonly string[];
    try {
      raw = this.source.adjacent({
        anchorEpisodeId: input.afterEpisodeId,
        direction: "next",
        availableBeforeIso: ceiling,
        limit,
      });
    } catch {
      return [];
    }

    const hits: string[] = [];
    const seen = new Set<string>();
    for (const id of raw.slice(0, limit)) {
      if (!isEpisodeId(id)) return [];
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push(id);
    }

    for (const id of hits) this.returned.add(id);
    return hits;
  }
}
