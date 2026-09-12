import type { DatabaseSync } from "node:sqlite";
import {
  isDomain,
  isEpisodeStatus,
  isRealm,
  isSensitivity,
  type Domain,
  type EpisodeStatus,
  type Realm,
  type Sensitivity,
} from "../../../core/domain/episode.js";
import { validateEpisodePayload, validPublished } from "../../../core/domain/episode-validation.js";
import type { EpisodeHistoryHit } from "../../../core/services/episode-history.js";
import {
  type EpisodeHistoryReadRequest,
  validateEpisodeHistoryReadRequest,
} from "../../../core/services/episode-history-read.js";

interface EpisodeHistoryReadRow {
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
  "episode_id, realm, au_id, domain, started_at_utc, ended_at_utc, status, sensitivity, title, source_hash, published_payload";

function toHit(row: EpisodeHistoryReadRow): EpisodeHistoryHit | null {
  if (
    !isRealm(row.realm) ||
    !isDomain(row.domain) ||
    !isEpisodeStatus(row.status) ||
    !isSensitivity(row.sensitivity) ||
    !Number.isFinite(Date.parse(row.started_at_utc)) ||
    !Number.isFinite(Date.parse(row.ended_at_utc))
  ) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(row.published_payload);
  } catch {
    return null;
  }
  const validated = validateEpisodePayload(raw);
  if (!validated.ok) return null;
  if (!validPublished({
    publishedPayload: validated.value,
    currentSourceHash: row.source_hash,
    currentEffectiveRealm: row.realm,
    currentEffectiveAuId: row.au_id,
    currentEffectiveDomain: row.domain,
  })) return null;

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
 * Resolve 1..2 exact published Episodes from the read-only projection.
 *
 * Request order is preserved. Unknown ids, stale/malformed published payloads,
 * replay-ceiling violations, or malformed requests fail closed for the whole
 * read rather than returning an ambiguous partial result. The adapter performs
 * no migration, write, semantic ranking, wall-clock lookup, or authorization.
 */
export function readEpisodeHistoryByIdsFromSqlite(input: {
  db: DatabaseSync;
  request: EpisodeHistoryReadRequest;
}): EpisodeHistoryHit[] {
  const { db, request } = input;
  if (!validateEpisodeHistoryReadRequest(request)) return [];
  const ceiling = request.availableBeforeIso ?? null;
  const ceilingMs = ceiling === null ? null : Date.parse(ceiling);
  if (ceilingMs !== null && !Number.isFinite(ceilingMs)) return [];
  const statement = db.prepare(
    `SELECT ${COLUMNS} FROM episodes WHERE episode_id = ? AND published_payload IS NOT NULL`,
  );

  const hits: EpisodeHistoryHit[] = [];
  for (const id of request.episodeIds) {
    const row = statement.get(id) as EpisodeHistoryReadRow | undefined;
    if (row === undefined) return [];
    const endedAtMs = Date.parse(row.ended_at_utc);
    if (!Number.isFinite(endedAtMs)) return [];
    if (ceilingMs !== null && endedAtMs > ceilingMs) return [];
    const hit = toHit(row);
    if (hit === null) return [];
    hits.push(hit);
  }
  return hits;
}
