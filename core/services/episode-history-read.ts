import { isEpisodeId } from "../domain/episode.js";
import type { EpisodeHistoryHit } from "./episode-history.js";

/** Mirror the bounded exact-read surface used by the host memory tool. */
export const EPISODE_HISTORY_MAX_READ_IDS = 2;

export interface EpisodeHistoryReadRequest {
  /** Exact Episode ids already selected by a caller-owned authorization layer. */
  episodeIds: readonly string[];
  /** Strict replay ceiling: Episodes ending after this instant are ineligible. */
  availableBeforeIso?: string | null;
}

/** Read-only exact Episode resolver. Authorization remains caller-owned. */
export interface EpisodeHistoryReadSource {
  read(request: EpisodeHistoryReadRequest): readonly EpisodeHistoryHit[];
}

/**
 * Validate the request shape before an adapter touches storage.
 *
 * Exact reads are deliberately small and all-or-nothing: 1..2 unique valid
 * Episode ids only. This primitive grants no authority to invent/probe ids;
 * hosts should compose it behind a same-turn authorization cache/gate.
 */
export function validateEpisodeHistoryReadRequest(request: EpisodeHistoryReadRequest): boolean {
  if (request.episodeIds.length < 1 || request.episodeIds.length > EPISODE_HISTORY_MAX_READ_IDS) return false;
  const unique = new Set<string>();
  for (const id of request.episodeIds) {
    if (!isEpisodeId(id) || unique.has(id)) return false;
    unique.add(id);
  }
  const ceiling = request.availableBeforeIso ?? null;
  if (ceiling !== null && !Number.isFinite(Date.parse(ceiling))) return false;
  return true;
}
