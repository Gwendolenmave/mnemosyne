import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "./types.js";
import { validateCompactThought } from "./compact-thought.js";

/**
 * Durable Telegram runtime state under data/telegram/. Every write is
 * atomic (temp file + fsync + rename) so a crash at any point leaves
 * either the old or the new state, never a torn file. No secrets are
 * ever stored here.
 *
 * Layout:
 *   state.json          offset, bot identity, agent conversation mapping
 *   inbox/<id>.json     one accepted update, normalized (pending state machine)
 *   outbox/<id>.json    persisted reply chunks with per-chunk delivery flags
 *   memory-writes.json  explicit memory-write request states
 *   audit.jsonl         minimal sanitized audit trail (append-only)
 *   media/              downloaded media files
 */

export const STATE_SCHEMA_VERSION = 1;

/**
 * Thinking DISPLAY mode (real-thinking + compact feature). Persisted in
 * state.json so it survives restart.
 * - "compact" (default): show a short English "little thought" distilled from
 *   the raw structured reasoning by an isolated secondary call.
 * - "off": show the body only.
 * `/think auto` is an alias for "compact". The old "raw" mode is retired (it
 * would put raw reasoning into the durable outbox); a persisted "raw" or legacy
 * "auto" migrates to "compact" on load so no existing setting is lost. Raw
 * structured thinking is still the compact source and still recorded hash-only
 * in the transcript — it is just never displayed verbatim nor written to any
 * durable path.
 */
export type ThinkMode = "off" | "compact";
export const DEFAULT_THINK_MODE: ThinkMode = "compact";

/**
 * Parse a persisted think_mode, migrating legacy "auto" → "compact". An absent
 * or unknown value falls back to the configured default (DELOS_THINKING_DISPLAY,
 * itself defaulting to "compact"), so a fresh install honors the env default
 * while any explicit persisted choice always wins.
 */
export function parseThinkMode(value: unknown, fallback: ThinkMode = DEFAULT_THINK_MODE): ThinkMode {
  if (value === "off") return "off";
  if (value === "compact" || value === "auto" || value === "raw") return "compact";
  return fallback;
}

export interface AgentConversationRef {
  conversation_id: string;
  transcript_path: string;
}

/** Durable proactive-messaging activity state (all timestamps ISO). */
export interface ProactiveStateRecord {
  enabled: boolean;
  last_user_at: string | null;
  last_assistant_at: string | null;
  last_auto_episode_at: string | null;
  unanswered_auto_episodes: number;
  cluster_follow_up_sent: boolean;
  follow_up_at: string | null;
  reconnect_at: string | null;
  long_gap_at: string | null;
  /** Automatic episode timestamps (rolling-window ceiling source). */
  episode_times: string[];
  last_suppression: string | null;
  job_seq: number;
}

export function defaultProactiveState(): ProactiveStateRecord {
  return {
    enabled: false,
    last_user_at: null,
    last_assistant_at: null,
    last_auto_episode_at: null,
    unanswered_auto_episodes: 0,
    cluster_follow_up_sent: false,
    follow_up_at: null,
    reconnect_at: null,
    long_gap_at: null,
    episode_times: [],
    last_suppression: null,
    job_seq: 0,
  };
}

function parseModelStamp(raw: unknown): { model: string; at: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return typeof r.model === "string" && typeof r.at === "string" ? { model: r.model, at: r.at } : null;
}

function parseModelProbe(
  raw: unknown,
): { alias: string; cliName: string; ok: boolean; served: string | null; at: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.alias !== "string" || typeof r.cliName !== "string" || typeof r.ok !== "boolean" || typeof r.at !== "string") return null;
  return { alias: r.alias, cliName: r.cliName, ok: r.ok, served: typeof r.served === "string" ? r.served : null, at: r.at };
}

export interface RuntimeState {
  schema_version: number;
  /** Next getUpdates offset (last processed update_id + 1), or null. */
  offset: number | null;
  bot: { id: number; username: string | null } | null;
  agents: Record<string, AgentConversationRef>;
  proactive: ProactiveStateRecord;
  /** Thinking display mode; default "auto". Persisted across restarts. */
  think_mode: ThinkMode;
  /** Model Desk: pinned --model cliName; null/"" = CLI default. Persisted. */
  model_configured: string | null;
  /** Last TRUSTED served model (stream-json init metadata of a real turn). */
  model_served_last: { model: string; at: string } | null;
  /** Last /model switch probe result. */
  model_probe_last: { alias: string; cliName: string; ok: boolean; served: string | null; at: string } | null;
  /**
   * Web retrieval master switch, persisted across restarts. Off unless
   * explicitly turned on in chat.
   *
   * A state file written before this field existed reads as `false`, so
   * an upgrade can never silently arm retrieval. The schema version is
   * deliberately NOT bumped for this addition: bumping it would discard
   * the whole live state file (offset, proactive timers, pinned model).
   */
  web_search_enabled: boolean;
}

export type InboxKind = "text" | "photo" | "voice" | "command" | "unsupported";
export type InboxStatus = "pending" | "processing" | "done";

export interface InboxMediaRef {
  kind: "photo" | "voice";
  file_id: string;
  file_unique_id?: string;
  mime_type?: string;
  byte_size?: number;
  /** Path relative to the media directory, derived internally. */
  local_name?: string;
}

export interface InboxRecord {
  schema_version: number;
  update_id: number;
  external_turn_key: string;
  agent_id: string;
  chat_id: number;
  user_id: number;
  message_id: number;
  kind: InboxKind;
  text: string;
  reply_to_text?: string;
  /** Telegram message_id of the replied-to message (for /remember). */
  reply_to_message_id?: number;
  media?: InboxMediaRef;
  status: InboxStatus;
  received_at: string;
  /** Telegram message date (unix seconds), when Telegram supplied it. */
  message_date?: number;
  /** Set when processing starts; used for crash recovery by turn key. */
  conversation_id?: string;
  transcript_path?: string;
  completed_at?: string;
  note?: string;
}

export interface OutboxChunk {
  index: number;
  text: string;
  delivered: boolean;
}

/**
 * Raw-retirement migration guard (review "Hole A"): pre-retirement
 * runtimes durably stored RAW reasoning in outbox thinking (legacy
 * records also carried kind:"raw"). Anything that does not validate as
 * a compact display thought is dropped at LOAD time, so a stale record
 * can never deliver raw reasoning under the little-thought title. The
 * reply chunks are untouched; only the decorative thinking is shed.
 */
function sanitizeOutboxThinking(record: OutboxRecord): OutboxRecord {
  const thinking = (record as { thinking?: { text?: unknown; kind?: unknown } }).thinking;
  if (thinking === undefined) {
    return record;
  }
  const legacyRaw = (thinking as { kind?: unknown }).kind === "raw";
  const text = (thinking as { text?: unknown }).text;
  if (legacyRaw || typeof text !== "string" || !validateCompactThought(text).ok) {
    const { thinking: _dropped, ...rest } = record as OutboxRecord & { thinking?: unknown };
    return rest as OutboxRecord;
  }
  return record;
}

export interface OutboxRecord {
  schema_version: number;
  /** Durable outbox key; derived from update_id when absent. */
  key?: string;
  /** Present for update-driven replies; absent for proactive episodes. */
  update_id?: number;
  external_turn_key: string;
  chat_id: number;
  chunks: OutboxChunk[];
  created_at: string;
  attempts: number;
  next_attempt_at: string | null;
  /** Inter-bubble pacing profile ("varied" for proactive episodes). */
  pacing?: "default" | "varied";
  /**
   * Independent reasoning to render collapsed on the FIRST chunk only, when a
   * turn produced any and thinking display was on at build time. Display-ready
   * and already truncated to the display budget. Absent for command / error /
   * recovery replies and whenever thinking display is off — those deliver
   * exactly as before.
   */
  thinking?: { source: string; text: string };
}

export type ProactiveTriggerKind = "follow_up" | "reconnect" | "long_gap" | "manual_test";
export type ProactiveJobStatus = "pending" | "processing" | "done" | "failed" | "superseded";
/**
 * Which scheduler asked for this episode. "eventide" is the internal
 * poll-loop scheduler; "external-cron" is reserved for a future thin
 * HTTP trigger adapter (not implemented — this deployment's process is
 * always-on). Optional because pre-v2 job files predate the field.
 */
export type ProactiveTriggerSource = "eventide" | "external-cron" | "manual-test";

export interface ProactiveJobRecord {
  schema_version: number;
  job_seq: number;
  job_id: string;
  external_turn_key: string;
  trigger: ProactiveTriggerKind;
  trigger_source?: ProactiveTriggerSource;
  is_manual_test: boolean;
  chat_id: number;
  status: ProactiveJobStatus;
  created_at: string;
  model_attempts: number;
  next_attempt_at: string | null;
  conversation_id?: string;
  transcript_path?: string;
  outbox_key?: string;
  completed_at?: string;
  note?: string;
}

export type MemoryWriteStatus = "pending" | "confirmed" | "failed" | "uncertain";

export interface MemoryWriteRecord {
  status: MemoryWriteStatus;
  content_sha256: string;
  /** Bounded display preview; full content lives only in the backend. */
  content_preview: string;
  detail: string;
  updated_at: string;
}

export interface MemoryWritesState {
  schema_version: number;
  writes: Record<string, MemoryWriteRecord>;
  last_request_id: string | null;
}

export interface GovernanceUiState {
  dismissed_muse_trace_ids: string[];
  converted_muse_trace_ids: string[];
  /** Proposal ordinal at governance activation; null = not yet set. */
  muse_watermark: number | null;
  /**
   * Memory ids the owner explicitly chose to store verbatim ([保留原句],
   * summary-rule finding 2026-07-13). Only these bypass the
   * transcript-overlap redraft guard at File it. Ids only — no text.
   */
  verbatim_opted_memory_ids: string[];
}

const DONE_INBOX_KEEP = 200;

function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(value, null, 1), null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readJsonIfExists(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function recordFileName(updateId: number): string {
  return `${String(updateId).padStart(16, "0")}.json`;
}

/** Normalize an outbox key: numbers are update-driven replies. */
export function outboxKey(key: number | string): string {
  if (typeof key === "number") {
    return `u-${String(key).padStart(16, "0")}`;
  }
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

function parseProactiveState(raw: unknown): ProactiveStateRecord {
  const fallback = defaultProactiveState();
  if (!isRecord(raw)) {
    return fallback;
  }
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    enabled: raw.enabled === true,
    last_user_at: str(raw.last_user_at),
    last_assistant_at: str(raw.last_assistant_at),
    last_auto_episode_at: str(raw.last_auto_episode_at),
    unanswered_auto_episodes:
      typeof raw.unanswered_auto_episodes === "number" ? raw.unanswered_auto_episodes : 0,
    cluster_follow_up_sent: raw.cluster_follow_up_sent === true,
    follow_up_at: str(raw.follow_up_at),
    reconnect_at: str(raw.reconnect_at),
    long_gap_at: str(raw.long_gap_at),
    episode_times: Array.isArray(raw.episode_times)
      ? raw.episode_times.filter((t): t is string => typeof t === "string")
      : [],
    last_suppression: str(raw.last_suppression),
    job_seq: typeof raw.job_seq === "number" ? raw.job_seq : 0,
  };
}

export class TelegramStateStore {
  readonly rootDir: string;
  readonly inboxDir: string;
  readonly outboxDir: string;
  readonly mediaDir: string;
  readonly proactiveDir: string;
  private readonly statePath: string;
  private readonly memoryWritesPath: string;
  private readonly auditPath: string;
  /** Default display mode for a fresh state (DELOS_THINKING_DISPLAY). */
  private readonly defaultThinkMode: ThinkMode;

  constructor(rootDir: string, options?: { defaultThinkMode?: ThinkMode }) {
    this.rootDir = rootDir;
    this.inboxDir = join(rootDir, "inbox");
    this.outboxDir = join(rootDir, "outbox");
    this.mediaDir = join(rootDir, "media");
    this.proactiveDir = join(rootDir, "proactive");
    this.statePath = join(rootDir, "state.json");
    this.memoryWritesPath = join(rootDir, "memory-writes.json");
    this.auditPath = join(rootDir, "audit.jsonl");
    this.defaultThinkMode = options?.defaultThinkMode ?? DEFAULT_THINK_MODE;
    mkdirSync(this.inboxDir, { recursive: true });
    mkdirSync(this.outboxDir, { recursive: true });
    mkdirSync(this.mediaDir, { recursive: true });
    mkdirSync(this.proactiveDir, { recursive: true });
  }

  // ---- runtime state -------------------------------------------------

  loadState(): RuntimeState {
    const raw = readJsonIfExists(this.statePath);
    if (isRecord(raw) && raw.schema_version === STATE_SCHEMA_VERSION) {
      return {
        schema_version: STATE_SCHEMA_VERSION,
        offset: typeof raw.offset === "number" ? raw.offset : null,
        bot:
          isRecord(raw.bot) && typeof raw.bot.id === "number"
            ? {
                id: raw.bot.id,
                username: typeof raw.bot.username === "string" ? raw.bot.username : null,
              }
            : null,
        agents: isRecord(raw.agents)
          ? Object.fromEntries(
              Object.entries(raw.agents).flatMap(([agentId, ref]) =>
                isRecord(ref) &&
                typeof ref.conversation_id === "string" &&
                typeof ref.transcript_path === "string"
                  ? [
                      [
                        agentId,
                        {
                          conversation_id: ref.conversation_id,
                          transcript_path: ref.transcript_path,
                        },
                      ],
                    ]
                  : [],
              ),
            )
          : {},
        proactive: parseProactiveState(raw.proactive),
        think_mode: parseThinkMode(raw.think_mode, this.defaultThinkMode),
        model_configured: typeof raw.model_configured === "string" && raw.model_configured !== "" ? raw.model_configured : null,
        model_served_last: parseModelStamp(raw.model_served_last),
        model_probe_last: parseModelProbe(raw.model_probe_last),
        // Anything other than a literal true reads as off, so a missing
        // field (state written before retrieval existed) stays off.
        web_search_enabled: raw.web_search_enabled === true,
      };
    }
    return {
      schema_version: STATE_SCHEMA_VERSION,
      offset: null,
      bot: null,
      agents: {},
      proactive: defaultProactiveState(),
      think_mode: this.defaultThinkMode,
      model_configured: null,
      model_served_last: null,
      model_probe_last: null,
      web_search_enabled: false,
    };
  }

  saveState(state: RuntimeState): void {
    atomicWriteJson(this.statePath, state);
  }

  /**
   * Atomic read-modify-write. All state.json mutations must go through
   * here so concurrent logical owners (poll offset, conversation
   * mapping) never clobber each other with stale copies.
   */
  updateState(mutate: (state: RuntimeState) => void): RuntimeState {
    const state = this.loadState();
    mutate(state);
    this.saveState(state);
    return state;
  }

  // ---- inbox ---------------------------------------------------------

  writeInbox(record: InboxRecord): void {
    atomicWriteJson(join(this.inboxDir, recordFileName(record.update_id)), record);
  }

  readInbox(updateId: number): InboxRecord | null {
    const raw = readJsonIfExists(join(this.inboxDir, recordFileName(updateId)));
    return isRecord(raw) ? (raw as unknown as InboxRecord) : null;
  }

  /** All inbox records in ascending update_id order. */
  listInbox(): InboxRecord[] {
    const records: InboxRecord[] = [];
    for (const name of readdirSync(this.inboxDir).sort()) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const raw = readJsonIfExists(join(this.inboxDir, name));
      if (isRecord(raw) && typeof raw.update_id === "number") {
        records.push(raw as unknown as InboxRecord);
      }
    }
    return records;
  }

  listUnfinishedInbox(): InboxRecord[] {
    return this.listInbox().filter((r) => r.status !== "done");
  }

  /** Bound completed-update metadata: keep only the newest N done records. */
  pruneDoneInbox(keep: number = DONE_INBOX_KEEP): void {
    const done = this.listInbox().filter((r) => r.status === "done");
    const excess = done.length - keep;
    for (let i = 0; i < excess; i++) {
      const record = done[i];
      if (record !== undefined) {
        try {
          unlinkSync(join(this.inboxDir, recordFileName(record.update_id)));
        } catch {
          // Already gone; pruning is best-effort.
        }
      }
    }
  }

  // ---- outbox --------------------------------------------------------

  private outboxPath(key: number | string): string {
    return join(this.outboxDir, `${outboxKey(key)}.json`);
  }

  writeOutbox(record: OutboxRecord): void {
    const key = record.key ?? outboxKey(record.update_id ?? 0);
    atomicWriteJson(this.outboxPath(key), { ...record, key });
  }

  readOutbox(key: number | string): OutboxRecord | null {
    const raw = readJsonIfExists(this.outboxPath(key));
    return isRecord(raw) ? sanitizeOutboxThinking(raw as unknown as OutboxRecord) : null;
  }

  listOutbox(): OutboxRecord[] {
    const records: OutboxRecord[] = [];
    for (const name of readdirSync(this.outboxDir).sort()) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const raw = readJsonIfExists(join(this.outboxDir, name));
      if (isRecord(raw) && Array.isArray(raw.chunks)) {
        records.push(sanitizeOutboxThinking(raw as unknown as OutboxRecord));
      }
    }
    return records;
  }

  deleteOutbox(key: number | string): void {
    try {
      unlinkSync(this.outboxPath(key));
    } catch {
      // Best-effort: absence is the goal.
    }
  }

  // ---- proactive jobs --------------------------------------------------

  writeProactiveJob(record: ProactiveJobRecord): void {
    atomicWriteJson(join(this.proactiveDir, recordFileName(record.job_seq)), record);
  }

  readProactiveJob(jobSeq: number): ProactiveJobRecord | null {
    const raw = readJsonIfExists(join(this.proactiveDir, recordFileName(jobSeq)));
    return isRecord(raw) ? (raw as unknown as ProactiveJobRecord) : null;
  }

  listProactiveJobs(): ProactiveJobRecord[] {
    const records: ProactiveJobRecord[] = [];
    for (const name of readdirSync(this.proactiveDir).sort()) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const raw = readJsonIfExists(join(this.proactiveDir, name));
      if (isRecord(raw) && typeof raw.job_seq === "number") {
        records.push(raw as unknown as ProactiveJobRecord);
      }
    }
    return records;
  }

  listUnfinishedProactiveJobs(): ProactiveJobRecord[] {
    return this.listProactiveJobs().filter(
      (j) => j.status === "pending" || j.status === "processing",
    );
  }

  // ---- memory writes -------------------------------------------------

  loadMemoryWrites(): MemoryWritesState {
    const raw = readJsonIfExists(this.memoryWritesPath);
    if (isRecord(raw) && raw.schema_version === STATE_SCHEMA_VERSION && isRecord(raw.writes)) {
      return {
        schema_version: STATE_SCHEMA_VERSION,
        writes: raw.writes as unknown as Record<string, MemoryWriteRecord>,
        last_request_id:
          typeof raw.last_request_id === "string" ? raw.last_request_id : null,
      };
    }
    return { schema_version: STATE_SCHEMA_VERSION, writes: {}, last_request_id: null };
  }

  saveMemoryWrites(state: MemoryWritesState): void {
    atomicWriteJson(this.memoryWritesPath, state);
  }

  // ---- companion proposal pass state ---------------------------------------

  private get companionPassPath(): string {
    return join(this.rootDir, "companion-pass.json");
  }

  /**
   * Pointer-and-hash queue + budget counters for the Companion proposal
   * pass. NO exchange text is ever stored here (review clarification):
   * entries carry IDs, hashes, versions, and timestamps only.
   *
   * Owner-lane migration: a pre-split file carried ONE counter family
   * and ONE hourly window. Those attempts cannot be classified by
   * origin after the fact, so on load they are assigned conservatively
   * to the AUTONOMOUS bucket (never the owner bucket) and the
   * owner-initiated bucket starts empty. Queue, breaker state, and
   * counters are all preserved — nothing is cleared.
   */
  loadCompanionPass(): import("../automation/companion-proposals.js").CompanionPassState {
    const raw = readJsonIfExists(this.companionPassPath);
    if (isRecord(raw) && Array.isArray(raw.queue) && isRecord(raw.counters)) {
      const counters = raw.counters as Record<string, unknown>;
      if (isRecord(counters.autonomous) && isRecord(counters.owner_initiated)) {
        return raw as unknown as import("../automation/companion-proposals.js").CompanionPassState;
      }
      if (typeof counters.attempted === "number") {
        return {
          ...raw,
          owner_window_started_at: null,
          owner_window_count: 0,
          counters: {
            autonomous: counters,
            owner_initiated: {
              attempted: 0,
              declined: 0,
              proposed: 0,
              duplicate: 0,
              skipped_budget: 0,
              skipped_integrity: 0,
              failed: 0,
            },
          },
        } as unknown as import("../automation/companion-proposals.js").CompanionPassState;
      }
    }
    return {
      queue: [],
      window_started_at: null,
      window_count: 0,
      owner_window_started_at: null,
      owner_window_count: 0,
      consecutive_failures: 0,
      breaker_until: null,
      counters: {
        autonomous: {
          attempted: 0,
          declined: 0,
          proposed: 0,
          duplicate: 0,
          skipped_budget: 0,
          skipped_integrity: 0,
          failed: 0,
        },
        owner_initiated: {
          attempted: 0,
          declined: 0,
          proposed: 0,
          duplicate: 0,
          skipped_budget: 0,
          skipped_integrity: 0,
          failed: 0,
        },
      },
    };
  }

  saveCompanionPass(state: import("../automation/companion-proposals.js").CompanionPassState): void {
    atomicWriteJson(this.companionPassPath, state);
  }

  // ---- governance ui state --------------------------------------------

  private get governanceUiPath(): string {
    return join(this.rootDir, "governance-ui.json");
  }

  /**
   * Owner-side Muse triage state: dismissed/converted pointers never
   * reappear in the default inbox; the watermark (proposal ordinal at
   * governance activation) keeps the default view to NEW proposals only.
   * Trace ids and counts only — never text.
   */
  loadGovernanceUi(): GovernanceUiState {
    const raw = readJsonIfExists(this.governanceUiPath);
    if (isRecord(raw)) {
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
      return {
        dismissed_muse_trace_ids: strings(raw.dismissed_muse_trace_ids),
        converted_muse_trace_ids: strings(raw.converted_muse_trace_ids),
        muse_watermark: typeof raw.muse_watermark === "number" ? raw.muse_watermark : null,
        verbatim_opted_memory_ids: strings(raw.verbatim_opted_memory_ids),
      };
    }
    return {
      dismissed_muse_trace_ids: [],
      converted_muse_trace_ids: [],
      muse_watermark: null,
      verbatim_opted_memory_ids: [],
    };
  }

  saveGovernanceUi(state: GovernanceUiState): void {
    atomicWriteJson(this.governanceUiPath, {
      schema_version: STATE_SCHEMA_VERSION,
      ...state,
    });
  }

  // ---- audit ---------------------------------------------------------

  /** Append one sanitized audit event. Never write secrets here. */
  appendAudit(event: Record<string, unknown>): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
    const fd = openSync(this.auditPath, "a");
    try {
      writeSync(fd, line + "\n", null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
