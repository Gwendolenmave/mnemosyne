import type { EpisodeHistoryHit } from "./episode-history.js";
import type { EpisodeRecallSearchRequest } from "./episode-recall-session.js";
import { TurnScopedEpisodeRecallSession } from "./episode-recall-session.js";

export type EpisodeRecallAuditOperation = "search" | "followup" | "read";
export type EpisodeRecallAuditOutcome = "returned" | "empty";

/**
 * Content-free observation of one public Episode recall operation.
 *
 * Deliberately excludes query text, time hints, Episode ids, titles, summaries,
 * provenance hashes, source paths and provider payloads. Hosts may persist these
 * receipts without turning an audit trail into a second memory transcript.
 */
export interface EpisodeRecallAuditEvent {
  readonly sequence: number;
  readonly operation: EpisodeRecallAuditOperation;
  readonly requestedCount: number;
  readonly returnedCount: number;
  readonly outcome: EpisodeRecallAuditOutcome;
}

export type EpisodeRecallAuditSink = (event: EpisodeRecallAuditEvent) => void;

/**
 * Thin behavior-preserving audit wrapper around a turn-scoped recall session.
 *
 * The wrapped session remains the sole authorization and retrieval authority.
 * This adapter never reads storage, never caches content, and never changes a
 * result. Audit-sink failures are contained so observability cannot break a
 * memory turn.
 */
export class AuditedEpisodeRecallSession {
  private sequence = 0;

  constructor(
    private readonly session: TurnScopedEpisodeRecallSession,
    private readonly sink: EpisodeRecallAuditSink,
  ) {
    if (session === null || session === undefined) throw new Error("session must be provided");
    if (typeof sink !== "function") throw new Error("sink must be a function");
  }

  search(request: EpisodeRecallSearchRequest): readonly EpisodeHistoryHit[] {
    const hits = this.session.search(request);
    this.emit("search", Number.isFinite(request.limit) ? Math.max(0, Math.floor(request.limit)) : 0, hits.length);
    return hits;
  }

  followup(afterEpisodeId: string): readonly EpisodeHistoryHit[] {
    const hits = this.session.followup(afterEpisodeId);
    this.emit("followup", 1, hits.length);
    return hits;
  }

  read(episodeIds: readonly string[]): readonly EpisodeHistoryHit[] {
    const hits = this.session.read(episodeIds);
    this.emit("read", episodeIds.length, hits.length);
    return hits;
  }

  private emit(operation: EpisodeRecallAuditOperation, requestedCount: number, returnedCount: number): void {
    const event: EpisodeRecallAuditEvent = Object.freeze({
      sequence: ++this.sequence,
      operation,
      requestedCount,
      returnedCount,
      outcome: returnedCount > 0 ? "returned" : "empty",
    });
    try {
      this.sink(event);
    } catch {
      // Audit is observation only. A broken sink must never alter recall.
    }
  }
}
