/**
 * Handwritten runtime validators for the Episode Projection contracts.
 * Pure and in-memory only (mirrors core/domain/memory-validation.ts): shape
 * rules for the payload container (§1.1.2) and the override events (§1.4.2),
 * plus the current-published predicate (§1.3.3a). Storage, override replay,
 * package promotion, and history retirement belong to later tickets and are
 * deliberately absent.
 *
 * Unknown fields are rejected recursively on every canonical shape — that is
 * what makes retired vocabulary (scope, episode_type, published_at, active,
 * reopened, ACTIVE_TTL_H, a set_field `summary` key) structurally
 * impossible rather than merely discouraged.
 *
 * These validators are self-contained on purpose: the Episode Projection
 * (L1) must not depend on the Mnemosyne memory domain, so the tiny shared
 * primitives are defined here rather than imported across domains.
 */

import {
  PAYLOAD_VERSION,
  isClaimKind,
  isDomain,
  isEnabledOverrideAuthor,
  isEpisodeId,
  isMessageEvidenceCoverage,
  isOverrideAuthor,
  isOverrideId,
  isPayloadSourceBasis,
  isRealm,
  isSensitivity,
  isShanghaiIso,
  isUncertainFlag,
  titleCharCount,
  TITLE_MAX_CHARS,
  type Domain,
  type EpisodePayload,
  type Realm,
} from "./episode.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

const SHA256_HEX = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Missing-required and unknown-field checks for one object shape. */
function checkShape(
  obj: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!(key in obj)) {
      issues.push({ path: `${path}.${key}`, message: "required field is missing" });
    }
  }
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: "unknown field is not allowed on canonical shapes",
      });
    }
  }
}

function checkNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path: `${path}.${key}`, message: `${key} must be a non-empty string` });
  }
}

/** String OR null (an explicit-null-allowed field such as title / domain_suggestion). */
function checkNullableString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (value !== null && typeof value !== "string") {
    issues.push({ path: `${path}.${key}`, message: `${key} must be a string or null` });
  }
}

function checkStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    issues.push({ path: `${path}.${key}`, message: `${key} must be an array of strings` });
  }
}

function checkEnum(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  guard: (v: string) => boolean,
  enumLabel: string,
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (typeof value !== "string" || !guard(value)) {
    issues.push({ path: `${path}.${key}`, message: `${key} must be one of ${enumLabel}` });
  }
}

function checkSha256(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    issues.push({
      path: `${path}.${key}`,
      message: `${key} must be "sha256:" + 64 lowercase hex (full, untruncated)`,
    });
  }
}

/** Strict Asia/Shanghai ISO instant with a literal +08:00 offset (rejects Z / naive / fake). */
function checkShanghaiIso(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (typeof value !== "string" || !isShanghaiIso(value)) {
    issues.push({
      path: `${path}.${key}`,
      message: `${key} must be an ISO instant with a literal +08:00 offset (no Z / naive UTC / rolled-over date)`,
    });
  }
}

/** Materialized-title ceiling: ≤40 characters (§1.1.2 field 7). */
function checkTitleLimit(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (typeof value === "string" && titleCharCount(value) > TITLE_MAX_CHARS) {
    issues.push({ path: `${path}.${key}`, message: `${key} must be ≤${TITLE_MAX_CHARS} characters` });
  }
}

// ---------------------------------------------------------------------------
// Payload container (§1.1.2). source_basis drives the model/owner branch.
// ---------------------------------------------------------------------------

/**
 * Valid message-id list: a non-empty array whose every entry is a non-empty,
 * non-whitespace string. An empty array, or one containing "" / "  ", is NOT
 * valid evidence — the empty string must never masquerade as a message id.
 */
const isValidEvidenceArray = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string" && id.trim().length > 0);

/** A claim carries evidence iff its evidence_message_ids is a valid message-id list. */
function hasEvidence(claim: unknown): boolean {
  return isRecord(claim) && isValidEvidenceArray(claim["evidence_message_ids"]);
}

/**
 * message-id array field (evidence_message_ids / supporting_message_ids). If
 * present, it must be a non-empty array of non-empty, non-whitespace strings.
 * An empty array is rejected outright: "no evidence" is expressed by OMITTING
 * the field, so an empty array can never seed an ambiguous replay branch.
 */
function checkMessageIdArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (!Array.isArray(value)) {
    issues.push({ path: `${path}.${key}`, message: `${key} must be an array` });
    return;
  }
  if (value.length === 0) {
    issues.push({
      path: `${path}.${key}`,
      message: `${key} must be omitted rather than an empty array (an empty array is ambiguous)`,
    });
    return;
  }
  value.forEach((id, i) => {
    if (typeof id !== "string" || id.trim().length === 0) {
      issues.push({
        path: `${path}.${key}[${i}]`,
        message: `${key} entries must be non-empty, non-whitespace strings`,
      });
    }
  });
}

function checkClaim(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  sourceBasis: string | undefined,
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "claim must be an object" });
    return;
  }
  checkShape(value, path, issues, ["text"], ["kind", "evidence_message_ids"]);
  checkNonEmptyString(value, "text", path, issues);
  // kind is required on model packages, optional (omit == unclassified) on owner packages.
  if (sourceBasis === "model" && !("kind" in value)) {
    issues.push({ path: `${path}.kind`, message: "kind is required on model-package claims" });
  }
  checkEnum(value, "kind", path, issues, isClaimKind, "event/decision/unfinished");
  // If present, evidence must be a valid non-empty message-id list (no "" / []).
  checkMessageIdArray(value, "evidence_message_ids", path, issues);
  // Model claims MUST carry (valid, non-empty) message evidence (§1.1.5 traceability).
  if (sourceBasis === "model" && !("evidence_message_ids" in value)) {
    issues.push({
      path: `${path}.evidence_message_ids`,
      message: "evidence_message_ids is required on model-package claims",
    });
  }
}

function checkTemporalHint(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "temporal_hint must be an object" });
    return;
  }
  checkShape(value, path, issues, ["text", "message_id", "normalized_range", "confidence"]);
  checkNonEmptyString(value, "text", path, issues);
  checkNonEmptyString(value, "message_id", path, issues);
  checkNonEmptyString(value, "normalized_range", path, issues);
  if ("confidence" in value) {
    const c = value["confidence"];
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
      issues.push({ path: `${path}.confidence`, message: "confidence must be a finite number in [0,1]" });
    }
  }
}

function checkUncertainFlags(obj: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  if (!("uncertain_flags" in obj)) return;
  const flags = obj["uncertain_flags"];
  if (!Array.isArray(flags)) {
    issues.push({ path: `${path}.uncertain_flags`, message: "uncertain_flags must be an array" });
    return;
  }
  flags.forEach((f, i) => {
    if (typeof f !== "string" || !isUncertainFlag(f)) {
      issues.push({
        path: `${path}.uncertain_flags[${i}]`,
        message: "uncertain_flags entries must be from the closed persisted vocabulary",
      });
    }
  });
}

function checkGenerator(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  sourceBasis: string | undefined,
): void {
  if (sourceBasis === "owner_override") {
    if (value !== null) {
      issues.push({ path, message: "owner packages must carry generator = null" });
    }
    return;
  }
  if (sourceBasis === "model") {
    if (!isRecord(value)) {
      issues.push({ path, message: "model packages must carry a generator object" });
      return;
    }
    checkShape(value, path, issues, ["model", "summary_version", "projection_version"]);
    checkNonEmptyString(value, "model", path, issues);
    checkNonEmptyString(value, "summary_version", path, issues);
    checkNonEmptyString(value, "projection_version", path, issues);
    return;
  }
  // Unknown source_basis: already reported on the provenance shape; accept
  // either null or an object here without a second, confusing error.
  if (value !== null && !isRecord(value)) {
    issues.push({ path, message: "generator must be an object or null" });
  }
}

function checkProvenance(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "provenance must be an object" });
    return undefined;
  }
  checkShape(value, path, issues, [
    "source_hash",
    "effective_realm",
    "effective_au_id",
    "effective_domain",
    "generator",
    "created_at",
    "source_basis",
  ]);
  checkSha256(value, "source_hash", path, issues);
  checkEnum(value, "effective_realm", path, issues, isRealm, "reality/au/uncertain");
  checkEnum(value, "effective_domain", path, issues, isDomain, "the domain enum");
  checkEnum(value, "source_basis", path, issues, isPayloadSourceBasis, "model/owner_override");
  checkShanghaiIso(value, "created_at", path, issues);

  // effective_au_id ↔ effective_realm invariant (§1.1.1 field 3).
  const realm = value["effective_realm"];
  const auId = value["effective_au_id"];
  if (realm === "au") {
    if (typeof auId !== "string" || auId.trim().length === 0) {
      issues.push({
        path: `${path}.effective_au_id`,
        message: "effective_au_id must be a non-empty string when effective_realm is au",
      });
    }
  } else if ("effective_au_id" in value && auId !== null) {
    issues.push({
      path: `${path}.effective_au_id`,
      message: "effective_au_id must be null unless effective_realm is au",
    });
  }

  const sourceBasis = typeof value["source_basis"] === "string" ? (value["source_basis"] as string) : undefined;
  checkGenerator(value["generator"], `${path}.generator`, issues, sourceBasis);
  return sourceBasis && isPayloadSourceBasis(sourceBasis) ? sourceBasis : undefined;
}

/**
 * Validate a payload whole (generated / published / history are identical
 * in shape). Requires a top-level `sensitivity` on every payload (Errata 2)
 * and enforces the model/owner branch: model packages carry a generator and
 * classified claims with non-empty evidence and MUST NOT carry
 * message_evidence_coverage; owner packages carry generator=null and a
 * required message_evidence_coverage whose value must be consistent with the
 * final claims' evidence (§1.4.5).
 */
export function validateEpisodePayload(value: unknown, path = "$"): ValidationResult<EpisodePayload> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path, message: "payload must be an object" }] };
  }
  checkShape(
    value,
    path,
    issues,
    [
      "payload_version",
      "title",
      "summary",
      "claims",
      "temporal_hints",
      "entities_model",
      "uncertain_flags",
      "summary_confidence",
      "domain_suggestion",
      "sensitivity",
      "provenance",
    ],
    ["message_evidence_coverage"],
  );

  if ("payload_version" in value && value["payload_version"] !== PAYLOAD_VERSION) {
    issues.push({
      path: `${path}.payload_version`,
      message: `payload_version must be exactly "${PAYLOAD_VERSION}"`,
    });
  }
  checkNullableString(value, "title", path, issues);
  checkTitleLimit(value, "title", path, issues);
  checkNonEmptyString(value, "summary", path, issues);
  checkNullableString(value, "domain_suggestion", path, issues);
  checkStringArray(value, "entities_model", path, issues);
  checkUncertainFlags(value, path, issues);
  checkEnum(value, "sensitivity", path, issues, isSensitivity, "normal/sensitive/intimate");

  if ("summary_confidence" in value) {
    const sc = value["summary_confidence"];
    if (sc !== null && (typeof sc !== "number" || !Number.isFinite(sc) || sc < 0 || sc > 1)) {
      issues.push({
        path: `${path}.summary_confidence`,
        message: "summary_confidence must be null or a finite number in [0,1]",
      });
    }
  }

  const sourceBasis = "provenance" in value
    ? checkProvenance(value["provenance"], `${path}.provenance`, issues)
    : undefined;

  let claimsArray: unknown[] | null = null;
  if ("claims" in value) {
    const claims = value["claims"];
    if (!Array.isArray(claims)) {
      issues.push({ path: `${path}.claims`, message: "claims must be an array" });
    } else {
      claimsArray = claims;
      claims.forEach((c, i) => checkClaim(c, `${path}.claims[${i}]`, issues, sourceBasis));
    }
  }
  if ("temporal_hints" in value) {
    const hints = value["temporal_hints"];
    if (!Array.isArray(hints)) {
      issues.push({ path: `${path}.temporal_hints`, message: "temporal_hints must be an array" });
    } else {
      hints.forEach((h, i) => checkTemporalHint(h, `${path}.temporal_hints[${i}]`, issues));
    }
  }

  // message_evidence_coverage presence + evidence consistency (§1.4.5).
  if (sourceBasis === "owner_override") {
    if (!("message_evidence_coverage" in value)) {
      issues.push({
        path: `${path}.message_evidence_coverage`,
        message: "message_evidence_coverage is required on owner packages",
      });
    }
    checkEnum(
      value,
      "message_evidence_coverage",
      path,
      issues,
      isMessageEvidenceCoverage,
      "complete/partial/none",
    );
    // coverage ↔ final-claim evidence consistency (T01 cannot accept
    // "no-evidence claim + complete"). Membership set-check is deferred.
    if (claimsArray !== null) {
      const coverage = value["message_evidence_coverage"];
      if (coverage === "none" && claimsArray.length > 0) {
        issues.push({
          path: `${path}.message_evidence_coverage`,
          message: "coverage=none requires claims to be empty",
        });
      }
      if (coverage === "complete" && !claimsArray.every(hasEvidence)) {
        issues.push({
          path: `${path}.message_evidence_coverage`,
          message: "coverage=complete requires every claim to carry non-empty evidence",
        });
      }
      if (coverage === "partial" && !claimsArray.some(hasEvidence)) {
        issues.push({
          path: `${path}.message_evidence_coverage`,
          message: "coverage=partial requires at least one claim with non-empty evidence",
        });
      }
    }
  } else if (sourceBasis === "model" && "message_evidence_coverage" in value) {
    issues.push({
      path: `${path}.message_evidence_coverage`,
      message: "message_evidence_coverage is only allowed on owner packages",
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: value as unknown as EpisodePayload };
}

// ---------------------------------------------------------------------------
// current-published predicate (§1.3.3a) — PURE, no I/O, no side effects.
// The four cases: all-same → true; source changed → false; effective
// semantics changed → false; pure version upgrade → true (generator/version
// are deliberately NOT compared). The lifecycle that CONSUMES this verdict
// (retirement into history, promotion, carry) is a later ticket.
// ---------------------------------------------------------------------------

export interface ValidPublishedInput {
  publishedPayload: EpisodePayload | null;
  currentSourceHash: string;
  currentEffectiveRealm: Realm;
  currentEffectiveAuId: string | null;
  currentEffectiveDomain: Domain;
}

export function validPublished(input: ValidPublishedInput): boolean {
  const payload = input.publishedPayload;
  if (payload === null) return false;
  const prov = payload.provenance;
  return (
    prov.source_hash === input.currentSourceHash &&
    prov.effective_realm === input.currentEffectiveRealm &&
    prov.effective_au_id === input.currentEffectiveAuId &&
    prov.effective_domain === input.currentEffectiveDomain
  );
}

// ---------------------------------------------------------------------------
// Override events (§1.4.2). T01 validates the record shapes; replay is later.
// ---------------------------------------------------------------------------

function checkFieldTarget(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "target must be an object" });
    return;
  }
  checkShape(value, path, issues, ["episode_id", "span"]);
  if ("episode_id" in value) {
    const id = value["episode_id"];
    if (typeof id !== "string" || !isEpisodeId(id)) {
      issues.push({ path: `${path}.episode_id`, message: "episode_id must match ^ep-[0-9a-f]{32}$" });
    }
  }
  if ("span" in value) {
    const span = value["span"];
    if (!isRecord(span)) {
      issues.push({ path: `${path}.span`, message: "span must be an object" });
    } else {
      checkShape(span, `${path}.span`, issues, [
        "conversation_id",
        "start_message_id",
        "end_message_id",
      ]);
      checkNonEmptyString(span, "conversation_id", `${path}.span`, issues);
      checkNonEmptyString(span, "start_message_id", `${path}.span`, issues);
      checkNonEmptyString(span, "end_message_id", `${path}.span`, issues);
    }
  }
}

/**
 * Common envelope checks. `override_id` must be `ov-` + a canonical ULID;
 * `created_at` must be a strict +08:00 instant; `author` must be a KNOWN
 * author AND one actually enabled in v1 — a reserved-but-not-enabled author
 * (`companion`, D10) is rejected at runtime, distinctly from an unknown author.
 */
function checkEventEnvelope(
  value: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  if ("override_id" in value) {
    const id = value["override_id"];
    if (typeof id !== "string" || !isOverrideId(id)) {
      issues.push({ path: `${path}.override_id`, message: "override_id must be `ov-` + a canonical ULID" });
    }
  }
  checkShanghaiIso(value, "created_at", path, issues);
  if ("author" in value) {
    const author = value["author"];
    if (typeof author !== "string" || !isOverrideAuthor(author)) {
      issues.push({ path: `${path}.author`, message: "author must be a known override author" });
    } else if (!isEnabledOverrideAuthor(author)) {
      issues.push({
        path: `${path}.author`,
        message: `author "${author}" is reserved and not enabled in v1 (only owner)`,
      });
    }
  }
  if ("reason" in value && typeof value["reason"] !== "string") {
    issues.push({ path: `${path}.reason`, message: "reason must be a string" });
  }
}

/**
 * replace_summary — the ONLY summary-edit path (§1.4.5). Enforces the
 * REQUIRED `base.sensitivity_at_write` closed-enum snapshot (closure ruling
 * A): a missing or invalid value is rejected at validation time, before the
 * event is admitted to the append-only true source. There is deliberately
 * NO branch that recovers this value from a projection/payload.
 */
export function validateReplaceSummaryEvent(value: unknown, path = "$"): ValidationResult<unknown> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path, message: "event must be an object" }] };
  }
  checkShape(
    value,
    path,
    issues,
    ["override_id", "created_at", "author", "kind", "op", "target", "replacement", "base"],
    ["reason"],
  );
  checkEventEnvelope(value, path, issues);
  if (value["kind"] !== "field") {
    issues.push({ path: `${path}.kind`, message: 'replace_summary kind must be "field"' });
  }
  if (value["op"] !== "replace_summary") {
    issues.push({ path: `${path}.op`, message: 'op must be "replace_summary"' });
  }
  if ("target" in value) checkFieldTarget(value["target"], `${path}.target`, issues);

  if ("replacement" in value) {
    const r = value["replacement"];
    if (!isRecord(r)) {
      issues.push({ path: `${path}.replacement`, message: "replacement must be an object" });
    } else {
      checkShape(r, `${path}.replacement`, issues, ["summary"], [
        "title",
        "claims",
        "supporting_message_ids",
      ]);
      checkNonEmptyString(r, "summary", `${path}.replacement`, issues);
      if ("title" in r) {
        checkNonEmptyString(r, "title", `${path}.replacement`, issues);
        checkTitleLimit(r, "title", `${path}.replacement`, issues);
      }
      // If present, supporting ids must be a valid non-empty message-id list.
      checkMessageIdArray(r, "supporting_message_ids", `${path}.replacement`, issues);
      if ("claims" in r) {
        const claims = r["claims"];
        if (!Array.isArray(claims)) {
          issues.push({ path: `${path}.replacement.claims`, message: "claims must be an array" });
        } else {
          // Owner claims: kind is OPTIONAL and evidence is OPTIONAL at the
          // event layer — coverage is decided during replay, not here.
          claims.forEach((c, i) =>
            checkClaim(c, `${path}.replacement.claims[${i}]`, issues, "owner_override"),
          );
        }
      }
    }
  }

  if ("base" in value) {
    const base = value["base"];
    if (!isRecord(base)) {
      issues.push({ path: `${path}.base`, message: "base must be an object" });
    } else {
      checkShape(base, `${path}.base`, issues, [
        "index_version",
        "source_hash",
        "sensitivity_at_write",
      ]);
      checkNonEmptyString(base, "index_version", `${path}.base`, issues);
      checkSha256(base, "source_hash", `${path}.base`, issues);
      checkEnum(
        base,
        "sensitivity_at_write",
        `${path}.base`,
        issues,
        isSensitivity,
        "normal/sensitive/intimate",
      );
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value };
}

const SET_FIELD_ALLOWED_KEYS = ["title", "realm", "au_id", "domain", "sensitivity", "status"] as const;

/**
 * set_field (§1.4.2) — index-class fields only. Allowed keys deliberately
 * exclude `summary` (whose only path is replace_summary), `realm_basis`
 * (pure Pass1 evidence), and `continuation_links` (boundary link/unlink):
 * any of those arrives as an unknown field and is rejected. status accepts
 * `closed` only; realm=au requires a paired au_id; title is ≤40 characters.
 */
export function validateSetFieldEvent(value: unknown, path = "$"): ValidationResult<unknown> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path, message: "event must be an object" }] };
  }
  checkShape(
    value,
    path,
    issues,
    ["override_id", "created_at", "author", "kind", "op", "target", "fields", "base"],
    ["reason"],
  );
  checkEventEnvelope(value, path, issues);
  if (value["kind"] !== "field") {
    issues.push({ path: `${path}.kind`, message: 'set_field kind must be "field"' });
  }
  if (value["op"] !== "set_field") {
    issues.push({ path: `${path}.op`, message: 'op must be "set_field"' });
  }
  if ("target" in value) checkFieldTarget(value["target"], `${path}.target`, issues);

  if ("fields" in value) {
    const fields = value["fields"];
    if (!isRecord(fields)) {
      issues.push({ path: `${path}.fields`, message: "fields must be an object" });
    } else {
      checkShape(fields, `${path}.fields`, issues, [], SET_FIELD_ALLOWED_KEYS);
      if ("title" in fields) {
        checkNonEmptyString(fields, "title", `${path}.fields`, issues);
        checkTitleLimit(fields, "title", `${path}.fields`, issues);
      }
      checkEnum(fields, "realm", `${path}.fields`, issues, isRealm, "reality/au/uncertain");
      checkEnum(fields, "domain", `${path}.fields`, issues, isDomain, "the domain enum");
      checkEnum(fields, "sensitivity", `${path}.fields`, issues, isSensitivity, "normal/sensitive/intimate");
      if ("au_id" in fields) checkNonEmptyString(fields, "au_id", `${path}.fields`, issues);
      if ("status" in fields && fields["status"] !== "closed") {
        issues.push({
          path: `${path}.fields.status`,
          message: 'set_field status accepts only "closed"',
        });
      }
      // realm ↔ au_id linkage (§1.4.2).
      const realm = fields["realm"];
      if (realm === "au" && !("au_id" in fields)) {
        issues.push({ path: `${path}.fields.au_id`, message: "realm=au requires a paired au_id" });
      }
      if ((realm === "reality" || realm === "uncertain") && "au_id" in fields) {
        issues.push({
          path: `${path}.fields.au_id`,
          message: "au_id must be absent unless realm is au",
        });
      }
      if ("au_id" in fields && !("realm" in fields)) {
        issues.push({
          path: `${path}.fields.au_id`,
          message: "au_id must not appear without a realm key",
        });
      }
    }
  }

  if ("base" in value) {
    const base = value["base"];
    if (!isRecord(base)) {
      issues.push({ path: `${path}.base`, message: "base must be an object" });
    } else {
      checkShape(base, `${path}.base`, issues, ["index_version", "source_hash"]);
      checkNonEmptyString(base, "index_version", `${path}.base`, issues);
      checkSha256(base, "source_hash", `${path}.base`, issues);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value };
}

const BOUNDARY_OPS = [
  "split_before_message",
  "merge_adjacent",
  "link_continuation",
  "unlink_continuation",
] as const;

/**
 * boundary events (§1.4.2/§1.4.3) — message single-anchor. link_target is
 * required for link_continuation, optional for unlink_continuation, and
 * forbidden (unknown field) for split/merge. base.episode_id_at_write is an
 * audit snapshot but must still be a well-formed episode_id.
 */
export function validateBoundaryEvent(value: unknown, path = "$"): ValidationResult<unknown> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path, message: "event must be an object" }] };
  }
  const op = value["op"];
  const allowsLinkTarget = op === "link_continuation" || op === "unlink_continuation";
  const optional = allowsLinkTarget ? ["reason", "link_target"] : ["reason"];
  checkShape(
    value,
    path,
    issues,
    ["override_id", "created_at", "author", "kind", "op", "anchor", "base"],
    optional,
  );
  checkEventEnvelope(value, path, issues);
  if (value["kind"] !== "boundary") {
    issues.push({ path: `${path}.kind`, message: 'boundary kind must be "boundary"' });
  }
  if (typeof op !== "string" || !(BOUNDARY_OPS as readonly string[]).includes(op)) {
    issues.push({
      path: `${path}.op`,
      message: "op must be split_before_message/merge_adjacent/link_continuation/unlink_continuation",
    });
  }
  if ("anchor" in value) {
    const anchor = value["anchor"];
    if (!isRecord(anchor)) {
      issues.push({ path: `${path}.anchor`, message: "anchor must be an object" });
    } else {
      checkShape(anchor, `${path}.anchor`, issues, ["conversation_id", "message_id"]);
      checkNonEmptyString(anchor, "conversation_id", `${path}.anchor`, issues);
      checkNonEmptyString(anchor, "message_id", `${path}.anchor`, issues);
    }
  }
  if (op === "link_continuation" && !("link_target" in value)) {
    issues.push({ path: `${path}.link_target`, message: "link_continuation requires a link_target" });
  }
  if ("link_target" in value && allowsLinkTarget) {
    const lt = value["link_target"];
    if (!isRecord(lt)) {
      issues.push({ path: `${path}.link_target`, message: "link_target must be an object" });
    } else {
      checkShape(lt, `${path}.link_target`, issues, ["conversation_id", "message_id"]);
      checkNonEmptyString(lt, "conversation_id", `${path}.link_target`, issues);
      checkNonEmptyString(lt, "message_id", `${path}.link_target`, issues);
    }
  }
  if ("base" in value) {
    const base = value["base"];
    if (!isRecord(base)) {
      issues.push({ path: `${path}.base`, message: "base must be an object" });
    } else {
      checkShape(base, `${path}.base`, issues, ["index_version", "episode_id_at_write"]);
      checkNonEmptyString(base, "index_version", `${path}.base`, issues);
      if ("episode_id_at_write" in base) {
        const id = base["episode_id_at_write"];
        if (typeof id !== "string" || !isEpisodeId(id)) {
          issues.push({
            path: `${path}.base.episode_id_at_write`,
            message: "episode_id_at_write must match ^ep-[0-9a-f]{32}$",
          });
        }
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value };
}
