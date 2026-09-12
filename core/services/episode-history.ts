import type { Domain, EpisodeStatus, Realm, Sensitivity } from "../domain/episode.js";

/** Public-safe bounded Episode/history candidate exposed to a host model layer. */
export interface EpisodeHistoryHit {
  episodeId: string;
  realm: Realm;
  auId: string | null;
  domain: Domain;
  title: string;
  summary: string;
  startedAtIso: string;
  endedAtIso: string;
  status: EpisodeStatus;
  sensitivity: Sensitivity;
  sourceHash: string;
}

export interface EpisodeHistorySearchRequest {
  /** Free-text recall anchor. Empty text falls back to recent published Episodes. */
  query: string;
  /** Optional owner/model-authored temporal phrase; lexical only in this v1 surface. */
  timeHint?: string | null;
  /** Strict replay ceiling: only Episodes ended by this instant are eligible. */
  availableBeforeIso?: string | null;
  /** Bounded result count. */
  limit: number;
}

export interface EpisodeHistorySource {
  search(request: EpisodeHistorySearchRequest): readonly EpisodeHistoryHit[];
}

/** Same bounded candidate pool used by the private history lane; not a relevance threshold. */
export const EPISODE_HISTORY_MAX_RESULTS = 12;
