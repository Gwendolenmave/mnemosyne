import type { DatabaseSync } from "node:sqlite";
import {
  selectAdjacentEpisodeIds,
  type EpisodeAdjacencyRequest,
  type EpisodeAdjacencyRow,
  type EpisodeConversationWitness,
} from "../../../core/services/episode-adjacency.js";

interface EpisodeProjectionAdjacencyRow {
  episode_id: string;
  channel: string;
  thread: string;
  started_at_utc: string;
  ended_at_utc: string;
  published_payload: string | null;
}

function toAdjacencyRow(row: EpisodeProjectionAdjacencyRow): EpisodeAdjacencyRow {
  return {
    episodeId: row.episode_id,
    channel: row.channel,
    thread: row.thread,
    startedAtIso: row.started_at_utc,
    endedAtIso: row.ended_at_utc,
    published: row.published_payload !== null,
  };
}

/**
 * Read-only SQLite adapter for the public Episode adjacency primitive.
 *
 * The `episodes` row owns conversation identity (`channel` + `thread`).
 * `episode_messages.conversation_id`, when present for the anchor, is only a
 * consistency witness and may never broaden or replace that identity.
 *
 * This adapter performs no migration, write, wall-clock lookup, semantic
 * ranking, or lifecycle mutation. Callers own the DatabaseSync handle.
 */
export function selectAdjacentEpisodeIdsFromSqlite(input: {
  db: DatabaseSync;
  request: EpisodeAdjacencyRequest;
}): string[] {
  const { db, request } = input;
  if (!Number.isFinite(request.limit) || Math.floor(request.limit) <= 0) return [];

  const ceiling = request.availableBeforeIso ?? null;
  if (ceiling !== null && !Number.isFinite(Date.parse(ceiling))) return [];

  const anchor = db
    .prepare(
      "SELECT episode_id, channel, thread, started_at_utc, ended_at_utc, published_payload " +
        "FROM episodes WHERE episode_id = ?",
    )
    .get(request.anchorEpisodeId) as EpisodeProjectionAdjacencyRow | undefined;
  if (anchor === undefined) return [];

  const witnesses = db
    .prepare("SELECT DISTINCT conversation_id FROM episode_messages WHERE episode_id = ?")
    .all(request.anchorEpisodeId) as Array<{ conversation_id: string }>;
  const mappedWitnesses: EpisodeConversationWitness[] = witnesses.map((row) => ({
    episodeId: request.anchorEpisodeId,
    conversationId: row.conversation_id,
  }));

  const candidates = db
    .prepare(
      "SELECT episode_id, channel, thread, started_at_utc, ended_at_utc, published_payload " +
        "FROM episodes " +
        "WHERE channel = ? AND thread = ? " +
        "AND julianday(started_at_utc) >= julianday(?) AND published_payload IS NOT NULL " +
        "ORDER BY julianday(started_at_utc), julianday(ended_at_utc), episode_id",
    )
    .all(anchor.channel, anchor.thread, anchor.started_at_utc) as unknown as EpisodeProjectionAdjacencyRow[];

  return selectAdjacentEpisodeIds({
    request,
    rows: [toAdjacencyRow(anchor), ...candidates.map(toAdjacencyRow)],
    witnesses: mappedWitnesses,
  });
}
