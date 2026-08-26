import { createHash } from "node:crypto";
import type { MemoryCreationEvidence } from "../domain/memory.js";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const SCHEMA_ID = "delos.mnemosyne.card-decision.v1" as const;

export type CurationAction =
  | "KEEP"
  | "REVISE"
  | "RECLASSIFY_AU"
  | "SUPERSEDE"
  | "MERGE"
  | "REVOKE"
  | "EPISODIC_ONLY"
  | "NEEDS_OWNER";

export interface CurationArtifactFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly commitSha: string;
}

export interface CurationEvidenceEntry {
  readonly originalCardSha256: string;
  readonly sourceTurnSha256: string;
  readonly evidence: MemoryCreationEvidence;
}

export interface CurationEvidenceIndex {
  readonly packetSha256: string;
  readonly cards: Readonly<Record<string, CurationEvidenceEntry>>;
}

export interface CurationDecisionSetBundle {
  readonly canonicalHead: string;
  readonly reviewHead: string;
  readonly schemaFile: CurationArtifactFile;
  readonly packetSha256: string;
  readonly decisionFiles: readonly CurationArtifactFile[];
  readonly amendmentFiles: readonly CurationArtifactFile[];
  readonly decisionSetSha256: string;
  readonly evidenceIndex: CurationEvidenceIndex;
}

export interface CurationConsolidationDirection {
  readonly survivor_card_id: string;
  readonly source_card_ids: readonly string[];
}

export interface CurationDecisionAmends {
  readonly decision_commit: string;
  readonly decision_file: string;
  readonly reviewed_at: string;
}

export interface CurationDecisionRow {
  readonly schema: typeof SCHEMA_ID;
  readonly card_id: string;
  readonly original_card_sha256: string;
  readonly source_turn_sha256: string;
  readonly action: CurationAction;
  readonly replacement_title: string | null;
  readonly replacement_body: string | null;
  readonly replacement_scope: "global" | "relationship" | "project" | null;
  readonly replacement_au_id: string | null;
  readonly replacement_tags?: readonly string[] | null;
  readonly replacement_sensitivity?: "normal" | "sensitive" | "intimate" | null;
  readonly replacement_importance?: 1 | 2 | 3 | null;
  readonly supersedes_card_ids: readonly string[];
  readonly merge_card_ids: readonly string[];
  readonly consolidation?: CurationConsolidationDirection;
  readonly reason: string;
  readonly reviewer: string;
  readonly reviewed_at: string;
  readonly amends?: CurationDecisionAmends;
  readonly amendment_reason?: string;
  readonly amended_at?: string;
}

export interface EffectiveCurationDecision {
  readonly decisionId: string;
  readonly decisionSetId: string;
  readonly row: CurationDecisionRow;
  readonly baseFile: Pick<CurationArtifactFile, "path" | "sha256" | "commitSha">;
  readonly amendmentFile: Pick<CurationArtifactFile, "path" | "sha256" | "commitSha"> | null;
  readonly evidence: CurationEvidenceEntry;
}

export interface CurationContractIssue {
  readonly path: string;
  readonly message: string;
}

export type CurationContractPreflight =
  | {
      readonly ok: true;
      readonly value: {
        readonly decisionSetId: string;
        readonly decisionSetSha256: string;
        readonly canonicalHead: string;
        readonly reviewHead: string;
        readonly schemaSha256: string;
        readonly packetSha256: string;
        readonly decisions: readonly EffectiveCurationDecision[];
      };
    }
  | { readonly ok: false; readonly issues: readonly CurationContractIssue[] };

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const entry = input[key];
      if (entry !== undefined) out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function evidenceBasis(evidence: MemoryCreationEvidence): "explicit" | "observed" | null {
  if (evidence.kind === "user_statement") return "explicit";
  if (evidence.kind === "assistant_dialogue") return "observed";
  return null;
}

function validateArtifact(file: CurationArtifactFile, path: string, issues: CurationContractIssue[]): void {
  if (file.path.length === 0 || file.path !== file.path.trim()) {
    issues.push({ path: `${path}.path`, message: "artifact path must be non-empty and trimmed" });
  }
  if (!SHA256_RE.test(file.sha256)) {
    issues.push({ path: `${path}.sha256`, message: "artifact sha256 must be lowercase hex" });
  } else if (sha256Text(file.content) !== file.sha256) {
    issues.push({ path: `${path}.sha256`, message: "artifact bytes do not match declared sha256" });
  }
  if (!COMMIT_RE.test(file.commitSha)) {
    issues.push({ path: `${path}.commitSha`, message: "artifact commit must be a full 40-char sha" });
  }
}

function parseJsonl(file: CurationArtifactFile, path: string, issues: CurationContractIssue[]): Array<{ row: unknown; line: number }> {
  const rows: Array<{ row: unknown; line: number }> = [];
  file.content.split(/\r?\n/u).forEach((line, index) => {
    if (line.trim().length === 0) return;
    try {
      rows.push({ row: JSON.parse(line) as unknown, line: index + 1 });
    } catch {
      issues.push({ path: `${path}:${index + 1}`, message: "invalid JSONL row" });
    }
  });
  return rows;
}

function stringArray(value: unknown, path: string, issues: CurationContractIssue[]): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    issues.push({ path, message: "expected an array of non-empty strings" });
    return [];
  }
  if (new Set(value).size !== value.length) issues.push({ path, message: "array entries must be unique" });
  return value as string[];
}

function parseRow(value: unknown, path: string, expectAmendment: boolean, issues: CurationContractIssue[]): CurationDecisionRow | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "decision row must be an object" });
    return null;
  }
  const allowedActions: readonly string[] = [
    "KEEP",
    "REVISE",
    "RECLASSIFY_AU",
    "SUPERSEDE",
    "MERGE",
    "REVOKE",
    "EPISODIC_ONLY",
    "NEEDS_OWNER",
  ];
  const schema = value.schema;
  const cardId = value.card_id;
  const cardHash = value.original_card_sha256;
  const sourceHash = value.source_turn_sha256;
  const action = value.action;
  if (schema !== SCHEMA_ID) issues.push({ path: `${path}.schema`, message: `schema must be ${SCHEMA_ID}` });
  if (typeof cardId !== "string" || cardId.length === 0) issues.push({ path: `${path}.card_id`, message: "card_id required" });
  if (typeof cardHash !== "string" || !SHA256_RE.test(cardHash)) issues.push({ path: `${path}.original_card_sha256`, message: "original card hash must be lowercase sha256" });
  if (typeof sourceHash !== "string" || !SHA256_RE.test(sourceHash)) issues.push({ path: `${path}.source_turn_sha256`, message: "source-turn hash must be lowercase sha256" });
  if (typeof action !== "string" || !allowedActions.includes(action)) issues.push({ path: `${path}.action`, message: "unsupported curation action" });

  const nullableString = (field: string): string | null => {
    const candidate = value[field];
    if (candidate === null || candidate === undefined) return null;
    if (typeof candidate !== "string") {
      issues.push({ path: `${path}.${field}`, message: "expected string|null" });
      return null;
    }
    return candidate;
  };

  const replacementScope = value.replacement_scope;
  if (replacementScope !== null && replacementScope !== undefined && replacementScope !== "global" && replacementScope !== "relationship" && replacementScope !== "project") issues.push({ path: `${path}.replacement_scope`, message: "replacement scope must be global|relationship|project|null" });
  const replacementTags = value.replacement_tags;
  if (replacementTags !== undefined && replacementTags !== null) stringArray(replacementTags, `${path}.replacement_tags`, issues);
  const replacementSensitivity = value.replacement_sensitivity;
  if (replacementSensitivity !== undefined && replacementSensitivity !== null && replacementSensitivity !== "normal" && replacementSensitivity !== "sensitive" && replacementSensitivity !== "intimate") issues.push({ path: `${path}.replacement_sensitivity`, message: "invalid replacement sensitivity" });
  const replacementImportance = value.replacement_importance;
  if (replacementImportance !== undefined && replacementImportance !== null && replacementImportance !== 1 && replacementImportance !== 2 && replacementImportance !== 3) issues.push({ path: `${path}.replacement_importance`, message: "replacement importance must be 1|2|3|null" });

  const supersedes = stringArray(value.supersedes_card_ids ?? [], `${path}.supersedes_card_ids`, issues);
  const merge = stringArray(value.merge_card_ids ?? [], `${path}.merge_card_ids`, issues);
  const reason = value.reason;
  const reviewer = value.reviewer;
  const reviewedAt = value.reviewed_at;
  if (typeof reason !== "string" || reason.trim().length === 0) issues.push({ path: `${path}.reason`, message: "reason required" });
  if (typeof reviewer !== "string" || reviewer.trim().length === 0) issues.push({ path: `${path}.reviewer`, message: "reviewer required" });
  if (!isIsoTimestamp(reviewedAt)) issues.push({ path: `${path}.reviewed_at`, message: "valid reviewed_at required" });

  let consolidation: CurationConsolidationDirection | undefined;
  if (value.consolidation !== undefined) {
    if (!isRecord(value.consolidation)) issues.push({ path: `${path}.consolidation`, message: "consolidation must be an object" });
    else {
      const survivor = value.consolidation.survivor_card_id;
      const sources = stringArray(value.consolidation.source_card_ids, `${path}.consolidation.source_card_ids`, issues);
      if (typeof survivor !== "string" || survivor.length === 0) issues.push({ path: `${path}.consolidation.survivor_card_id`, message: "survivor_card_id required" });
      else {
        if (sources.includes(survivor)) issues.push({ path: `${path}.consolidation`, message: "survivor cannot also be a source" });
        consolidation = { survivor_card_id: survivor, source_card_ids: sources };
      }
    }
  }

  let amends: CurationDecisionAmends | undefined;
  if (value.amends !== undefined) {
    if (!isRecord(value.amends)) issues.push({ path: `${path}.amends`, message: "amends must be an object" });
    else {
      const decisionCommit = value.amends.decision_commit;
      const decisionFile = value.amends.decision_file;
      const priorReviewedAt = value.amends.reviewed_at;
      if (typeof decisionCommit !== "string" || !COMMIT_RE.test(decisionCommit)) issues.push({ path: `${path}.amends.decision_commit`, message: "full decision commit sha required" });
      if (typeof decisionFile !== "string" || decisionFile.length === 0) issues.push({ path: `${path}.amends.decision_file`, message: "decision_file required" });
      if (!isIsoTimestamp(priorReviewedAt)) issues.push({ path: `${path}.amends.reviewed_at`, message: "prior reviewed_at required" });
      if (typeof decisionCommit === "string" && typeof decisionFile === "string" && typeof priorReviewedAt === "string") amends = { decision_commit: decisionCommit, decision_file: decisionFile, reviewed_at: priorReviewedAt };
    }
  }

  if (expectAmendment) {
    if (amends === undefined) issues.push({ path: `${path}.amends`, message: "amendment must bind an exact prior decision" });
    if (typeof value.amendment_reason !== "string" || value.amendment_reason.trim().length === 0) issues.push({ path: `${path}.amendment_reason`, message: "amendment_reason required" });
    if (!isIsoTimestamp(value.amended_at)) issues.push({ path: `${path}.amended_at`, message: "valid amended_at required" });
  } else if (amends !== undefined) issues.push({ path: `${path}.amends`, message: "historical decision files cannot contain amendment rows" });

  if (action === "REVISE" && (typeof value.replacement_body !== "string" || value.replacement_body.trim().length === 0)) issues.push({ path: `${path}.replacement_body`, message: "REVISE requires a non-empty replacement body" });
  if (action === "REVISE" && value.replacement_au_id !== null && value.replacement_au_id !== undefined) issues.push({ path: `${path}.replacement_au_id`, message: "REVISE cannot invent AU identity; use RECLASSIFY_AU" });
  if (action === "RECLASSIFY_AU" && (typeof value.replacement_au_id !== "string" || value.replacement_au_id.length === 0)) issues.push({ path: `${path}.replacement_au_id`, message: "RECLASSIFY_AU requires an exact AU id" });
  if ((action === "SUPERSEDE" || action === "MERGE") && consolidation === undefined) issues.push({ path: `${path}.consolidation`, message: `${String(action)} requires explicit source/survivor orientation` });
  if (action === "SUPERSEDE" && consolidation !== undefined && consolidation.source_card_ids.length !== 1) issues.push({ path: `${path}.consolidation.source_card_ids`, message: "SUPERSEDE requires exactly one source" });
  if (action === "MERGE" && consolidation !== undefined && consolidation.source_card_ids.length < 1) issues.push({ path: `${path}.consolidation.source_card_ids`, message: "MERGE requires at least one source" });

  if (schema !== SCHEMA_ID || typeof cardId !== "string" || typeof cardHash !== "string" || typeof sourceHash !== "string" || typeof action !== "string" || !allowedActions.includes(action) || typeof reason !== "string" || typeof reviewer !== "string" || typeof reviewedAt !== "string") return null;

  return {
    schema: SCHEMA_ID,
    card_id: cardId,
    original_card_sha256: cardHash,
    source_turn_sha256: sourceHash,
    action: action as CurationAction,
    replacement_title: nullableString("replacement_title"),
    replacement_body: nullableString("replacement_body"),
    replacement_scope: replacementScope === "global" || replacementScope === "relationship" || replacementScope === "project" ? replacementScope : null,
    replacement_au_id: nullableString("replacement_au_id"),
    ...(replacementTags === undefined ? {} : { replacement_tags: replacementTags === null ? null : (replacementTags as string[]) }),
    ...(replacementSensitivity === undefined ? {} : { replacement_sensitivity: replacementSensitivity as CurationDecisionRow["replacement_sensitivity"] }),
    ...(replacementImportance === undefined ? {} : { replacement_importance: replacementImportance as CurationDecisionRow["replacement_importance"] }),
    supersedes_card_ids: supersedes,
    merge_card_ids: merge,
    ...(consolidation === undefined ? {} : { consolidation }),
    reason,
    reviewer,
    reviewed_at: reviewedAt,
    ...(amends === undefined ? {} : { amends }),
    ...(typeof value.amendment_reason === "string" ? { amendment_reason: value.amendment_reason } : {}),
    ...(typeof value.amended_at === "string" ? { amended_at: value.amended_at } : {}),
  };
}

export function curationDecisionSetDigest(bundle: Omit<CurationDecisionSetBundle, "decisionSetSha256">): string {
  const files = [...bundle.decisionFiles, ...bundle.amendmentFiles]
    .map((file) => ({ path: file.path, sha256: file.sha256, commitSha: file.commitSha }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return sha256Canonical({
    schema: "delos.mnemosyne.curation-decision-set.v1",
    reviewHead: bundle.reviewHead,
    schemaFile: { path: bundle.schemaFile.path, sha256: bundle.schemaFile.sha256, commitSha: bundle.schemaFile.commitSha },
    packetSha256: bundle.packetSha256,
    files,
  });
}

export function preflightCurationDecisionSet(bundle: CurationDecisionSetBundle): CurationContractPreflight {
  const issues: CurationContractIssue[] = [];
  if (!COMMIT_RE.test(bundle.canonicalHead)) issues.push({ path: "canonicalHead", message: "canonicalHead must be a full 40-char sha" });
  if (!COMMIT_RE.test(bundle.reviewHead)) issues.push({ path: "reviewHead", message: "reviewHead must be a full 40-char sha" });
  if (!SHA256_RE.test(bundle.packetSha256)) issues.push({ path: "packetSha256", message: "packetSha256 must be lowercase sha256" });
  if (!SHA256_RE.test(bundle.decisionSetSha256)) issues.push({ path: "decisionSetSha256", message: "decisionSetSha256 must be lowercase sha256" });
  if (bundle.evidenceIndex.packetSha256 !== bundle.packetSha256) issues.push({ path: "evidenceIndex.packetSha256", message: "evidence packet identity mismatch" });

  validateArtifact(bundle.schemaFile, "schemaFile", issues);
  bundle.decisionFiles.forEach((file, index) => validateArtifact(file, `decisionFiles[${index}]`, issues));
  bundle.amendmentFiles.forEach((file, index) => validateArtifact(file, `amendmentFiles[${index}]`, issues));

  const seenPaths = new Set<string>();
  for (const file of [bundle.schemaFile, ...bundle.decisionFiles, ...bundle.amendmentFiles]) {
    if (seenPaths.has(file.path)) issues.push({ path: file.path, message: "duplicate artifact path" });
    seenPaths.add(file.path);
  }

  const expectedSetDigest = curationDecisionSetDigest({
    canonicalHead: bundle.canonicalHead,
    reviewHead: bundle.reviewHead,
    schemaFile: bundle.schemaFile,
    packetSha256: bundle.packetSha256,
    decisionFiles: bundle.decisionFiles,
    amendmentFiles: bundle.amendmentFiles,
    evidenceIndex: bundle.evidenceIndex,
  });
  if (expectedSetDigest !== bundle.decisionSetSha256) issues.push({ path: "decisionSetSha256", message: "decision-set digest does not match frozen artifacts" });

  const baseRows = new Map<string, { row: CurationDecisionRow; file: CurationArtifactFile }>();
  for (const file of bundle.decisionFiles) {
    for (const parsed of parseJsonl(file, file.path, issues)) {
      const row = parseRow(parsed.row, `${file.path}:${parsed.line}`, false, issues);
      if (row === null) continue;
      if (baseRows.has(row.card_id)) issues.push({ path: `${file.path}:${parsed.line}.card_id`, message: "duplicate reviewed card identity" });
      else baseRows.set(row.card_id, { row, file });
    }
  }

  const amendments = new Map<string, Array<{ row: CurationDecisionRow; file: CurationArtifactFile }>>();
  for (const file of bundle.amendmentFiles) {
    for (const parsed of parseJsonl(file, file.path, issues)) {
      const row = parseRow(parsed.row, `${file.path}:${parsed.line}`, true, issues);
      if (row === null) continue;
      const base = baseRows.get(row.card_id);
      if (base === undefined) {
        issues.push({ path: `${file.path}:${parsed.line}.card_id`, message: "amendment references no reviewed base row" });
        continue;
      }
      if (row.original_card_sha256 !== base.row.original_card_sha256 || row.source_turn_sha256 !== base.row.source_turn_sha256 || row.action !== base.row.action) issues.push({ path: `${file.path}:${parsed.line}`, message: "amendment changes immutable evidence/action identity" });
      if (row.amends === undefined || row.amends.decision_file !== base.file.path || row.amends.decision_commit !== base.file.commitSha || row.amends.reviewed_at !== base.row.reviewed_at) issues.push({ path: `${file.path}:${parsed.line}.amends`, message: "amendment does not bind the exact historical decision" });
      const list = amendments.get(row.card_id) ?? [];
      list.push({ row, file });
      amendments.set(row.card_id, list);
    }
  }

  const effective: EffectiveCurationDecision[] = [];
  const participantOwners = new Map<string, string>();
  for (const [cardId, base] of baseRows) {
    let chosenRow = base.row;
    let chosenFile: CurationArtifactFile | null = null;
    const candidates = amendments.get(cardId) ?? [];
    if (candidates.length > 0) {
      const ordered = candidates.map((candidate) => ({ ...candidate, amendedAt: candidate.row.amended_at ?? "" })).sort((a, b) => a.amendedAt.localeCompare(b.amendedAt));
      const newest = ordered.at(-1)!;
      const previous = ordered.at(-2);
      if (previous !== undefined && previous.amendedAt === newest.amendedAt) issues.push({ path: `amendments.${cardId}`, message: "newest amendment is ambiguous" });
      chosenRow = newest.row;
      chosenFile = newest.file;
    }

    const evidence = bundle.evidenceIndex.cards[cardId];
    if (evidence === undefined) {
      issues.push({ path: `evidenceIndex.cards.${cardId}`, message: "missing evidence entry for reviewed card" });
      continue;
    }
    if (evidence.originalCardSha256 !== chosenRow.original_card_sha256) issues.push({ path: `evidenceIndex.cards.${cardId}.originalCardSha256`, message: "original-card hash mismatch" });
    if (evidence.sourceTurnSha256 !== chosenRow.source_turn_sha256) issues.push({ path: `evidenceIndex.cards.${cardId}.sourceTurnSha256`, message: "source-turn hash mismatch" });
    if (evidenceBasis(evidence.evidence) === null) issues.push({ path: `evidenceIndex.cards.${cardId}.evidence`, message: "curation evidence must resolve to explicit|observed" });
    if (chosenRow.action === "NEEDS_OWNER") issues.push({ path: `decisions.${cardId}.action`, message: "NEEDS_OWNER is a preflight blocker and cannot be applied" });

    const participants = chosenRow.action === "SUPERSEDE" || chosenRow.action === "MERGE"
      ? [...(chosenRow.consolidation?.source_card_ids ?? []), ...(chosenRow.consolidation === undefined ? [] : [chosenRow.consolidation.survivor_card_id])]
      : [cardId];
    for (const participant of participants) {
      const owner = participantOwners.get(participant);
      if (owner !== undefined && owner !== cardId) issues.push({ path: `decisions.${cardId}`, message: `card ${participant} participates in conflicting decisions` });
      else participantOwners.set(participant, cardId);
    }

    const decisionId = sha256Canonical({
      schema: "delos.mnemosyne.curation-decision-identity.v1",
      decisionSetSha256: bundle.decisionSetSha256,
      baseFile: { path: base.file.path, sha256: base.file.sha256, commitSha: base.file.commitSha },
      amendmentFile: chosenFile === null ? null : { path: chosenFile.path, sha256: chosenFile.sha256, commitSha: chosenFile.commitSha },
      row: chosenRow,
    });
    effective.push({
      decisionId,
      decisionSetId: bundle.decisionSetSha256,
      row: chosenRow,
      baseFile: { path: base.file.path, sha256: base.file.sha256, commitSha: base.file.commitSha },
      amendmentFile: chosenFile === null ? null : { path: chosenFile.path, sha256: chosenFile.sha256, commitSha: chosenFile.commitSha },
      evidence,
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  effective.sort((a, b) => a.row.card_id.localeCompare(b.row.card_id));
  return {
    ok: true,
    value: {
      decisionSetId: bundle.decisionSetSha256,
      decisionSetSha256: bundle.decisionSetSha256,
      canonicalHead: bundle.canonicalHead,
      reviewHead: bundle.reviewHead,
      schemaSha256: bundle.schemaFile.sha256,
      packetSha256: bundle.packetSha256,
      decisions: effective,
    },
  };
}
