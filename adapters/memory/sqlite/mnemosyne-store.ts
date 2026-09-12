/**
 * Mnemosyne store: governance/prior event streams plus fold-derived
 * projections over the SQLite canonical container.
 *
 * memory_items, memory_tags, priors_current, fts_items and memory-subject
 * sources rows are ALL rebuildable from the two event streams; rebuild is
 * transactional delete-and-refold. The FTS index stores text pre-segmented
 * with Intl.Segmenter so two-character Chinese terms, English terms, and
 * mixed queries all match (Companion acceptance #2 — trigram alone was
 * rejected for exactly this reason).
 */

import { createHash, randomUUID } from "node:crypto";
import { foldMemoryEvents } from "../../../core/domain/memory-fold.js";
import type { MemoryEventEnvelope, MemoryEvidence } from "../../../core/domain/memory.js";
import { validateMemoryEventStream } from "../../../core/domain/memory-validation.js";
import {
  foldMnemosyneEvents,
  validateMnemosyneStream,
  type MnemosyneEnvelope,
  type MnemosyneIssue,
  type MnemosyneItemOverlay,
} from "../../../core/domain/mnemosyne.js";
import { segmentForSearch } from "../../../core/services/segmentation.js";
import type { SqliteMemoryEventLog } from "./sqlite-memory-event-log.js";

const PROJECTION_WATERMARK_KEY = "mnemosyne_projection_event_seq_v1";

/** Provenance pointer derived from kernel evidence (pointers, not copies). */
export function evidencePointer(evidence: MemoryEvidence): { kind: string; pointer: string } {
  switch (evidence.kind) {
    case "user_statement":
    case "user_confirmation": {
      const source = evidence.source;
      if (source.kind === "manual_entry") {
        return { kind: "manual", pointer: `manual/${source.manualEntryId}` };
      }
      return {
        kind: "transcript",
        pointer: `conversation/${source.conversationId}#${source.turnId}/${source.messageId}`,
      };
    }
    case "assistant_dialogue":
      return {
        kind: "transcript",
        pointer: `conversation/${evidence.source.conversationId}#${evidence.source.turnId}/${evidence.source.messageId}`,
      };
    case "imported":
      return {
        kind: "import",
        pointer: `import/${evidence.source.importId}#${evidence.source.recordLocator}`,
      };
    case "model_inference": {
      const first = evidence.derivedFrom?.[0];
      return {
        kind: "inference",
        pointer:
          first !== undefined
            ? `conversation/${first.conversationId}#${first.turnId}/${first.messageId}`
            : `inference/${evidence.origin.modelFamily}`,
      };
    }
  }
}

/** Stable SQLite subject id for every governance event, including set-level receipts. */
function governanceSubjectId(event: MnemosyneEnvelope["event"]): string {
  if (event.type === "prior_proposed" || event.type === "prior_approved") {
    return event.key;
  }
  if (event.type === "owner_policy_set") {
    return event.policyId;
  }
  if (event.type === "curation_batch_recorded") {
    return `decision-set:${event.decisionSetId}`;
  }
  return event.memoryId;
}

export interface MemoryItemRow {
  id: string;
  title: string;
  body: string;
  scope: string;
  au_id: string | null;
  sensitivity: string;
  importance: number;
  approval_state: string;
  lifecycle_state: string;
  seal_state: string;
  confirmed_by: string | null;
  retrieval: string;
  /** Derived read metadata; absent from the materialized table itself. */
  retrieval_explicit?: number;
  supersedes: string | null;
  source_basis: string | null;
  tags_text: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  /** Workflow provenance roles JSON (v2 column); NULL = legacy/unknown. */
  provenance: string | null;
}

export interface FragmentRow {
  id: string;
  body: string;
  created_at: string;
  expires_at: string;
  source_id: string | null;
}

export type GovernanceAppendOutcome =
  | { status: "appended"; count: number }
  | { status: "rejected"; issues: MnemosyneIssue[] };

export interface ProjectionFreshness {
  fresh: boolean;
  authoritativeSeq: number;
  projectedSeq: number | null;
}

export class MnemosyneStore {
  constructor(private readonly log: SqliteMemoryEventLog) {}

  private get db() {
    return this.log.db;
  }

  private authoritativeEventSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_events").get() as {
      seq: number;
    };
    return row.seq;
  }

  private projectedEventSeq(): number | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(PROJECTION_WATERMARK_KEY) as
      | { value: string }
      | undefined;
    if (row === undefined || !/^\d+$/u.test(row.value)) {
      return null;
    }
    const parsed = Number(row.value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  projectionFreshness(): ProjectionFreshness {
    const authoritativeSeq = this.authoritativeEventSeq();
    const projectedSeq = this.projectedEventSeq();
    return {
      // A brand-new container has no authoritative events and therefore no
      // event-derived rows that could be stale. Once any event exists, a
      // missing watermark is never accepted as proof of freshness.
      fresh:
        projectedSeq === authoritativeSeq ||
        (authoritativeSeq === 0 && projectedSeq === null),
      authoritativeSeq,
      projectedSeq,
    };
  }

  private assertProjectionFresh(): void {
    const freshness = this.projectionFreshness();
    if (!freshness.fresh) {
      throw new Error(
        "mnemosyne projection is stale; derived memory reads are paused until event-truth recovery completes " +
          `(events=${freshness.authoritativeSeq}, projection=${freshness.projectedSeq ?? "missing"})`,
      );
    }
  }

  /**
   * Restart recovery for a crash after authoritative event commit but before
   * projection materialization. `memory_events` remains the only truth; the
   * watermark merely proves which exact event prefix the disposable projection
   * represents.
   */
  recoverProjectionIfNeeded(): { recovered: boolean; freshness: ProjectionFreshness } {
    const before = this.projectionFreshness();
    if (before.fresh) {
      return { recovered: false, freshness: before };
    }
    this.rebuildProjectionsNow();
    const after = this.projectionFreshness();
    if (!after.fresh) {
      throw new Error(
        "mnemosyne projection recovery did not reach authoritative event truth " +
          `(events=${after.authoritativeSeq}, projection=${after.projectedSeq ?? "missing"})`,
      );
    }
    return { recovered: true, freshness: after };
  }

  // --------------------------------------------------------------- events
  readGovernance(): MnemosyneEnvelope[] {
    const rows = this.db
      .prepare(
        "SELECT payload FROM memory_events WHERE subject_kind IN ('governance','prior') ORDER BY seq",
      )
      .all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as MnemosyneEnvelope);
  }

  appendGovernance(envelopes: readonly MnemosyneEnvelope[]): GovernanceAppendOutcome {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = [...this.readGovernance(), ...envelopes];
      const result = validateMnemosyneStream(candidate);
      if (!result.ok) {
        this.db.exec("ROLLBACK");
        return { status: "rejected", issues: result.issues };
      }
      const insert = this.db.prepare(
        "INSERT INTO memory_events (event_id, subject_kind, subject_id, type, payload, occurred_at, actor) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const envelope of result.value.slice(result.value.length - envelopes.length)) {
        const event = envelope.event;
        const isPrior = event.type === "prior_proposed" || event.type === "prior_approved";
        insert.run(
          envelope.eventId,
          isPrior ? "prior" : "governance",
          governanceSubjectId(event),
          event.type,
          JSON.stringify(envelope),
          envelope.occurredAt,
          envelope.actor,
        );
      }
      this.db.exec("COMMIT");
      return { status: "appended", count: envelopes.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Governance-channel write: kernel and governance envelopes land in ONE
   * SQLite transaction, so a crash can never leave a card created without
   * its attributes or a revision without its re-confirmation. Both streams
   * are validated against their full existing history first (same
   * validators the individual append paths use).
   */
  appendJoint(
    kernel: readonly MemoryEventEnvelope[],
    governance: readonly MnemosyneEnvelope[],
  ):
    | { status: "appended"; kernel: number; governance: number }
    | { status: "rejected"; issues: Array<{ path: string; message: string }> } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const kernelExisting = this.db
        .prepare("SELECT payload FROM memory_events WHERE subject_kind = 'memory' ORDER BY seq")
        .all() as Array<{ payload: string }>;
      const kernelStream = [
        ...kernelExisting.map((row) => JSON.parse(row.payload) as MemoryEventEnvelope),
        ...kernel,
      ];
      const kernelResult = validateMemoryEventStream(kernelStream);
      if (!kernelResult.ok) {
        this.db.exec("ROLLBACK");
        return { status: "rejected", issues: kernelResult.issues };
      }
      const governanceResult = validateMnemosyneStream([...this.readGovernance(), ...governance]);
      if (!governanceResult.ok) {
        this.db.exec("ROLLBACK");
        return { status: "rejected", issues: governanceResult.issues };
      }
      const insert = this.db.prepare(
        "INSERT INTO memory_events (event_id, subject_kind, subject_id, type, payload, occurred_at, actor) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const envelope of kernelResult.value.slice(kernelExisting.length)) {
        insert.run(
          envelope.eventId,
          "memory",
          envelope.event.memoryId,
          envelope.event.type,
          JSON.stringify(envelope),
          envelope.occurredAt,
          "system",
        );
      }
      for (const envelope of governanceResult.value.slice(
        governanceResult.value.length - governance.length,
      )) {
        const event = envelope.event;
        const isPrior = event.type === "prior_proposed" || event.type === "prior_approved";
        insert.run(
          envelope.eventId,
          isPrior ? "prior" : "governance",
          governanceSubjectId(event),
          event.type,
          JSON.stringify(envelope),
          envelope.occurredAt,
          envelope.actor,
        );
      }
      this.db.exec("COMMIT");
      return { status: "appended", kernel: kernel.length, governance: governance.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------------------------------------------------------- projections
  private readKernelEventsSync(): MemoryEventEnvelope[] {
    const rows = this.db
      .prepare("SELECT payload FROM memory_events WHERE subject_kind = 'memory' ORDER BY seq")
      .all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as MemoryEventEnvelope);
  }

  /**
   * Transactional delete-and-refold of every derived table. The write lock is
   * acquired BEFORE reading event truth so the fold and watermark describe the
   * same exact immutable prefix even if another process can write this SQLite
   * file.
   */
  private rebuildProjectionsNow(): { items: number; priors: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const kernel = foldMemoryEvents(this.readKernelEventsSync());
      const governance = foldMnemosyneEvents(this.readGovernance());

      this.db.exec("DELETE FROM memory_items");
      this.db.exec("DELETE FROM memory_tags");
      this.db.exec("DELETE FROM priors_current");
      this.db.exec("DELETE FROM fts_items");
      this.db.exec("DELETE FROM sources WHERE subject_kind = 'memory'");

      const insertItem = this.db.prepare(
        "INSERT INTO memory_items (id, title, body, scope, au_id, sensitivity, importance, " +
          "approval_state, lifecycle_state, seal_state, confirmed_by, retrieval, supersedes, " +
          "source_basis, tags_text, created_at, updated_at, expires_at, provenance) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertTag = this.db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)");
      const insertFts = this.db.prepare(
        "INSERT INTO fts_items (item_id, title_seg, body_seg, tags_seg) VALUES (?, ?, ?, ?)",
      );
      const insertSource = this.db.prepare(
        "INSERT INTO sources (id, subject_kind, subject_id, kind, pointer, note) VALUES (?, 'memory', ?, ?, ?, NULL)",
      );

      for (const record of kernel.records) {
        const overlay: MnemosyneItemOverlay =
          governance.overlays.get(record.memoryId) ?? {
            title: null,
            tags: [],
            scope: "global",
            auId: null,
            sensitivity: "normal",
            importance: 1,
            sourceBasis: null,
            approvalState: "candidate",
            confirmedBy: null,
            sealState: "unsealed",
            expiresAt: null,
            retrievalOverride: null,
            provenance: null,
            activation: null,
          };
        const lifecycle =
          record.lifecycle === "active"
            ? "active"
            : record.lifecycle === "superseded"
              ? "superseded"
              : "revoked";
        // Sensitivity is a provider-visible classification, not a retrieval
        // gate. Only an explicit governance override may disable a card.
        const retrieval = overlay.retrievalOverride === false ? "disabled" : "enabled";
        const title = overlay.title ?? record.content.slice(0, 60);
        const firstEnvelope = record.history[0];
        const lastEnvelope = record.history[record.history.length - 1];
        insertItem.run(
          record.memoryId,
          title,
          record.content,
          overlay.scope,
          overlay.auId,
          overlay.sensitivity,
          overlay.importance,
          overlay.approvalState,
          lifecycle,
          overlay.sealState,
          overlay.confirmedBy,
          retrieval,
          // holds supersededByMemoryId (the record that replaced this one)
          record.supersededByMemoryId ?? null,
          // D0 §5.4 honest trust label: for a policy-activated card the
          // ACTIVATION basis is the truth (an activation may classify an
          // older draft as observed; the label must never overstate).
          overlay.approvalState === "policy_activated" && overlay.activation !== null
            ? overlay.activation.sourceBasis
            : overlay.sourceBasis,
          overlay.tags.join(" "),
          firstEnvelope?.occurredAt ?? "",
          lastEnvelope?.occurredAt ?? "",
          overlay.expiresAt,
          overlay.provenance !== null ? JSON.stringify(overlay.provenance) : null,
        );
        for (const tag of overlay.tags) {
          insertTag.run(record.memoryId, tag);
        }
        insertFts.run(
          record.memoryId,
          segmentForSearch(title),
          segmentForSearch(record.content),
          segmentForSearch(overlay.tags.join(" ")),
        );
        const pointer = evidencePointer(record.evidence);
        insertSource.run(randomUUID(), record.memoryId, pointer.kind, pointer.pointer);
      }

      const insertPrior = this.db.prepare(
        "INSERT INTO priors_current (key, version, body, token_est, approved_by, changelog, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const prior of governance.priors.values()) {
        insertPrior.run(
          prior.key,
          prior.version,
          prior.body,
          prior.tokenEst,
          prior.approvedBy,
          prior.changelog,
          prior.expiresAt,
        );
      }

      const authoritativeSeq = this.authoritativeEventSeq();
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(PROJECTION_WATERMARK_KEY, String(authoritativeSeq));

      this.db.exec("COMMIT");
      return { items: kernel.records.length, priors: governance.priors.size };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async rebuildProjections(): Promise<{ items: number; priors: number }> {
    return this.rebuildProjectionsNow();
  }

  // ------------------------------------------------------------- queries
  ftsSearch(query: string, limit: number): Array<{ itemId: string; rank: number }> {
    this.assertProjectionFresh();
    const segmented = segmentForSearch(query);
    if (segmented.length === 0) {
      return [];
    }
    const match = segmented
      .split(" ")
      .map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(" OR ");
    const rows = this.db
      .prepare(
        "SELECT item_id AS itemId, bm25(fts_items) AS rank FROM fts_items WHERE fts_items MATCH ? " +
          "ORDER BY rank LIMIT ?",
      )
      .all(match, limit) as Array<{ itemId: string; rank: number }>;
    return rows;
  }

  getItem(id: string): MemoryItemRow | undefined {
    this.assertProjectionFresh();
    return this.db
      .prepare(
        "SELECT mi.*, EXISTS(" +
          "SELECT 1 FROM memory_events e WHERE e.subject_kind = 'governance' " +
          "AND e.subject_id = mi.id AND e.type = 'retrieval_set'" +
          ") AS retrieval_explicit FROM memory_items mi WHERE mi.id = ?",
      )
      .get(id) as
      | MemoryItemRow
      | undefined;
  }

  listItems(): MemoryItemRow[] {
    this.assertProjectionFresh();
    return this.db
      .prepare("SELECT * FROM memory_items ORDER BY created_at")
      .all() as unknown as MemoryItemRow[];
  }

  listPriors(): Array<{
    key: string;
    version: number;
    body: string;
    token_est: number;
    approved_by: string;
    changelog: string;
    expires_at: string | null;
  }> {
    this.assertProjectionFresh();
    return this.db.prepare("SELECT * FROM priors_current ORDER BY key").all() as Array<{
      key: string;
      version: number;
      body: string;
      token_est: number;
      approved_by: string;
      changelog: string;
      expires_at: string | null;
    }>;
  }

  // ------------------------------------- frozen-context verification (3P)

  /**
   * Newest kernel event anchor for a card + the content hash at that
   * anchor. Captured at DraftContext snapshot time so the asynchronous
   * pass can later verify it reviews the exact historical version.
   */
  latestCardAnchor(memoryId: string): { eventId: string; contentSha256: string } | null {
    const row = this.db
      .prepare(
        "SELECT event_id FROM memory_events WHERE subject_kind = 'memory' AND subject_id = ? " +
          "ORDER BY seq DESC LIMIT 1",
      )
      .get(memoryId) as { event_id: string } | undefined;
    if (row === undefined) {
      return null;
    }
    const sha = this.historicalCardSha(memoryId, row.event_id);
    return sha === null ? null : { eventId: row.event_id, contentSha256: sha };
  }

  /**
   * Reconstruct the card content as of the anchor event, from event
   * history ONLY (never the current projection), and return its sha256.
   * null when the memory or anchor is unknown — callers must treat that
   * as an integrity failure, not fall back to live state.
   */
  historicalCardSha(memoryId: string, anchorEventId: string): string | null {
    const anchor = this.db
      .prepare("SELECT seq FROM memory_events WHERE event_id = ? AND subject_kind = 'memory'")
      .get(anchorEventId) as { seq: number } | undefined;
    if (anchor === undefined) {
      return null;
    }
    const rows = this.db
      .prepare(
        "SELECT payload FROM memory_events WHERE subject_kind = 'memory' AND subject_id = ? " +
          "AND seq <= ? ORDER BY seq",
      )
      .all(memoryId, anchor.seq) as Array<{ payload: string }>;
    let content: string | null = null;
    for (const row of rows) {
      const envelope = JSON.parse(row.payload) as {
        event: { type: string; content?: string };
      };
      if (
        (envelope.event.type === "memory_created" || envelope.event.type === "memory_revised") &&
        typeof envelope.event.content === "string"
      ) {
        content = envelope.event.content;
      }
    }
    if (content === null) {
      return null;
    }
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  /** Current durable owner policies (D0), fold-derived from events. */
  currentPolicies(): Map<string, import("../../../core/domain/mnemosyne.js").OwnerPolicyCurrent> {
    return foldMnemosyneEvents(this.readGovernance()).policies;
  }

  /** True when this prior key ever reached the given approved version. */
  priorVersionKnown(key: string, version: number): boolean {
    const row = this.db
      .prepare(
        "SELECT count(*) AS c FROM memory_events WHERE subject_kind = 'prior' AND subject_id = ? " +
          "AND type = 'prior_approved'",
      )
      .get(key) as { c: number };
    return version >= 1 && version <= row.c;
  }

  // ------------------------------------------------- fragments & sources
  addFragment(fragment: FragmentRow): void {
    this.db
      .prepare(
        "INSERT INTO fragments (id, body, created_at, expires_at, source_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(fragment.id, fragment.body, fragment.created_at, fragment.expires_at, fragment.source_id);
  }

  /** Active (unexpired) fragments at the given instant. */
  listFragments(nowIso: string): FragmentRow[] {
    this.assertProjectionFresh();
    return this.db
      .prepare("SELECT * FROM fragments WHERE expires_at > ? ORDER BY created_at")
      .all(nowIso) as unknown as FragmentRow[];
  }

  addSource(source: {
    id: string;
    subjectKind: "memory" | "prior" | "fragment";
    subjectId: string;
    kind: string;
    pointer: string;
    note?: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO sources (id, subject_kind, subject_id, kind, pointer, note) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(source.id, source.subjectKind, source.subjectId, source.kind, source.pointer, source.note ?? null);
  }

  listSources(subjectKind: string, subjectId: string): Array<{ kind: string; pointer: string }> {
    this.assertProjectionFresh();
    return this.db
      .prepare("SELECT kind, pointer FROM sources WHERE subject_kind = ? AND subject_id = ?")
      .all(subjectKind, subjectId) as Array<{ kind: string; pointer: string }>;
  }
}
