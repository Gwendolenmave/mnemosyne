/**
 * CURRENT SITUATION layer (context reliability §2).
 *
 * A data layer for Owner's *changing* present-day reality, deliberately
 * SEPARATE from the permanent House Priors. House Priors describe stable
 * identity/relationship/project facts; a Current Situation record describes
 * a fact that is true for a bounded stretch of time (e.g. "a temporary data
 * migration is active") and is expected to change. Keeping them apart means a stale
 * situation can expire or be superseded without ever touching the priors,
 * and a situation always outranks an older long-term memory card.
 *
 * Each record is provenance-anchored (source message/turn) and time-bounded
 * (valid_from / valid_until). Effective status is derived from stored status
 * plus the clock, so a record whose valid_until has passed reads as expired
 * even if nobody has run governance on it yet.
 */

export type SituationStatus = "active" | "superseded" | "expired";

export interface CurrentSituationRecord {
  /** Stable id (uuid). */
  id: string;
  /** Human-readable statement of the current fact. */
  value: string;
  /** Delos message_id this fact was grounded in, when known. */
  sourceMessageId: string | null;
  /** Delos turn_id this fact was grounded in, when known. */
  sourceTurnId: string | null;
  /** ISO-8601 instant the fact became true. */
  validFrom: string;
  /** ISO-8601 instant the fact stops being true; null = open-ended. */
  validUntil: string | null;
  /** id of the record this one replaces; null = original. */
  supersedes: string | null;
  /** Stored governance status; time may further downgrade it (see effectiveStatus). */
  status: SituationStatus;
  /** ISO-8601 instant the record was written. */
  createdAt: string;
}

/**
 * Effective status = stored status, further downgraded to "expired" when
 * valid_until has passed. A superseded record stays superseded regardless
 * of time. Records without a valid_until never time-expire.
 */
export function effectiveStatus(record: CurrentSituationRecord, nowIso: string): SituationStatus {
  if (record.status !== "active") {
    return record.status;
  }
  if (record.validUntil !== null && record.validUntil <= nowIso) {
    return "expired";
  }
  return "active";
}

/** True when the record is in force at the given instant. */
export function isActiveAt(record: CurrentSituationRecord, nowIso: string): boolean {
  return effectiveStatus(record, nowIso) === "active" && record.validFrom <= nowIso;
}

/**
 * Read surface the runtime needs; the SQLite store satisfies it. Kept
 * structural so core never imports the adapter.
 */
export interface CurrentSituationProvider {
  /** Records in force at nowIso, oldest validFrom first. */
  listActive(nowIso: string): CurrentSituationRecord[];
}

function localDay(iso: string): string {
  // Trust the ISO date portion; the trusted-time block already carries the
  // authoritative local clock, so a coarse UTC date here is only a hint.
  return iso.slice(0, 10);
}

/**
 * Render the stable CURRENT SITUATION block. Always emitted (even empty) so
 * its position in the assembled context is byte-stable across turns. The
 * framing states its precedence explicitly: it outranks older transcript and
 * long-term memory, and is outranked only by the current message and Owner's
 * recent explicit statements/corrections.
 */
export function renderCurrentSituationBlock(records: readonly CurrentSituationRecord[]): string {
  const lines: string[] = [
    "=== CURRENT SITUATION (Delos-maintained; time-bound facts about Owner's present reality) ===",
    "Dated, current facts. They OUTRANK older transcript and long-term memory.",
    "They are OUTRANKED only by the current message and Owner's recent explicit",
    "statements or corrections. If one of these conflicts with an old memory card,",
    "the fact here wins. Do not contradict an active fact below with a stale assumption.",
  ];
  if (records.length === 0) {
    lines.push("(no active current-situation facts)");
  } else {
    for (const r of records) {
      const until = r.validUntil !== null ? localDay(r.validUntil) : "open-ended";
      const src = r.sourceMessageId !== null ? `msg ${r.sourceMessageId}` : "seeded";
      lines.push(`- ${r.value} (in force ${localDay(r.validFrom)} → ${until}; source: ${src})`);
    }
  }
  lines.push("=== END CURRENT SITUATION ===");
  return lines.join("\n");
}
