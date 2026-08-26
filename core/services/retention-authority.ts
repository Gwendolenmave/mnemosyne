export const PORTABLE_RETENTION_SCHEMA_VERSION = 1 as const;

export const PORTABLE_RETENTION_EVIDENCE_CODES = [
  "volatile_state",
  "session_only",
  "time_limited_state",
  "episodic_continuity",
  "stable_relationship",
  "stable_preference",
  "durable_project",
  "exact_au_setting",
  "explicit_correction",
] as const;
export type PortableRetentionEvidenceCode =
  (typeof PORTABLE_RETENTION_EVIDENCE_CODES)[number];

export const PORTABLE_RETENTION_DESTINATIONS = [
  "none",
  "session_continuity",
  "episode_projection",
  "governed_long_term",
  "governed_correction",
  "quarantine",
] as const;
export type PortableRetentionDestination =
  (typeof PORTABLE_RETENTION_DESTINATIONS)[number];

export const PORTABLE_RETENTION_REASON_CODES = [
  "no_retention_signal",
  "volatile_session_only",
  "episodic_projection_only",
  "durable_candidate",
  "correction_workflow",
  "au_scope_required",
  "mixed_correction_evidence",
  "invalid_request",
] as const;
export type PortableRetentionReasonCode =
  (typeof PORTABLE_RETENTION_REASON_CODES)[number];

export interface PortableRetentionRequest {
  readonly schemaVersion: typeof PORTABLE_RETENTION_SCHEMA_VERSION;
  /**
   * Structured, host-observed lifetime evidence only. The library does not
   * parse user prose or infer a lifetime from provider/model output.
   */
  readonly evidenceCodes: readonly PortableRetentionEvidenceCode[];
  /** Exact host-owned AU identity when exact_au_setting is present. */
  readonly auId: string | null;
}

export interface PortableRetentionDecision {
  readonly schemaVersion: typeof PORTABLE_RETENTION_SCHEMA_VERSION;
  readonly destination: PortableRetentionDestination;
  readonly reasonCode: PortableRetentionReasonCode;
  /** Only durable candidates may enter the ordinary long-term candidate lane. */
  readonly longTermCandidateAdmissionAllowed: boolean;
  /** Corrections use a distinct governed repair lane and are never direct supersession. */
  readonly governedCorrectionAdmissionAllowed: boolean;
  /** Classification only: this contract never owns a writer. */
  readonly writePerformed: false;
}

const EXACT_AU_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const EVIDENCE_SET = new Set<string>(PORTABLE_RETENTION_EVIDENCE_CODES);
const SHORT_SESSION = new Set<PortableRetentionEvidenceCode>([
  "volatile_state",
  "session_only",
  "time_limited_state",
]);
const DURABLE = new Set<PortableRetentionEvidenceCode>([
  "stable_relationship",
  "stable_preference",
  "durable_project",
  "exact_au_setting",
]);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validEvidenceCodes(value: unknown): value is readonly PortableRetentionEvidenceCode[] {
  if (!Array.isArray(value) || value.length > PORTABLE_RETENTION_EVIDENCE_CODES.length) return false;
  const seen = new Set<string>();
  for (const code of value) {
    if (typeof code !== "string" || !EVIDENCE_SET.has(code) || seen.has(code)) return false;
    seen.add(code);
  }
  return true;
}

/** Strict public boundary for host-supplied retention classification evidence. */
export function isPortableRetentionRequest(value: unknown): value is PortableRetentionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["schemaVersion", "evidenceCodes", "auId"])) return false;
  if (record.schemaVersion !== PORTABLE_RETENTION_SCHEMA_VERSION) return false;
  if (!validEvidenceCodes(record.evidenceCodes)) return false;
  if (!(record.auId === null || (typeof record.auId === "string" && EXACT_AU_ID.test(record.auId)))) {
    return false;
  }
  if (record.auId !== null && !record.evidenceCodes.includes("exact_au_setting")) return false;
  return true;
}

function decision(
  destination: PortableRetentionDestination,
  reasonCode: PortableRetentionReasonCode,
  longTermCandidateAdmissionAllowed: boolean,
  governedCorrectionAdmissionAllowed: boolean,
): PortableRetentionDecision {
  return Object.freeze({
    schemaVersion: PORTABLE_RETENTION_SCHEMA_VERSION,
    destination,
    reasonCode,
    longTermCandidateAdmissionAllowed,
    governedCorrectionAdmissionAllowed,
    writePerformed: false as const,
  });
}

/**
 * Decide retention before ordinary long-term admission.
 *
 * Lifetime is an admission fence, not a quality score. Session-only evidence
 * therefore wins over episodic and durable evidence; episodic evidence wins
 * over durable evidence. This prevents a transient state from becoming durable
 * merely because the same turn also carries relationship/preference/project
 * hints. Stable durable evidence is admitted only when no shorter lifetime is
 * present. Corrections are a separate governed repair workflow and mixed
 * correction/lifetime evidence is quarantined for explicit adjudication.
 */
export function dispatchPortableRetention(value: unknown): PortableRetentionDecision {
  if (!isPortableRetentionRequest(value)) {
    return decision("quarantine", "invalid_request", false, false);
  }

  const reasons = value.evidenceCodes;
  if (reasons.length === 0) {
    return decision("none", "no_retention_signal", false, false);
  }

  if (reasons.includes("explicit_correction")) {
    if (reasons.length !== 1) {
      return decision("quarantine", "mixed_correction_evidence", false, false);
    }
    return decision("governed_correction", "correction_workflow", false, true);
  }

  if (reasons.some((code) => SHORT_SESSION.has(code))) {
    return decision("session_continuity", "volatile_session_only", false, false);
  }

  if (reasons.includes("episodic_continuity")) {
    return decision("episode_projection", "episodic_projection_only", false, false);
  }

  if (reasons.some((code) => DURABLE.has(code))) {
    if (reasons.includes("exact_au_setting") && value.auId === null) {
      return decision("quarantine", "au_scope_required", false, false);
    }
    return decision("governed_long_term", "durable_candidate", true, false);
  }

  return decision("quarantine", "invalid_request", false, false);
}
