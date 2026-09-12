import { isEpisodeId } from "../domain/episode.js";

/**
 * Public-safe deterministic Episode adjacency primitive.
 *
 * This is deliberately storage-agnostic: callers provide already-validated
 * published projection rows plus any conversation-mapping witnesses they
 * possess. The selector never guesses across conversations and never uses
 * semantic similarity, wall-clock "now", or provider state.
 */
export interface EpisodeAdjacencyRow {
  episodeId: string;
  channel: string;
  thread: string;
  startedAtIso: string;
  endedAtIso: string;
  published: boolean;
}

export interface EpisodeConversationWitness {
  episodeId: string;
  conversationId: string;
}

export interface EpisodeAdjacencyRequest {
  anchorEpisodeId: string;
  direction: "next";
  availableBeforeIso?: string | null;
  limit: number;
}

function parseInstant(value: string): number | null {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

/**
 * Return the next published Episode ids in the anchor's authoritative
 * conversation, in stable chronological order.
 *
 * Fail-closed rules:
 * - malformed/unknown/unpublished anchor => []
 * - unsupported direction or non-positive/non-finite limit => []
 * - invalid replay ceiling => []
 * - any witness that disagrees with the anchor thread => []
 *
 * Witness absence is allowed: the row's own channel/thread pair is the
 * authority; witnesses only strengthen consistency when available.
 */
export function selectAdjacentEpisodeIds(input: {
  request: EpisodeAdjacencyRequest;
  rows: readonly EpisodeAdjacencyRow[];
  witnesses?: readonly EpisodeConversationWitness[];
}): string[] {
  const { request, rows } = input;
  if (!isEpisodeId(request.anchorEpisodeId)) return [];
  if (request.direction !== "next") return [];
  if (!Number.isFinite(request.limit)) return [];
  const limit = Math.floor(request.limit);
  if (limit <= 0) return [];

  const ceiling = request.availableBeforeIso ?? null;
  const ceilingMs = ceiling === null ? null : parseInstant(ceiling);
  if (ceiling !== null && ceilingMs === null) return [];

  const anchor = rows.find(
    (row) =>
      row.episodeId === request.anchorEpisodeId &&
      row.published &&
      parseInstant(row.startedAtIso) !== null &&
      parseInstant(row.endedAtIso) !== null,
  );
  if (anchor === undefined) return [];
  const anchorStartedMs = parseInstant(anchor.startedAtIso);
  if (anchorStartedMs === null) return [];

  const witnesses = input.witnesses ?? [];
  for (const witness of witnesses) {
    if (witness.episodeId === anchor.episodeId && witness.conversationId !== anchor.thread) {
      return [];
    }
  }

  const candidates: Array<{ row: EpisodeAdjacencyRow; startedAtMs: number; endedAtMs: number }> = [];
  for (const row of rows) {
    if (!row.published || !isEpisodeId(row.episodeId)) continue;
    if (row.episodeId === anchor.episodeId) continue;
    if (row.channel !== anchor.channel || row.thread !== anchor.thread) continue;
    const startedAtMs = parseInstant(row.startedAtIso);
    const endedAtMs = parseInstant(row.endedAtIso);
    if (startedAtMs === null || endedAtMs === null) continue;
    if (startedAtMs <= anchorStartedMs) continue;
    if (ceilingMs !== null && endedAtMs > ceilingMs) continue;
    candidates.push({ row, startedAtMs, endedAtMs });
  }

  return candidates
    .sort((a, b) =>
      a.startedAtMs - b.startedAtMs ||
      a.endedAtMs - b.endedAtMs ||
      a.row.episodeId.localeCompare(b.row.episodeId),
    )
    .slice(0, limit)
    .map(({ row }) => row.episodeId);
}
