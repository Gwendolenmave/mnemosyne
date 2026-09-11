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

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
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
  if (ceiling !== null && !validIso(ceiling)) return [];

  const anchor = rows.find(
    (row) => row.episodeId === request.anchorEpisodeId && row.published && validIso(row.startedAtIso) && validIso(row.endedAtIso),
  );
  if (anchor === undefined) return [];

  const witnesses = input.witnesses ?? [];
  for (const witness of witnesses) {
    if (witness.episodeId === anchor.episodeId && witness.conversationId !== anchor.thread) {
      return [];
    }
  }

  return rows
    .filter((row) => {
      if (!row.published || !isEpisodeId(row.episodeId)) return false;
      if (row.episodeId === anchor.episodeId) return false;
      if (row.channel !== anchor.channel || row.thread !== anchor.thread) return false;
      if (!validIso(row.startedAtIso) || !validIso(row.endedAtIso)) return false;
      if (row.startedAtIso <= anchor.startedAtIso) return false;
      if (ceiling !== null && row.endedAtIso > ceiling) return false;
      return true;
    })
    .sort((a, b) =>
      a.startedAtIso.localeCompare(b.startedAtIso) ||
      a.endedAtIso.localeCompare(b.endedAtIso) ||
      a.episodeId.localeCompare(b.episodeId),
    )
    .slice(0, limit)
    .map((row) => row.episodeId);
}
