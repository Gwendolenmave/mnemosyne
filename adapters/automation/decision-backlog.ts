/**
 * Durable decision backlog: every completed
 * user-originated turn reaches exactly one durable decision state, and a
 * full presentation tray can only DEFER model work — it can never discard
 * the source receipt. Pointers and hashes only; raw transcript text is
 * structurally absent (nothing here accepts a text field).
 *
 * Storage: a dedicated SQLite file next to the memory container (its own
 * migration ledger). Keeping it OUT of delos-memory.db means the live
 * memory schema is untouched and a code rollback simply ignores
 * this file — no schema-too-new refusal on the memory container.
 *
 * Consistency model: the projection row (backlog_items) is compactable
 * state; backlog_receipts is the append-only decision history. Enqueue is
 * idempotent on a stable identity derived from (conversation, turn,
 * content hash, policy version). Crash recovery re-defers 'processing'
 * rows; exactly-once CARD creation is guaranteed downstream by the
 * per-turn dedup in the sink/service, so a re-run can never mint twice.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const BACKLOG_STATES = [
  "deferred",
  "deferred_oversize",
  "processing",
  "declined",
  "duplicate",
  "policy_activated",
  "quarantined",
  "failed_retryable",
  "failed_terminal",
] as const;
export type BacklogState = (typeof BACKLOG_STATES)[number];

export const TERMINAL_STATES: readonly BacklogState[] = [
  "declined",
  "duplicate",
  "policy_activated",
  "quarantined",
  "failed_terminal",
];

export type BacklogOrigin = "live" | "backfill";

export interface FrozenCardRefRecord {
  id: string;
  anchor_event_id: string;
  content_sha256: string;
}

export interface BacklogEnqueueInput {
  conversationId: string;
  turnId: string;
  userMessageId: string | null;
  /** FULL sha256 hex over the frozen turn texts. */
  contentSha256: string;
  variantSha256: string | null;
  sceneMode: "ordinary" | "au" | "unknown";
  sceneAuId: string | null;
  origin: BacklogOrigin;
  policyVersion: string;
  /** Frozen card refs served at the source turn (ids + hashes only). */
  selectedRefs: FrozenCardRefRecord[];
  priorVersions: Record<string, number>;
  /** Source-turn instant (ISO) when known; ordering key for backfill. */
  sourceTime: string | null;
}

export interface BacklogItemRow {
  identity: string;
  conversation_id: string;
  turn_id: string;
  user_message_id: string | null;
  content_sha256: string;
  variant_sha256: string | null;
  scene_mode: string;
  scene_au_id: string | null;
  origin: string;
  policy_version: string;
  state: string;
  attempts: number;
  queued_at: string;
  source_time: string | null;
  next_attempt_at: string | null;
  decided_at: string | null;
  memory_id: string | null;
  detail: string | null;
  selected_refs: string;
  prior_versions: string;
  updated_at: string;
}

export interface BacklogCounters {
  source_receipts_total: number;
  deferred_total: number;
  processing_total: number;
  declined_total: number;
  duplicate_total: number;
  policy_activated_total: number;
  quarantined_total: number;
  retryable_failed_total: number;
  terminal_failed_total: number;
  /** Parked for T05D chunk-and-assemble; durable, out of rotation. */
  oversize_deferred_total: number;
  oldest_deferred_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
}

/** Stable decision identity (§4.1): conversation, turn, content, policy. */
export function backlogIdentity(
  conversationId: string,
  turnId: string,
  contentSha256: string,
  policyVersion: string,
): string {
  return createHash("sha256")
    .update(`${conversationId}\n${turnId}\n${contentSha256}\n${policyVersion}`, "utf8")
    .digest("hex");
}

export const BACKLOG_MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE backlog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE backlog_items (
  identity        TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  user_message_id TEXT,
  content_sha256  TEXT NOT NULL,
  variant_sha256  TEXT,
  scene_mode      TEXT NOT NULL CHECK (scene_mode IN ('ordinary','au','unknown')),
  scene_au_id     TEXT,
  origin          TEXT NOT NULL CHECK (origin IN ('live','backfill')),
  policy_version  TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('deferred','processing','declined','duplicate','policy_activated','quarantined','failed_retryable','failed_terminal')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  queued_at       TEXT NOT NULL,
  source_time     TEXT,
  next_attempt_at TEXT,
  decided_at      TEXT,
  memory_id       TEXT,
  detail          TEXT,
  selected_refs   TEXT NOT NULL DEFAULT '[]',
  prior_versions  TEXT NOT NULL DEFAULT '{}',
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_backlog_state ON backlog_items(state, origin, queued_at);
CREATE INDEX idx_backlog_turn ON backlog_items(turn_id);

CREATE TABLE backlog_receipts (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  identity   TEXT NOT NULL,
  at         TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX idx_receipts_identity ON backlog_receipts(identity);

CREATE TABLE provider_ledger (
  call_id      TEXT PRIMARY KEY,
  identity     TEXT NOT NULL,
  reserved_at  TEXT NOT NULL,
  settled_at   TEXT,
  outcome      TEXT,
  served_model TEXT
);
CREATE INDEX idx_ledger_identity ON provider_ledger(identity);
CREATE INDEX idx_ledger_reserved ON provider_ledger(reserved_at);
`,
  },
  {
    // v2 (continuous-completion ruling): 'deferred_oversize' parks
    // sources that exceed the verified prompt budget OUT of the claim
    // pool — durable, visible, never lost, never re-claimed each tick
    // (the v1 shape livelocked: deferOversize returned the row to
    // 'deferred', where claimNext would immediately re-claim it and the
    // queue could never advance past the first oversize source).
    // SQLite cannot alter a CHECK constraint, so the table is recreated
    // in place with rows and indexes preserved.
    version: 2,
    sql: `
CREATE TABLE backlog_items_v2 (
  identity        TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  user_message_id TEXT,
  content_sha256  TEXT NOT NULL,
  variant_sha256  TEXT,
  scene_mode      TEXT NOT NULL CHECK (scene_mode IN ('ordinary','au','unknown')),
  scene_au_id     TEXT,
  origin          TEXT NOT NULL CHECK (origin IN ('live','backfill')),
  policy_version  TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('deferred','deferred_oversize','processing','declined','duplicate','policy_activated','quarantined','failed_retryable','failed_terminal')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  queued_at       TEXT NOT NULL,
  source_time     TEXT,
  next_attempt_at TEXT,
  decided_at      TEXT,
  memory_id       TEXT,
  detail          TEXT,
  selected_refs   TEXT NOT NULL DEFAULT '[]',
  prior_versions  TEXT NOT NULL DEFAULT '{}',
  updated_at      TEXT NOT NULL
);
INSERT INTO backlog_items_v2 SELECT * FROM backlog_items;
DROP TABLE backlog_items;
ALTER TABLE backlog_items_v2 RENAME TO backlog_items;
CREATE INDEX idx_backlog_state ON backlog_items(state, origin, queued_at);
CREATE INDEX idx_backlog_turn ON backlog_items(turn_id);
`,
  },
];

const DETAIL_MAX = 200;

function clipDetail(detail: string | undefined): string | null {
  if (detail === undefined) {
    return null;
  }
  return detail.slice(0, DETAIL_MAX);
}

export class DecisionBacklog {
  readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly migrations: ReadonlyArray<{ version: number; sql: string }>;

  constructor(
    path: string,
    options?: { now?: () => Date; migrations?: ReadonlyArray<{ version: number; sql: string }> },
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.now = options?.now ?? (() => new Date());
    this.migrations = options?.migrations ?? BACKLOG_MIGRATIONS;
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode=WAL");
      const integ = this.db.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      if (integ.integrity_check !== "ok") {
        throw new Error(
          `decision backlog failed its integrity check (${integ.integrity_check}); ` +
            "the decision worker stays off, chat is unaffected",
        );
      }
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migration_ledger (" +
        "version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(
      (this.db.prepare("SELECT version FROM migration_ledger").all() as Array<{ version: number }>).map(
        (row) => row.version,
      ),
    );
    const newest = Math.max(0, ...applied);
    const supported = Math.max(...this.migrations.map((m) => m.version));
    if (newest > supported) {
      throw new Error(
        `decision backlog is from a newer Delos (schema v${newest} > v${supported}); ` +
          "the decision worker stays off, chat is unaffected",
      );
    }
    for (const migration of this.migrations) {
      if (applied.has(migration.version)) {
        continue;
      }
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO migration_ledger (version, applied_at) VALUES (?, ?)")
          .run(migration.version, this.now().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  /**
   * Idempotent enqueue: the first call durably records the receipt; any
   * repeat with the same identity is a no-op. NEVER stores text.
   */
  enqueue(input: BacklogEnqueueInput): { identity: string; enqueued: boolean } {
    const identity = backlogIdentity(
      input.conversationId,
      input.turnId,
      input.contentSha256,
      input.policyVersion,
    );
    const nowIso = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT identity FROM backlog_items WHERE identity = ?")
        .get(identity) as { identity: string } | undefined;
      if (existing !== undefined) {
        this.db.exec("COMMIT");
        return { identity, enqueued: false };
      }
      this.db
        .prepare(
          "INSERT INTO backlog_items (identity, conversation_id, turn_id, user_message_id, " +
            "content_sha256, variant_sha256, scene_mode, scene_au_id, origin, policy_version, " +
            "state, attempts, queued_at, source_time, selected_refs, prior_versions, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deferred', 0, ?, ?, ?, ?, ?)",
        )
        .run(
          identity,
          input.conversationId,
          input.turnId,
          input.userMessageId,
          input.contentSha256,
          input.variantSha256,
          input.sceneMode,
          input.sceneAuId,
          input.origin,
          input.policyVersion,
          nowIso,
          input.sourceTime,
          JSON.stringify(input.selectedRefs),
          JSON.stringify(input.priorVersions),
          nowIso,
        );
      this.db
        .prepare(
          "INSERT INTO backlog_receipts (identity, at, from_state, to_state, detail) VALUES (?, ?, NULL, 'deferred', ?)",
        )
        .run(identity, nowIso, `enqueued:${input.origin}`);
      this.db.exec("COMMIT");
      return { identity, enqueued: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(identity: string): BacklogItemRow | undefined {
    return this.db.prepare("SELECT * FROM backlog_items WHERE identity = ?").get(identity) as
      | BacklogItemRow
      | undefined;
  }

  getByTurn(turnId: string): BacklogItemRow[] {
    return this.db
      .prepare("SELECT * FROM backlog_items WHERE turn_id = ? ORDER BY queued_at")
      .all(turnId) as unknown as BacklogItemRow[];
  }

  /**
   * Atomically claim the next eligible item (single worker). Live items
   * first by queue order, then backfill oldest-source first (addendum §5
   * priority). Retryable items wait for next_attempt_at. The claim bumps
   * attempts and appends the receipt in the same transaction.
   */
  claimNext(nowIso: string): BacklogItemRow | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.db
        .prepare(
          "SELECT * FROM backlog_items WHERE " +
            "(state = 'deferred' OR (state = 'failed_retryable' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))) " +
            "ORDER BY CASE origin WHEN 'live' THEN 0 ELSE 1 END, " +
            "COALESCE(source_time, queued_at), queued_at LIMIT 1",
        )
        .get(nowIso) as BacklogItemRow | undefined;
      if (candidate === undefined) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const claimedAt = this.now().toISOString();
      this.db
        .prepare(
          "UPDATE backlog_items SET state = 'processing', attempts = attempts + 1, " +
            "next_attempt_at = NULL, updated_at = ? WHERE identity = ?",
        )
        .run(claimedAt, candidate.identity);
      this.db
        .prepare(
          "INSERT INTO backlog_receipts (identity, at, from_state, to_state, detail) VALUES (?, ?, ?, 'processing', ?)",
        )
        .run(candidate.identity, claimedAt, candidate.state, `attempt:${candidate.attempts + 1}`);
      this.db.exec("COMMIT");
      return { ...candidate, state: "processing", attempts: candidate.attempts + 1 };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Settle one item out of 'processing', appending the receipt in the
   * same transaction. Terminal states record decided_at; failed_retryable
   * records next_attempt_at (attempts were bumped at claim time).
   */
  settle(
    identity: string,
    toState: Exclude<BacklogState, "deferred" | "processing">,
    options?: { memoryId?: string; detail?: string; nextAttemptAt?: string },
  ): void {
    const nowIso = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare("SELECT state FROM backlog_items WHERE identity = ?")
        .get(identity) as { state: string } | undefined;
      if (current === undefined) {
        throw new Error(`settle: unknown backlog identity ${identity.slice(0, 12)}`);
      }
      const isTerminal = (TERMINAL_STATES as readonly string[]).includes(toState);
      this.db
        .prepare(
          "UPDATE backlog_items SET state = ?, next_attempt_at = ?, " +
            "decided_at = ?, memory_id = COALESCE(?, memory_id), detail = ?, updated_at = ? WHERE identity = ?",
        )
        .run(
          toState,
          options?.nextAttemptAt ?? null,
          isTerminal ? nowIso : null,
          options?.memoryId ?? null,
          clipDetail(options?.detail),
          nowIso,
          identity,
        );
      this.db
        .prepare(
          "INSERT INTO backlog_receipts (identity, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?)",
        )
        .run(identity, nowIso, current.state, toState, clipDetail(options?.detail));
      if (isTerminal && toState !== "failed_terminal") {
        this.setMeta("last_success_at", nowIso);
      }
      if (toState === "failed_retryable" || toState === "failed_terminal") {
        this.setMeta("last_failure_at", nowIso);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Crash recovery (§4.1): every 'processing' row returns to 'deferred'
   * with a typed receipt. Exactly-once card creation is preserved by the
   * downstream per-turn dedup, so re-deferring can never duplicate.
   */
  recoverProcessing(): number {
    const nowIso = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare("SELECT identity FROM backlog_items WHERE state = 'processing'")
        .all() as Array<{ identity: string }>;
      for (const row of rows) {
        this.db
          .prepare(
            "UPDATE backlog_items SET state = 'deferred', updated_at = ? WHERE identity = ?",
          )
          .run(nowIso, row.identity);
        this.db
          .prepare(
            "INSERT INTO backlog_receipts (identity, at, from_state, to_state, detail) VALUES (?, ?, 'processing', 'deferred', 'crash_recovery_resume')",
          )
          .run(row.identity, nowIso);
      }
      this.db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Park a processing item as 'deferred_oversize' with a typed reason
   * (correction A §4.5 + continuous-completion ruling). The item is
   * preserved for T05D chunk-and-assemble; it is not declined,
   * quarantined, or terminal — and it leaves the claim pool so the queue
   * advances past it (the v1 'deferred' shape livelocked at the head).
   */
  deferOversize(identity: string, detail: string): void {
    const nowIso = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE backlog_items SET state = 'deferred_oversize', detail = ?, updated_at = ? WHERE identity = ?",
        )
        .run(clipDetail(detail), nowIso, identity);
      this.db
        .prepare(
          "INSERT INTO backlog_receipts (identity, at, from_state, to_state, detail) VALUES (?, ?, 'processing', 'deferred_oversize', ?)",
        )
        .run(identity, nowIso, clipDetail(detail));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  counters(): BacklogCounters {
    const byState = new Map<string, number>();
    for (const row of this.db
      .prepare("SELECT state, count(*) AS c FROM backlog_items GROUP BY state")
      .all() as Array<{ state: string; c: number }>) {
      byState.set(row.state, row.c);
    }
    const total = (this.db.prepare("SELECT count(*) AS c FROM backlog_items").get() as { c: number }).c;
    const oldest = this.db
      .prepare(
        "SELECT queued_at FROM backlog_items WHERE state IN ('deferred','failed_retryable') ORDER BY queued_at LIMIT 1",
      )
      .get() as { queued_at: string } | undefined;
    return {
      source_receipts_total: total,
      deferred_total: byState.get("deferred") ?? 0,
      processing_total: byState.get("processing") ?? 0,
      declined_total: byState.get("declined") ?? 0,
      duplicate_total: byState.get("duplicate") ?? 0,
      policy_activated_total: byState.get("policy_activated") ?? 0,
      quarantined_total: byState.get("quarantined") ?? 0,
      retryable_failed_total: byState.get("failed_retryable") ?? 0,
      terminal_failed_total: byState.get("failed_terminal") ?? 0,
      oversize_deferred_total: byState.get("deferred_oversize") ?? 0,
      oldest_deferred_at: oldest?.queued_at ?? null,
      last_success_at: this.getMeta("last_success_at"),
      last_failure_at: this.getMeta("last_failure_at"),
    };
  }

  // ---- provider call ledger (reserve-before-call) ---------------------

  /** Reserve a provider call BEFORE dialing; the reservation is spent
   *  budget even if the process dies mid-call (never refunded). */
  reserveCall(identity: string, callId: string): void {
    this.db
      .prepare(
        "INSERT INTO provider_ledger (call_id, identity, reserved_at) VALUES (?, ?, ?)",
      )
      .run(callId, identity, this.now().toISOString());
  }

  settleCall(callId: string, outcome: string, servedModel: string | null): void {
    this.db
      .prepare(
        "UPDATE provider_ledger SET settled_at = ?, outcome = ?, served_model = ? WHERE call_id = ?",
      )
      .run(this.now().toISOString(), outcome.slice(0, 80), servedModel, callId);
  }

  /** Reserved calls with reserved_at >= sinceIso (budget accounting). */
  callsReservedSince(sinceIso: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS c FROM provider_ledger WHERE reserved_at >= ?")
        .get(sinceIso) as { c: number }
    ).c;
  }

  /** Total provider calls ever reserved for one identity. */
  callsForIdentity(identity: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS c FROM provider_ledger WHERE identity = ?")
        .get(identity) as { c: number }
    ).c;
  }

  // ---- meta -----------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM backlog_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO backlog_meta (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  listReceipts(identity: string): Array<{ at: string; from_state: string | null; to_state: string; detail: string | null }> {
    return this.db
      .prepare(
        "SELECT at, from_state, to_state, detail FROM backlog_receipts WHERE identity = ? ORDER BY seq",
      )
      .all(identity) as Array<{ at: string; from_state: string | null; to_state: string; detail: string | null }>;
  }

  close(): void {
    this.db.close();
  }
}
