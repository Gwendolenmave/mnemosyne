/**
 * Provider-neutral long-term memory contract. Backend output is treated
 * as opaque text; core never parses backend-specific fields or invents
 * stable memory identifiers.
 */

export interface MemoryRetrieval {
  status: "ok" | "degraded";
  /** Transport label for transcripts, e.g. "streamable-http-mcp <url>". */
  transport: string;
  query: string;
  limit: number;
  /** Opaque backend prose. Empty string when degraded or no results. */
  resultText: string;
  /** SHA-256 hex digest of resultText, or null when degraded/empty. */
  resultSha256: string | null;
  /** Safe diagnostic detail (degraded reason); never credentials. */
  detail?: string;
}

export interface MemoryProbe {
  available: boolean;
  detail: string;
}

export interface MemoryStore {
  readonly transport: string;
  /** Bounded search; implementations must enforce the limit. */
  search(query: string, limit: number): Promise<MemoryRetrieval>;
  /** Read-only availability check for status displays and preflight. */
  probe(): Promise<MemoryProbe>;
}
