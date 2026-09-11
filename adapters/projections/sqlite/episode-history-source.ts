import type { DatabaseSync } from "node:sqlite";
import {
  isDomain,
  isEpisodeId,
  isEpisodeStatus,
  isRealm,
  isSensitivity,
  type Domain,
  type EpisodeStatus,
  type Realm,
  type Sensitivity,
} from "../../../core/domain/episode.js";
import { validateEpisodePayload, validPublished } from "../../../core/domain/episode-validation.js";
import {
  EPISODE_HISTORY_MAX_RESULTS,
  type EpisodeHistoryHit,
  type EpisodeHistorySearchRequest,
} from "../../../core/services/episode-history.js";
import { segmentForSearch } from "../../../core/services/segmentation.js";

interface EpisodeHistoryRow {
  episode_id: string;
  realm: Realm;
  au_id: string | null;
  domain: Domain;
  started_at_utc: string;
  ended_at_utc: string;
  status: EpisodeStatus;
  sensitivity: Sensitivity;
  title: string;
  source_hash: string;
  published_payload: string;
}

const COLUMNS =
  "e.episode_id, e.realm, e.au_id, e.domain, e.started_at_utc, e.ended_at_utc, " +
  "e.status, e.sensitivity, e.title, e.source_hash, e.published_payload";

function ftsExpression(text: string): string | null {
  const tokens = segmentForSearch(text).split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return [...new Set(tokens)].map((token) => `\"${token.replaceAll('"', '""')}\"`).join(" OR ");
}

function toHit(row: EpisodeHistoryRow): EpisodeHistoryHit | null {
  if (
    !isEpisodeId(row.episode_id) ||
    !isRealm(row.realm) ||
    !isDomain(row.domain) ||
    !isEpisodeStatus(row.status) ||
    !isSensitivity(row.sensitivity) ||
    !Number.isFinite(Date.parse(row.started_at_utc)) ||
    !Number.isFinite(Date.parse(row.ended_at_utc))
  ) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.published_payload);
  } catch {
    return null;
  }
  const validated = validateEpisodePayload(raw);
  if (!validated.ok) return null;
  if (
    !validPublished({
      publishedPayload: validated.value,
      currentSourceHash: row.source_hash,
      currentEffectiveRealm: row.realm,
      currentEffectiveAuId: row.au_id,
      currentEffectiveDomain: row.domain,
    })
  ) {
    return null;
  }
  return {
    episodeId: row.episode_id,
    realm: row.realm,
    auId: row.au_id,
    domain: row.domain,
    title: validated.value.title ?? row.title,
    summary: validated.value.summary,
    startedAtIso: row.started_at_utc,
    endedAtIso: row.ended_at_utc,
    status: row.status,
    sensitivity: row.sensitivity,
    sourceHash: row.source_hash,
  };
}

/**
 * Read-only lexical Episode/history search over the public projection.
 *
 * It preserves the projection's current-published integrity contract, applies
 * an explicit replay ceiling, and returns bounded provenance-bearing candidates.
 * It performs no write, migration, semantic/vector ranking, wall-clock lookup,
 * model call, or visibility filtering by realm/domain/sensitivity.
 */
export function searchEpisodeHistoryFromSqlite(input: {
  db: DatabaseSync;
  request: EpisodeHistorySearchRequest;
}): EpisodeHistoryHit[] {
  const { db, request } = input;
  if (!Number.isFinite(request.limit)) return [];
  const limit = Math.min(EPISODE_HISTORY_MAX_RESULTS, Math.floor(request.limit));
  if (limit <= 0) return [];

  const ceiling = request.availableBeforeIso ?? null;
  if (ceiling !== null && !Number.isFinite(Date.parse(ceiling))) return [];

  const expression = ftsExpression(`${request.query} ${request.timeHint ?? ""}`);
  const conditions = ["e.published_payload IS NOT NULL"];
  const params: Array<string | number> = [];
  if (ceiling !== null) {
    conditions.push("e.ended_at_utc <= ?");
    params.push(ceiling);
  }

  const from = expression === null
    ? "episodes e"
    : "episodes_fts JOIN episodes e ON e.episode_id = episodes_fts.episode_id";
  if (expression !== null) {
    conditions.push("episodes_fts MATCH ?");
    params.push(expression);
  }
  const order = expression === null
    ? "e.ended_at_utc DESC, e.episode_id ASC"
    : "bm25(episodes_fts) ASC, e.ended_at_utc DESC, e.episode_id ASC";

  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM ${from} WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ?`)
    .all(...params, limit) as unknown as EpisodeHistoryRow[];
  return rows.map(toHit).filter((hit): hit is EpisodeHistoryHit => hit !== null);
}
