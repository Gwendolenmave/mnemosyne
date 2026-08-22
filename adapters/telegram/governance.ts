/**
 * Telegram memory-governance adapter: the owner-only UI over
 * MnemosyneGovernanceService. All RULES live in the core service; this
 * file only authenticates, renders previews, and maps button presses to
 * governance operations.
 *
 * Security boundary:
 * - every command and every callback verifies the configured numeric
 *   owner id and private chat — usernames are never trusted;
 * - callback payloads are opaque single-use nonces ("g1:<uuid>", within
 *   Telegram's 64-byte limit); action + target live server-side, so
 *   payloads never carry memory text and cannot be forged, replayed, or
 *   pointed at a different card;
 * - replayed/stale/unknown nonces are rejected with a plain answer;
 * - governance writes are idempotent at the service layer, so at-least-
 *   once update delivery (crash between action and offset ack) is safe;
 * - session text (the memory draft) is consumed here and NEVER forwarded
 *   into ordinary chat context; outside an active session ordinary
 *   messages stay ordinary chat.
 */

import { randomUUID } from "node:crypto";
import type {
  GovernanceItemView,
  MnemosyneGovernanceService,
  ProposalEvidence,
} from "../../core/services/mnemosyne-governance.js";
import { parseProvenance } from "../../core/services/mnemosyne-governance.js";
import type { CompanionProposalPass } from "../automation/companion-proposals.js";
import { verbatimOverlap, VERBATIM_OVERLAP_THRESHOLD } from "../automation/companion-proposals.js";
import type { GovernanceUiState, InboxRecord } from "./state-store.js";
import type { TelegramCallbackQuery } from "./types.js";

export interface GovernanceApi {
  sendMessage(chatId: number, text: string): Promise<void>;
  sendMessageWithKeyboard(
    chatId: number,
    text: string,
    keyboard: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export interface TranscriptLookup {
  byTelegramMessageId(
    telegramMessageId: number,
  ): { conversationId: string; turnId: string; messageId: string } | null;
  turnTexts(turnId: string): {
    userText: string | null;
    assistantText: string | null;
    conversationId: string | null;
    userMessageId: string | null;
  } | null;
}

/** Pointer-only Muse shadow proposal (no text lives in traces). */
export interface MuseProposalPointer {
  traceId: string;
  turnId: string;
  memoryAction: string;
  /** Stable ordinal across trace files (watermark comparisons). */
  seq: number;
}

export interface MuseProposalSource {
  list(): MuseProposalPointer[];
}

export interface GovernanceUiStateStore {
  loadGovernanceUi(): GovernanceUiState;
  saveGovernanceUi(state: GovernanceUiState): void;
  appendAudit(event: Record<string, unknown>): void;
}

export interface TelegramGovernanceOptions {
  ownerId: number;
  api: GovernanceApi;
  service: MnemosyneGovernanceService;
  transcripts: TranscriptLookup;
  muse: MuseProposalSource | null;
  ui: GovernanceUiStateStore;
  /** Three-paths drafting lane; null = Paths A/B/C drafting unavailable. */
  companionPass?: CompanionProposalPass | null;
  log?: (line: string) => void;
  now?: () => Date;
}

type PendingAction =
  | { kind: "approve"; memoryId: string }
  | { kind: "reject"; memoryId: string }
  | { kind: "revoke"; memoryId: string }
  | { kind: "edit"; memoryId: string }
  | { kind: "revise"; memoryId: string }
  | { kind: "view"; memoryId: string }
  | { kind: "revise_commit"; memoryId: string; text: string }
  | { kind: "inbox_page"; page: number }
  | { kind: "muse_page"; page: number; all: boolean }
  | { kind: "muse_dismiss"; traceId: string }
  | { kind: "muse_source"; turnId: string }
  | { kind: "muse_review"; traceId: string; turnId: string; memoryAction: string }
  | { kind: "remember_draft"; turnId: string }
  | { kind: "remember_self"; turnId: string }
  | { kind: "file_it"; memoryId: string }
  | { kind: "return_it"; memoryId: string; turnId: string }
  | { kind: "redraft"; memoryId: string; turnId: string }
  | { kind: "keep_verbatim"; memoryId: string }
  | { kind: "card_source"; turnId: string }
  | { kind: "tray_edit"; memoryId: string }
  | { kind: "later" }
  | { kind: "companion_page"; page: number }
  | { kind: "cancel_session" };

interface NonceEntry {
  action: PendingAction;
  expiresAt: number;
  used: boolean;
}

type Session =
  | {
      kind: "await_text";
      mode: "remember" | "add" | "edit" | "revise" | "return_note" | "tray_edit";
      evidence?: ProposalEvidence;
      memoryId?: string;
      sourceTurnId?: string;
      museSuggestion?: string;
      museTraceId?: string;
      expiresAt: number;
    }
  | null;

const SESSION_TTL_MS = 10 * 60_000;
const NONCE_TTL_MS = 30 * 60_000;
const PAGE_SIZE = 3;
const PREVIEW_CHARS = 160;

/** Preflight wording (amendment 1): configuration is not authentication. */
export const GOVERNANCE_PREFLIGHT_CONFIGURED =
  "telegram owner configured (numeric id configured; private chat only; authentication occurs per update)";
export const GOVERNANCE_PREFLIGHT_UNCONFIGURED =
  "unconfigured — governance commands unavailable; chat unaffected";

const SCOPE_LABEL: Record<string, string> = {
  global: "global",
  relationship: "relationship",
  project: "project",
  au: "AU",
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class TelegramGovernance {
  private readonly ownerId: number;
  private readonly api: GovernanceApi;
  private readonly service: MnemosyneGovernanceService;
  private readonly transcripts: TranscriptLookup;
  private readonly muse: MuseProposalSource | null;
  private readonly ui: GovernanceUiStateStore;
  private readonly companionPass: CompanionProposalPass | null;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  private session: Session = null;
  private readonly nonces = new Map<string, NonceEntry>();
  private ownerAuthenticatedAudited = false;

  constructor(options: TelegramGovernanceOptions) {
    this.ownerId = options.ownerId;
    this.api = options.api;
    this.service = options.service;
    this.transcripts = options.transcripts;
    this.muse = options.muse;
    this.ui = options.ui;
    this.companionPass = options.companionPass ?? null;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    // Activation watermark (amendment 3): everything already in the
    // trace backlog at activation stays out of the DEFAULT muse inbox.
    try {
      if (this.muse !== null) {
        const state = this.ui.loadGovernanceUi();
        if (state.muse_watermark === null) {
          state.muse_watermark = this.muse.list().length;
          this.ui.saveGovernanceUi(state);
        }
      }
    } catch (error) {
      this.log(
        `governance watermark init failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Amendment 1: owner_authenticated is recorded only after a REAL
   *  command/callback passed sender-id + private-chat verification. */
  private markOwnerAuthenticated(): void {
    if (!this.ownerAuthenticatedAudited) {
      this.ownerAuthenticatedAudited = true;
      this.ui.appendAudit({ type: "governance_owner_authenticated" });
    }
  }

  // ---- auth ------------------------------------------------------------

  private isOwnerRecord(record: InboxRecord): boolean {
    return record.user_id === this.ownerId && record.chat_id === record.user_id;
  }

  // ---- command entry ----------------------------------------------------

  /** True when the record was fully handled by governance. */
  async handleCommand(
    record: InboxRecord,
    command: string,
    args: string,
  ): Promise<boolean> {
    if (command !== "remember" && command !== "memory") {
      return false;
    }
    if (!this.isOwnerRecord(record)) {
      this.ui.appendAudit({ type: "governance_denied", reason: "non_owner_command" });
      await this.send(record.chat_id, "记忆治理命令仅限所有者使用。");
      return true;
    }
    this.markOwnerAuthenticated();
    if (command === "remember") {
      await this.startRemember(record, args);
      return true;
    }
    const [sub, ...restParts] = args.split(/\s+/);
    const rest = restParts.join(" ").trim();
    switch ((sub ?? "").toLowerCase()) {
      case "add":
        await this.startAdd(record.chat_id, rest);
        return true;
      case "inbox":
        await this.showInbox(record.chat_id, 0);
        return true;
      case "search":
        await this.showSearch(record.chat_id, rest);
        return true;
      case "show":
        await this.showCard(record.chat_id, rest);
        return true;
      case "muse":
        await this.showMuse(record.chat_id, 0, rest.toLowerCase() === "all");
        return true;
      case "companion":
        await this.showCompanionTray(record.chat_id, 0);
        return true;
      case "backup": {
        const retry = this.service.retryBackup();
        await this.send(
          record.chat_id,
          retry.ok ? `✅ 验证备份完成：${retry.detail}` : `❌ 备份仍失败：${retry.detail}`,
        );
        return true;
      }
      case "cancel":
        this.session = null;
        await this.send(record.chat_id, "已退出记忆治理会话。现在的消息都是普通聊天。");
        return true;
      default:
        await this.send(
          record.chat_id,
          [
            "记忆治理命令：",
            "/remember —— 回复一条消息后发送，把它铸成记忆候选",
            "/memory add <内容> —— 手动新建候选",
            "/memory inbox —— 待确认候选收件箱",
            "/memory search <关键词> —— 查已确认记忆",
            "/memory muse —— 新的 Muse 候选路标（历史积压加 all）",
            "/memory companion —— Companion 想记住的（他亲笔的待收档提案）",
            "/memory backup —— 安全重试验证备份",
            "/memory cancel —— 退出当前治理会话",
            "",
            "可选前缀：[scope:project] [au:某个au] [sensitivity:intimate]",
          ].join("\n"),
        );
        return true;
    }
  }

  /** Consumes the text when a governance session is active (owner only). */
  async maybeConsumeText(record: InboxRecord): Promise<boolean> {
    if (this.session === null || this.session.expiresAt < this.now().getTime()) {
      this.session = null;
      return false;
    }
    if (!this.isOwnerRecord(record)) {
      return false;
    }
    const session = this.session;
    this.session = null;
    const text = record.text.trim();
    if (text.length === 0) {
      await this.send(record.chat_id, "空文本，已退出治理会话。");
      return true;
    }
    switch (session.mode) {
      case "remember":
      case "add": {
        await this.proposeFromText(
          record.chat_id,
          text,
          session.evidence ?? { kind: "manual" },
          session.museSuggestion,
          session.museTraceId,
        );
        return true;
      }
      case "edit": {
        const outcome = await this.service.editPending(session.memoryId ?? "", text, "owner");
        if (outcome.status !== "ok") {
          await this.send(record.chat_id, this.refusalText("修改", outcome));
          return true;
        }
        await this.sendPreview(record.chat_id, outcome.memoryId, "候选已更新，仍未确认 — 需要再次批准");
        return true;
      }
      case "tray_edit": {
        // Owner edits Companion's pending proposal: authorship stays his,
        // edited_by=owner lands in the SAME transaction; File it still
        // required afterwards. Leading bracket attributes let her
        // explicitly change scope/AU/sensitivity before filing
        // (pre-merge patch #2) — an explicit human decision, never a
        // silent default.
        const hasAttrs = text.startsWith("[");
        const parsed = this.parseAttrs(text);
        const outcome = await this.service.editPending(
          session.memoryId ?? "",
          hasAttrs ? parsed.body : text,
          "owner",
          undefined,
          { edited_by: "owner" },
          hasAttrs
            ? {
                scope: parsed.scope,
                ...(parsed.auId !== undefined ? { auId: parsed.auId } : {}),
                sensitivity: parsed.sensitivity,
              }
            : undefined,
        );
        if (outcome.status !== "ok") {
          await this.send(record.chat_id, this.refusalText("修改", outcome));
          return true;
        }
        await this.sendTrayCard(record.chat_id, outcome.memoryId, "已按你的改动更新（authored_by 仍是他）— 需要再按一次收档");
        return true;
      }
      case "return_note": {
        const pass = this.companionPass;
        const memoryId = session.memoryId ?? "";
        if (pass === null || session.sourceTurnId === undefined) {
          await this.send(record.chat_id, "起草通道未接线，无法打回重写。");
          return true;
        }
        const entry = pass.buildDirectedEntry(session.sourceTurnId, "owner_requested", {
          ownerNote: text,
        });
        if (entry === null) {
          await this.send(record.chat_id, "未能在转录档案中定位来源轮（完整性保护，未重写）。");
          return true;
        }
        await this.send(record.chat_id, "已打回，他在重写…");
        const outcome = await pass.runReturnRewrite(memoryId, entry);
        if (outcome.result === "proposed") {
          await this.sendTrayCard(record.chat_id, memoryId, "他重写好了（原版本保留在事件史）");
        } else if (outcome.result === "needs_redraft") {
          await this.send(record.chat_id, "他这版仍太贴近原文（记忆卡要摘要）。可再打回一次，或按「📌 保留原句」明确保留。");
          await this.sendTrayCard(record.chat_id, memoryId);
        } else if (outcome.result === "declined") {
          await this.send(record.chat_id, `他看了你的附注，决定撤回这张卡的想法：${outcome.note}`);
        } else if (outcome.result === "skipped_budget") {
          await this.send(record.chat_id, `${this.passLimitText(outcome.reason)}\n卡片保持原样待处理。`);
        } else if (outcome.result === "skipped_integrity") {
          await this.send(record.chat_id, "来源轮校验未通过（完整性保护），这次没有重写。卡片保持原样待处理。");
        } else {
          await this.send(record.chat_id, "重写没有完成（模型通道故障），聊天不受影响。卡片保持原样待处理。");
        }
        return true;
      }
      case "revise": {
        // Second explicit approval: hold the replacement server-side and
        // only commit when the owner presses the confirm button.
        const memoryId = session.memoryId ?? "";
        const item = this.service.getCard(memoryId);
        if (item === undefined) {
          await this.send(record.chat_id, "这张卡已经不存在了。");
          return true;
        }
        const nonce = this.mint({ kind: "revise_commit", memoryId, text });
        await this.api.sendMessageWithKeyboard(
          record.chat_id,
          [
            "✏️ 修订预览（尚未写入）",
            "────────",
            `旧: ${clip(item.body, PREVIEW_CHARS)}`,
            `新: ${clip(text, PREVIEW_CHARS)}`,
            "────────",
            "确认后旧版本保留在事件史中，检索使用新文本。",
          ].join("\n"),
          [
            [
              { text: "✅ 确认修订", callback_data: nonce },
              { text: "取消", callback_data: this.mint({ kind: "cancel_session" }) },
            ],
          ],
        );
        return true;
      }
    }
  }

  // ---- callbacks ---------------------------------------------------------

  async handleCallback(cb: TelegramCallbackQuery): Promise<void> {
    const chatOk = cb.message !== undefined && cb.message.chat.type === "private";
    if (cb.from.id !== this.ownerId || !chatOk) {
      this.ui.appendAudit({ type: "governance_denied", reason: "non_owner_callback" });
      await this.answer(cb.id, "仅限所有者操作。");
      return;
    }
    this.markOwnerAuthenticated();
    const chatId = cb.message!.chat.id;
    const data = cb.data ?? "";
    if (!data.startsWith("g1:")) {
      await this.answer(cb.id, "无法识别的按钮。");
      return;
    }
    this.prune();
    const entry = this.nonces.get(data.slice(3));
    if (entry === undefined || entry.expiresAt < this.now().getTime()) {
      this.ui.appendAudit({ type: "governance_denied", reason: "stale_or_unknown_callback" });
      await this.answer(cb.id, "这个按钮已过期，请重新打开列表。");
      return;
    }
    if (entry.used) {
      this.ui.appendAudit({ type: "governance_denied", reason: "replayed_callback" });
      await this.answer(cb.id, "已处理过（重复点击被忽略）。");
      return;
    }
    // Execute FIRST (operations are idempotent), then burn the nonce, so
    // a crash between the two only ever replays an idempotent action.
    await this.execute(chatId, cb.id, entry.action);
    entry.used = true;
  }

  private async execute(chatId: number, cbId: string, action: PendingAction): Promise<void> {
    switch (action.kind) {
      case "approve": {
        const outcome = await this.service.approve(action.memoryId, "owner");
        if (outcome.status === "ok") {
          await this.answer(cbId, "已确认 ✅");
          await this.send(
            chatId,
            outcome.backup.ok
              ? `✅ 已确认为记忆（confirmed by=owner）。\nid ${action.memoryId.slice(0, 8)} · 备份已验证`
              : `✅ 记忆已保存（已提交），但验证备份失败——**不要重复提交**。\nid ${action.memoryId.slice(0, 8)} · 用 /memory backup 可安全重试备份。`,
          );
        } else if (outcome.status === "already") {
          await this.answer(cbId, "本来就已确认。");
        } else {
          await this.answer(cbId);
          await this.send(chatId, this.refusalText("批准", outcome));
        }
        return;
      }
      case "reject": {
        const outcome = await this.service.reject(action.memoryId, "owner", "rejected via inbox");
        await this.answer(cbId, outcome.status === "ok" ? "已驳回 🗑" : "未生效");
        if (outcome.status === "ok") {
          await this.send(chatId, "🗑 候选已驳回：不会成为记忆，事件史保留。");
        } else if (outcome.status === "already") {
          await this.send(chatId, `无需操作：${outcome.detail}`);
        } else {
          await this.send(chatId, this.refusalText("驳回", outcome));
        }
        return;
      }
      case "revoke": {
        const outcome = await this.service.revoke(action.memoryId, "owner", "revoked by owner");
        await this.answer(cbId, outcome.status === "ok" ? "已撤销" : "未生效");
        if (outcome.status === "ok") {
          await this.send(chatId, "🚫 已撤销：不再参与检索，全部历史与审计保留。");
        } else if (outcome.status === "already") {
          await this.send(chatId, `无需操作：${outcome.detail}`);
        } else {
          await this.send(chatId, this.refusalText("撤销", outcome));
        }
        return;
      }
      case "edit":
      case "revise": {
        this.session = {
          kind: "await_text",
          mode: action.kind,
          memoryId: action.memoryId,
          expiresAt: this.now().getTime() + SESSION_TTL_MS,
        };
        await this.answer(cbId);
        await this.send(
          chatId,
          action.kind === "edit"
            ? "请发送替换后的候选全文（10 分钟内有效；/memory cancel 退出）。"
            : "请发送修订后的记忆全文（旧版本会保留在事件史；/memory cancel 退出）。",
        );
        return;
      }
      case "view": {
        await this.answer(cbId);
        await this.sendCardDetail(chatId, action.memoryId);
        return;
      }
      case "revise_commit": {
        const outcome = await this.service.reviseConfirmed(action.memoryId, action.text, "owner");
        await this.answer(cbId, outcome.status === "ok" ? "已修订 ✅" : "未生效");
        if (outcome.status === "ok") {
          await this.send(
            chatId,
            outcome.backup.ok
              ? "✅ 修订完成并再次确认（旧版本保留在事件史）。备份已验证。"
              : "✅ 修订已保存（已提交），但验证备份失败——**不要重复提交**。用 /memory backup 可安全重试备份。",
          );
        } else if (outcome.status === "already") {
          await this.send(chatId, outcome.detail);
        } else {
          await this.send(chatId, this.refusalText("修订", outcome));
        }
        return;
      }
      case "inbox_page":
        await this.answer(cbId);
        await this.showInbox(chatId, action.page);
        return;
      case "muse_page":
        await this.answer(cbId);
        await this.showMuse(chatId, action.page, action.all);
        return;
      // Pre-merge patch #3: the legacy direct-minting path for Muse
      // suggestions is REMOVED. Muse flow is always Muse → Companion review
      // → Owner files; when the review lane is unavailable the pointer
      // stays unreviewed (view/dismiss only) — a Muse-derived candidate
      // can never exist without Companion's review.
      case "muse_dismiss": {
        const state = this.ui.loadGovernanceUi();
        if (!state.dismissed_muse_trace_ids.includes(action.traceId)) {
          state.dismissed_muse_trace_ids.push(action.traceId);
          this.ui.saveGovernanceUi(state);
        }
        await this.answer(cbId, "已忽略");
        return;
      }
      case "muse_source": {
        await this.answer(cbId);
        const turn = this.transcripts.turnTexts(action.turnId);
        if (turn === null) {
          await this.send(chatId, "未能在转录档案中定位该轮。");
          return;
        }
        await this.send(
          chatId,
          [
            "📄 来源轮（仅所有者可见，非记忆）",
            turn.userText !== null ? `你：${clip(turn.userText, 400)}` : "（无用户文本）",
            turn.assistantText !== null ? `他：${clip(turn.assistantText, 400)}` : "",
          ].join("\n"),
        );
        return;
      }
      case "remember_self": {
        // Owner writes it herself: the classic flow, source stays bound.
        await this.answer(cbId);
        this.session = {
          kind: "await_text",
          mode: "remember",
          evidence: this.evidenceForTurn(action.turnId),
          expiresAt: this.now().getTime() + SESSION_TTL_MS,
        };
        await this.send(chatId, "好，你来写。请发送记忆原文（10 分钟内有效）。");
        return;
      }
      case "remember_draft": {
        await this.answer(cbId);
        await this.runDraftFlow(chatId, action.turnId, "owner_requested");
        return;
      }
      case "muse_review": {
        await this.answer(cbId);
        await this.runDraftFlow(chatId, action.turnId, "muse_review", action.memoryAction);
        // A reviewed pointer leaves the default muse inbox either way.
        const state = this.ui.loadGovernanceUi();
        if (!state.dismissed_muse_trace_ids.includes(action.traceId)) {
          state.dismissed_muse_trace_ids.push(action.traceId);
          this.ui.saveGovernanceUi(state);
        }
        return;
      }
      case "file_it": {
        const card = this.service.getCard(action.memoryId);
        if (card !== undefined && this.cardNeedsRedraft(card)) {
          await this.answer(cbId);
          await this.send(
            chatId,
            "这张卡太贴近原文了（可能是整段照抄）。记忆卡应是摘要，不是誊本。\n请先「🔁 让他重写」概括一版，或明确按「📌 保留原句」再收档。",
          );
          await this.sendTrayCard(chatId, action.memoryId);
          return;
        }
        const outcome = await this.service.approve(action.memoryId, "owner");
        if (outcome.status === "ok") {
          await this.answer(cbId, "已收档 ✅");
          await this.send(
            chatId,
            `✅ 已收档：他写的，这下真的记住了（confirmed by=owner）。\nid ${action.memoryId.slice(0, 8)} · 备份${outcome.backup.ok ? "已验证" : "失败（写入已生效，可 /memory backup 重试）"}`,
          );
        } else if (outcome.status === "already") {
          await this.answer(cbId, "本来就已收档。");
        } else {
          await this.answer(cbId);
          await this.send(chatId, this.refusalText("收档", outcome));
        }
        return;
      }
      case "return_it": {
        await this.answer(cbId);
        this.session = {
          kind: "await_text",
          mode: "return_note",
          memoryId: action.memoryId,
          sourceTurnId: action.turnId,
          expiresAt: this.now().getTime() + SESSION_TTL_MS,
        };
        await this.send(chatId, "打回给他重写。附一句为什么（10 分钟内有效；/memory cancel 退出）：");
        return;
      }
      case "redraft": {
        await this.answer(cbId);
        const pass = this.companionPass;
        if (pass === null) {
          await this.send(chatId, "起草通道未接线，无法请他重写。");
          return;
        }
        const entry = pass.buildDirectedEntry(action.turnId, "owner_requested", {
          ownerNote: "上一版太贴近原文了。请用你自己的话把它概括成 1–3 句的摘要，别复制对话。",
        });
        if (entry === null) {
          await this.send(chatId, "未能在转录档案中定位来源轮（完整性保护，未重写）。");
          return;
        }
        await this.send(chatId, "好，请他把这条概括成摘要…");
        const outcome = await pass.runReturnRewrite(action.memoryId, entry);
        if (outcome.result === "proposed") {
          await this.sendTrayCard(chatId, action.memoryId, "他重写成摘要了（原文仍在转录档案）");
        } else if (outcome.result === "needs_redraft") {
          await this.send(chatId, "他这次还是写得太贴近原文。可以再试一次，或按「📌 保留原句」明确保留。");
          await this.sendTrayCard(chatId, action.memoryId);
        } else if (outcome.result === "declined") {
          await this.send(chatId, `他看了之后决定撤回这张卡的想法：${outcome.note}`);
        } else if (outcome.result === "skipped_budget") {
          await this.send(chatId, `${this.passLimitText(outcome.reason)}\n卡片保持原样待处理。`);
        } else {
          await this.send(chatId, "重写没有完成（通道故障或校验未过），卡片保持原样待处理。");
        }
        return;
      }
      case "keep_verbatim": {
        await this.answer(cbId, "已标记保留原句");
        const state = this.ui.loadGovernanceUi();
        if (!state.verbatim_opted_memory_ids.includes(action.memoryId)) {
          state.verbatim_opted_memory_ids.push(action.memoryId);
          this.ui.saveGovernanceUi(state);
        }
        await this.send(chatId, "已按你的选择保留原句（明示 opt-in）。现在可以收档了。");
        await this.sendTrayCard(chatId, action.memoryId);
        return;
      }
      case "card_source": {
        await this.answer(cbId);
        const turn = this.transcripts.turnTexts(action.turnId);
        if (turn === null) {
          await this.send(chatId, "未能在转录档案中定位该轮。");
          return;
        }
        await this.send(
          chatId,
          [
            "📄 来源轮（仅所有者可见，非记忆卡正文）",
            turn.userText !== null ? `你：${clip(turn.userText, 400)}` : "（无用户文本）",
            turn.assistantText !== null ? `他：${clip(turn.assistantText, 400)}` : "",
          ].join("\n"),
        );
        return;
      }
      case "tray_edit": {
        await this.answer(cbId);
        this.session = {
          kind: "await_text",
          mode: "tray_edit",
          memoryId: action.memoryId,
          expiresAt: this.now().getTime() + SESSION_TTL_MS,
        };
        await this.send(chatId, "请发送你修改后的全文（authored_by 仍是他，会记 edited_by=owner）：");
        return;
      }
      case "later":
        await this.answer(cbId, "好，先放着。");
        return;
      case "companion_page":
        await this.answer(cbId);
        await this.showCompanionTray(chatId, action.page);
        return;
      case "cancel_session":
        this.session = null;
        await this.answer(cbId, "已取消");
        return;
    }
  }

  // ---- flows -------------------------------------------------------------

  private async startRemember(record: InboxRecord, args: string): Promise<void> {
    let evidence: ProposalEvidence = { kind: "manual" };
    let sourceNote = "manual (user-authored)";
    if (record.reply_to_message_id !== undefined) {
      const ref = this.transcripts.byTelegramMessageId(record.reply_to_message_id);
      if (ref !== null) {
        evidence = {
          kind: "transcript",
          ...ref,
          externalKey: String(record.reply_to_message_id),
        };
        sourceNote = `transcript ${ref.conversationId.slice(0, 8)}#${ref.turnId.slice(0, 8)}`;
      } else {
        sourceNote = "manual（被回复的消息不在可解析转录内——多半是他的气泡或旧消息）";
      }
    } else {
      await this.send(
        record.chat_id,
        "用法：回复一条消息再发送 /remember；不回复请用 /memory add <内容>。",
      );
      return;
    }
    if (args.trim().length > 0) {
      await this.proposeFromText(record.chat_id, args.trim(), evidence);
      return;
    }
    // Path A fork: with the drafting lane wired and a resolvable source
    // turn, Owner chooses who writes the card.
    if (this.companionPass !== null && evidence.kind === "transcript") {
      const turnId = evidence.turnId;
      await this.api.sendMessageWithKeyboard(
        record.chat_id,
        `已绑定来源（${sourceNote}）。这张记忆卡由谁来写？`,
        [
          [
            { text: "让 Companion 起草", callback_data: this.mint({ kind: "remember_draft", turnId }) },
            { text: "我自己写", callback_data: this.mint({ kind: "remember_self", turnId }) },
          ],
          [{ text: "取消", callback_data: this.mint({ kind: "cancel_session" }) }],
        ],
      );
      return;
    }
    this.session = {
      kind: "await_text",
      mode: "remember",
      evidence,
      expiresAt: this.now().getTime() + SESSION_TTL_MS,
    };
    await this.send(
      record.chat_id,
      `已绑定来源（${sourceNote}）。\n请发送你想存的记忆原文（10 分钟内有效；/memory cancel 退出）。`,
    );
  }

  private async startAdd(chatId: number, text: string): Promise<void> {
    if (text.length > 0) {
      await this.proposeFromText(chatId, text, { kind: "manual" });
      return;
    }
    this.session = {
      kind: "await_text",
      mode: "add",
      evidence: { kind: "manual" },
      expiresAt: this.now().getTime() + SESSION_TTL_MS,
    };
    await this.send(chatId, "请发送要保存的记忆原文（手动出处；10 分钟内有效）。");
  }

  /** Bracket attributes at the FRONT of the text, e.g. [scope:project]. */
  private parseAttrs(raw: string): {
    body: string;
    scope: "global" | "relationship" | "project" | "au";
    auId?: string;
    sensitivity: "normal" | "sensitive" | "intimate";
    importance: 1 | 2 | 3;
  } {
    let body = raw.trim();
    let scope: "global" | "relationship" | "project" | "au" = "relationship";
    let auId: string | undefined;
    let sensitivity: "normal" | "sensitive" | "intimate" = "normal";
    let importance: 1 | 2 | 3 = 2;
    const pattern = /^\[(scope|au|sensitivity|importance):([^\]]+)\]\s*/;
    for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
      const key = match[1];
      const value = (match[2] ?? "").trim();
      if (key === "scope" && ["global", "relationship", "project", "au"].includes(value)) {
        scope = value as typeof scope;
      } else if (key === "au") {
        scope = "au";
        auId = value;
      } else if (key === "sensitivity" && ["normal", "sensitive", "intimate"].includes(value)) {
        sensitivity = value as typeof sensitivity;
      } else if (key === "importance" && ["1", "2", "3"].includes(value)) {
        importance = Number.parseInt(value, 10) as 1 | 2 | 3;
      }
      body = body.slice(match[0].length);
    }
    return { body: body.trim(), scope, ...(auId !== undefined ? { auId } : {}), sensitivity, importance };
  }

  private async proposeFromText(
    chatId: number,
    raw: string,
    evidence: ProposalEvidence,
    museSuggestion?: string,
    museTraceId?: string,
  ): Promise<void> {
    const attrs = this.parseAttrs(raw);
    const outcome = await this.service.propose({
      body: attrs.body,
      scope: attrs.scope,
      ...(attrs.auId !== undefined ? { auId: attrs.auId } : {}),
      sensitivity: attrs.sensitivity,
      importance: attrs.importance,
      evidence,
      proposedBy: "owner",
    });
    if (outcome.status !== "ok") {
      await this.send(chatId, this.refusalText("创建候选", outcome));
      return;
    }
    if (museTraceId !== undefined) {
      // Converted proposals leave the default muse inbox for good.
      const state = this.ui.loadGovernanceUi();
      if (!state.converted_muse_trace_ids.includes(museTraceId)) {
        state.converted_muse_trace_ids.push(museTraceId);
        this.ui.saveGovernanceUi(state);
      }
    }
    const notes: string[] = [];
    if (museSuggestion !== undefined) {
      notes.push(`Muse 建议类型：${museSuggestion}（仅参考）`);
    }
    if (!outcome.backup.ok) {
      notes.push("⚠️ 候选已保存（已提交），但验证备份失败——不要重复提交；/memory backup 可安全重试。");
    }
    await this.sendPreview(chatId, outcome.memoryId, notes.length > 0 ? notes.join("\n") : undefined);
  }

  private async sendPreview(chatId: number, memoryId: string, note?: string): Promise<void> {
    const item = this.service.getCard(memoryId);
    if (item === undefined) {
      await this.send(chatId, "候选写入后未能读回——请查 /memory inbox。");
      return;
    }
    await this.api.sendMessageWithKeyboard(chatId, this.renderCard(item, note), [
      [
        { text: "✅ 批准", callback_data: this.mint({ kind: "approve", memoryId }) },
        { text: "✏️ 修改", callback_data: this.mint({ kind: "edit", memoryId }) },
      ],
      [
        { text: "🗑 驳回", callback_data: this.mint({ kind: "reject", memoryId }) },
        { text: "稍后再说", callback_data: this.mint({ kind: "cancel_session" }) },
      ],
    ]);
  }

  private renderCard(item: GovernanceItemView, note?: string): string {
    const scopeLabel =
      item.scope === "au" ? `AU（${item.au_id ?? "?"}）` : `${SCOPE_LABEL[item.scope] ?? item.scope}（ordinary）`;
    const source = this.service.sourcePointer(item.id);
    return [
      item.approval_state === "confirmed" ? "📗 已确认记忆" : "📋 记忆候选（未确认，不参与检索）",
      "────────",
      `「${item.body}」`,
      "────────",
      `标题: ${item.title}`,
      `范围: ${scopeLabel} · 敏感度: ${item.sensitivity} · 重要性: ${item.importance}`,
      `出处: ${source ?? "manual (user-authored)"}`,
      `提议/确认: ${item.approval_state === "confirmed" ? `confirmed by=${item.confirmed_by ?? "?"}` : "candidate"}`,
      `id: ${item.id.slice(0, 8)}`,
      ...(note !== undefined ? ["", note] : []),
    ].join("\n");
  }

  private async sendCardDetail(chatId: number, memoryId: string): Promise<void> {
    const item = this.service.getCard(memoryId);
    if (item === undefined) {
      await this.send(chatId, "没有这张卡。");
      return;
    }
    const rows =
      item.approval_state === "confirmed" && item.lifecycle_state === "active"
        ? [
            [
              { text: "✏️ 修订", callback_data: this.mint({ kind: "revise", memoryId }) },
              { text: "🚫 撤销", callback_data: this.mint({ kind: "revoke", memoryId }) },
            ],
          ]
        : item.approval_state === "candidate" && item.lifecycle_state === "active"
          ? [
              [
                { text: "✅ 批准", callback_data: this.mint({ kind: "approve", memoryId }) },
                { text: "✏️ 修改", callback_data: this.mint({ kind: "edit", memoryId }) },
                { text: "🗑 驳回", callback_data: this.mint({ kind: "reject", memoryId }) },
              ],
            ]
          : [];
    await this.api.sendMessageWithKeyboard(chatId, this.renderCard(item), rows);
  }

  private async showInbox(chatId: number, page: number): Promise<void> {
    const pending = this.service.listPending();
    if (pending.length === 0) {
      await this.send(chatId, "收件箱是空的：没有待确认的记忆候选。");
      return;
    }
    const pages = Math.ceil(pending.length / PAGE_SIZE);
    const current = Math.min(Math.max(page, 0), pages - 1);
    const slice = pending.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
    const lines = [`📥 待确认候选 ${pending.length} 条（第 ${current + 1}/${pages} 页）`, ""];
    const marks = ["①", "②", "③"];
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    slice.forEach((item, i) => {
      lines.push(`${marks[i]} ${clip(item.body, 90)}`);
      lines.push(`   ${item.scope}${item.au_id !== null ? `:${item.au_id}` : ""} · ${item.sensitivity} · ${item.id.slice(0, 8)}`);
      keyboard.push([
        { text: `${marks[i]} 查看`, callback_data: this.mint({ kind: "view", memoryId: item.id }) },
        { text: "✅", callback_data: this.mint({ kind: "approve", memoryId: item.id }) },
        { text: "✏️", callback_data: this.mint({ kind: "edit", memoryId: item.id }) },
        { text: "🗑", callback_data: this.mint({ kind: "reject", memoryId: item.id }) },
      ]);
    });
    if (pages > 1) {
      keyboard.push([
        ...(current > 0
          ? [{ text: "上一页", callback_data: this.mint({ kind: "inbox_page", page: current - 1 }) }]
          : []),
        ...(current < pages - 1
          ? [{ text: "下一页", callback_data: this.mint({ kind: "inbox_page", page: current + 1 }) }]
          : []),
      ]);
    }
    await this.api.sendMessageWithKeyboard(chatId, lines.join("\n"), keyboard);
  }

  private async showSearch(chatId: number, query: string): Promise<void> {
    if (query.length === 0) {
      await this.send(chatId, "用法：/memory search <关键词>");
      return;
    }
    const items = this.service.searchConfirmed(query, PAGE_SIZE);
    if (items.length === 0) {
      await this.send(chatId, "没有匹配的已确认记忆。");
      return;
    }
    const marks = ["①", "②", "③"];
    const lines = [`🔎 已确认记忆（前 ${items.length} 条）`, ""];
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    items.forEach((item, i) => {
      lines.push(`${marks[i]} ${clip(item.body, 90)}`);
      keyboard.push([
        { text: `${marks[i]} 查看`, callback_data: this.mint({ kind: "view", memoryId: item.id }) },
        { text: "✏️ 修订", callback_data: this.mint({ kind: "revise", memoryId: item.id }) },
        { text: "🚫 撤销", callback_data: this.mint({ kind: "revoke", memoryId: item.id }) },
      ]);
    });
    await this.api.sendMessageWithKeyboard(chatId, lines.join("\n"), keyboard);
  }

  private async showCard(chatId: number, idPrefix: string): Promise<void> {
    const item = this.service.findByIdPrefix(idPrefix);
    if (item === undefined) {
      await this.send(chatId, "没有唯一匹配的卡（id 前缀至少 6 位）。日常操作请直接用 inbox/search 的按钮。");
      return;
    }
    await this.sendCardDetail(chatId, item.id);
  }

  /**
   * Amendment 3: the DEFAULT muse inbox shows only unreviewed proposals
   * newer than the activation watermark, as type + pointer + source
   * STATUS — never inline transcript text. Bodies appear only through
   * the explicit [查看原文] action. `/memory muse all` opens the
   * historical backlog (still excluding dismissed/converted).
   */
  private async showMuse(chatId: number, page: number, includeBacklog: boolean): Promise<void> {
    if (this.muse === null) {
      await this.send(chatId, "Muse 路标源未接线（影子关闭或无 trace 文件）。");
      return;
    }
    const state = this.ui.loadGovernanceUi();
    const dismissed = new Set(state.dismissed_muse_trace_ids);
    const converted = new Set(state.converted_muse_trace_ids);
    const watermark = state.muse_watermark ?? 0;
    const proposals = this.muse
      .list()
      .filter((p) => !dismissed.has(p.traceId) && !converted.has(p.traceId))
      .filter((p) => includeBacklog || p.seq >= watermark)
      .reverse();
    if (proposals.length === 0) {
      await this.send(
        chatId,
        includeBacklog
          ? "没有未处理的 Muse 路标（含历史）。"
          : "没有新的 Muse 路标（历史积压用 /memory muse all）。",
      );
      return;
    }
    const pages = Math.ceil(proposals.length / PAGE_SIZE);
    const current = Math.min(Math.max(page, 0), pages - 1);
    const slice = proposals.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
    const marks = ["①", "②", "③"];
    const lines = [
      `🧭 Muse 路标 ${proposals.length} 条（第 ${current + 1}/${pages} 页${includeBacklog ? "，含历史积压" : ""}）`,
      "NOT MEMORY / UNCONFIRMED —— 原文须点 [查看原文]。",
      "",
    ];
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    slice.forEach((p, i) => {
      const located = this.transcripts.turnTexts(p.turnId) !== null;
      lines.push(
        `${marks[i]} [${p.memoryAction}] · turn ${p.turnId.slice(0, 8)} · ${located ? "来源已定位" : "来源未定位"}`,
      );
      // Pre-merge patch #3: Muse flow is review-only. Without the lane
      // the pointer stays unreviewed (view/dismiss only) — there is no
      // direct-minting fallback and Muse can never bypass Companion.
      keyboard.push([
        ...(this.companionPass !== null
          ? [
              {
                text: `${marks[i]} 请Companion审`,
                callback_data: this.mint({
                  kind: "muse_review",
                  traceId: p.traceId,
                  turnId: p.turnId,
                  memoryAction: p.memoryAction,
                }),
              },
            ]
          : []),
        { text: "查看原文", callback_data: this.mint({ kind: "muse_source", turnId: p.turnId }) },
        { text: "忽略", callback_data: this.mint({ kind: "muse_dismiss", traceId: p.traceId }) },
      ]);
    });
    if (pages > 1) {
      keyboard.push([
        ...(current > 0
          ? [
              {
                text: "上一页",
                callback_data: this.mint({ kind: "muse_page", page: current - 1, all: includeBacklog }),
              },
            ]
          : []),
        ...(current < pages - 1
          ? [
              {
                text: "下一页",
                callback_data: this.mint({ kind: "muse_page", page: current + 1, all: includeBacklog }),
              },
            ]
          : []),
      ]);
    }
    await this.api.sendMessageWithKeyboard(chatId, lines.join("\n"), keyboard);
  }

  // ---- three-paths: drafting lane + Companion tray ---------------------------

  private evidenceForTurn(turnId: string): ProposalEvidence {
    const turn = this.transcripts.turnTexts(turnId);
    if (turn !== null && turn.conversationId !== null && turn.userMessageId !== null) {
      return {
        kind: "transcript",
        conversationId: turn.conversationId,
        turnId,
        messageId: turn.userMessageId,
      };
    }
    return { kind: "manual" };
  }

  private turnIdFromPointer(pointer: string | null): string | null {
    if (pointer === null) {
      return null;
    }
    const match = /#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//.exec(pointer);
    return match?.[1] ?? null;
  }

  /**
   * Summary-rule guard (2026-07-13): a pending card "needs redraft" when
   * its body overlaps the source transcript verbatim beyond the
   * threshold AND the owner has not explicitly opted into verbatim
   * storage. Such a card must not be filed as-is — Companion regenerates a
   * summary, or Owner presses [保留原句]. Confirmed cards are never
   * evaluated here; an unresolvable source cannot prove a copy, so it
   * does not block. Reads the transcript archive (provenance resolution),
   * never logs it.
   */
  private cardNeedsRedraft(item: GovernanceItemView): boolean {
    if (item.approval_state !== "candidate") {
      return false;
    }
    if (this.ui.loadGovernanceUi().verbatim_opted_memory_ids.includes(item.id)) {
      return false;
    }
    const sourceTurn = this.turnIdFromPointer(this.service.sourcePointer(item.id));
    if (sourceTurn === null) {
      return false;
    }
    const turn = this.transcripts.turnTexts(sourceTurn);
    if (turn === null) {
      return false;
    }
    const overlap = verbatimOverlap(item.body, `${turn.userText ?? ""}\n${turn.assistantText ?? ""}`);
    return overlap >= VERBATIM_OVERLAP_THRESHOLD;
  }

  /** Paths A/C: directed persona drafting against a frozen source turn. */
  private async runDraftFlow(
    chatId: number,
    turnId: string,
    kind: "owner_requested" | "muse_review",
    museAction?: string,
  ): Promise<void> {
    const pass = this.companionPass;
    if (pass === null) {
      await this.send(chatId, "起草通道未接线（DELOS_COMPANION_PROPOSALS 关闭）。");
      return;
    }
    const entry = pass.buildDirectedEntry(
      turnId,
      kind,
      museAction !== undefined ? { museAction } : undefined,
    );
    if (entry === null) {
      await this.send(chatId, "未能在转录档案中定位来源轮（完整性保护，未起草）。");
      return;
    }
    await this.send(chatId, kind === "muse_review" ? "已请他审阅这条路标…" : "他在想怎么写…");
    const outcome = await pass.runDirected(entry);
    switch (outcome.result) {
      case "proposed":
        await this.sendTrayCard(
          chatId,
          outcome.memoryId,
          kind === "muse_review" ? "他审完，收下了这条建议并亲笔写了卡" : "他起草好了",
        );
        return;
      case "declined":
        await this.send(
          chatId,
          kind === "muse_review"
            ? `他看过了，觉得不必记：${outcome.note}`
            : `他想了想，觉得这轮不必单独立卡：${outcome.note}`,
        );
        return;
      case "duplicate":
        await this.send(chatId, "这一轮已经有一张卡了（每个来源轮至多一张）。见 /memory companion 或 inbox。");
        return;
      case "skipped_budget":
        await this.send(chatId, this.passLimitText(outcome.reason));
        return;
      case "skipped_integrity":
        await this.send(chatId, "来源轮校验未通过（缺档或哈希不符），按完整性保护未起草。");
        return;
      case "needs_redraft":
        await this.send(
          chatId,
          "他这一版写得太贴近原文了（记忆卡要的是摘要，不是誊本），已按规则挡下、没有立卡。可以再请他写一次，或用 /remember 自己写。",
        );
        return;
      case "failed":
        await this.send(chatId, `起草失败：${outcome.reason.slice(0, 120)}。聊天不受影响。`);
        return;
    }
  }

  /**
   * Human-facing wording for owner-lane budget/breaker refusals. Raw
   * reason codes stay in metadata-only audit — they are never the
   * primary Telegram message.
   */
  private passLimitText(reason: string): string {
    if (reason === "breaker_open") {
      return "起草通道刚连续遇到几次模型故障，正在冷却（约半小时后自动恢复）。聊天不受影响，稍后再请他起草。";
    }
    return "他这一小时里受邀起草的次数用完了，稍等片刻再请他写；你也可以随时选「我自己写」。";
  }

  /** One Companion-authored pending proposal, with its decision buttons. */
  private async sendTrayCard(chatId: number, memoryId: string, note?: string): Promise<void> {
    const item = this.service.getCard(memoryId);
    if (item === undefined) {
      await this.send(chatId, "这张卡不存在了。");
      return;
    }
    const pointer = this.service.sourcePointer(item.id);
    const sourceTurn = this.turnIdFromPointer(pointer);
    const needsRedraft = this.cardNeedsRedraft(item);
    // Summary rule: a raw-copy card is not directly fileable — replace
    // 收档 with a redraft / explicit verbatim opt-in. The body shown is
    // the SUMMARY; the source stays behind [查看原文].
    const primary: Array<{ text: string; callback_data: string }> = needsRedraft
      ? [
          ...(sourceTurn !== null
            ? [{ text: "🔁 让他重写", callback_data: this.mint({ kind: "redraft", memoryId, turnId: sourceTurn }) }]
            : []),
          { text: "📌 保留原句", callback_data: this.mint({ kind: "keep_verbatim", memoryId }) },
        ]
      : [
          { text: "📥 收档", callback_data: this.mint({ kind: "file_it", memoryId }) },
          ...(sourceTurn !== null
            ? [{ text: "↩️ 打回", callback_data: this.mint({ kind: "return_it", memoryId, turnId: sourceTurn }) }]
            : []),
        ];
    const buttons: Array<{ text: string; callback_data: string }> = [
      ...primary,
      { text: "✏️ 改", callback_data: this.mint({ kind: "tray_edit", memoryId }) },
      ...(sourceTurn !== null
        ? [{ text: "查看原文", callback_data: this.mint({ kind: "card_source", turnId: sourceTurn }) }]
        : []),
    ];
    await this.api.sendMessageWithKeyboard(
      chatId,
      [
        "🖋 Companion wants to remember:",
        "────────",
        `「${item.body}」`,
        "────────",
        ...(item.tags_text.trim().length > 0 ? [`标签: ${item.tags_text.trim()}`] : []),
        `出处: ${pointer ?? "manual"}`,
        `作者: companion（收档后 confirmed_by=owner，authorship 不变）`,
        `状态: ${item.approval_state} · ${item.scope} · ${item.sensitivity} · id ${item.id.slice(0, 8)}`,
        ...(needsRedraft ? ["⚠️ 这版太贴近原文——记忆卡应是摘要。先让他重写，或明确保留原句。"] : []),
        ...(note !== undefined ? ["", note] : []),
      ].join("\n"),
      [
        buttons,
        [
          { text: "稍后", callback_data: this.mint({ kind: "later" }) },
          { text: "🗑 不留", callback_data: this.mint({ kind: "reject", memoryId }) },
        ],
      ],
    );
  }

  private async showCompanionTray(chatId: number, page: number): Promise<void> {
    const pending = this.service
      .listPending()
      .filter((item) => parseProvenance(item)?.authored_by === "companion");
    const counters = this.companionPass?.counters();
    const counterLine = (label: string, c: {
      attempted: number; proposed: number; declined: number; duplicate: number;
      skipped_budget: number; skipped_integrity: number; failed: number;
    }): string =>
      `${label}: 尝试${c.attempted} 提案${c.proposed} 拒答${c.declined} 重复${c.duplicate} 预算跳${c.skipped_budget} 完整性跳${c.skipped_integrity} 失败${c.failed}`;
    const footer =
      counters !== undefined
        ? [
            counterLine("通道计数·他自发（B）", counters.autonomous),
            counterLine("通道计数·你请他（A/C）", counters.owner_initiated),
          ].join("\n")
        : "起草通道未接线（只读展示）。";
    if (pending.length === 0) {
      await this.send(chatId, `他的提案托盘是空的。\n${footer}`);
      return;
    }
    const pages = Math.ceil(pending.length / PAGE_SIZE);
    const current = Math.min(Math.max(page, 0), pages - 1);
    const slice = pending.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
    const marks = ["①", "②", "③"];
    const lines = [`🖋 Companion 想记住的（${pending.length} 条待收档，第 ${current + 1}/${pages} 页）`, ""];
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    slice.forEach((item, i) => {
      const roles = parseProvenance(item);
      const needsRedraft = this.cardNeedsRedraft(item);
      // Summary first: the compact body shown here IS the summary; the
      // full source stays behind [原文]. A raw-copy card is flagged and
      // is not directly fileable.
      lines.push(`${marks[i]} ${needsRedraft ? "⚠️ " : ""}${clip(item.body, 90)}`);
      lines.push(
        `   ${roles?.source_basis ?? "?"} · ${item.scope} · ${item.sensitivity}${item.tags_text.trim().length > 0 ? ` · #${item.tags_text.trim().split(/\s+/).join(" #")}` : ""} · ${item.id.slice(0, 8)}`,
      );
      const pointer = this.service.sourcePointer(item.id);
      const sourceTurn = this.turnIdFromPointer(pointer);
      keyboard.push([
        ...(needsRedraft
          ? [
              ...(sourceTurn !== null
                ? [{ text: `${marks[i]} 🔁重写`, callback_data: this.mint({ kind: "redraft", memoryId: item.id, turnId: sourceTurn }) }]
                : []),
              { text: "📌原句", callback_data: this.mint({ kind: "keep_verbatim", memoryId: item.id }) },
            ]
          : [
              { text: `${marks[i]} 📥`, callback_data: this.mint({ kind: "file_it", memoryId: item.id }) },
              ...(sourceTurn !== null
                ? [{ text: "↩️", callback_data: this.mint({ kind: "return_it", memoryId: item.id, turnId: sourceTurn }) }]
                : []),
            ]),
        { text: "✏️", callback_data: this.mint({ kind: "tray_edit", memoryId: item.id }) },
        { text: "🗑", callback_data: this.mint({ kind: "reject", memoryId: item.id }) },
        ...(sourceTurn !== null
          ? [{ text: "原文", callback_data: this.mint({ kind: "card_source", turnId: sourceTurn }) }]
          : []),
      ]);
    });
    if (pages > 1) {
      keyboard.push([
        ...(current > 0
          ? [{ text: "上一页", callback_data: this.mint({ kind: "companion_page", page: current - 1 }) }]
          : []),
        ...(current < pages - 1
          ? [{ text: "下一页", callback_data: this.mint({ kind: "companion_page", page: current + 1 }) }]
          : []),
      ]);
    }
    lines.push("", footer);
    await this.api.sendMessageWithKeyboard(chatId, lines.join("\n"), keyboard);
  }

  // ---- small helpers -----------------------------------------------------

  private refusalText(
    op: string,
    outcome:
      | { status: "refused"; issues: Array<{ path: string; message: string }> }
      | { status: "already"; detail: string },
  ): string {
    if (outcome.status === "already") {
      return `ℹ️ ${op}：${outcome.detail}`;
    }
    return `⛔ ${op}被拒绝：\n${outcome.issues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}`;
  }

  private mint(action: PendingAction): string {
    this.prune();
    const nonce = randomUUID();
    this.nonces.set(nonce, {
      action,
      expiresAt: this.now().getTime() + NONCE_TTL_MS,
      used: false,
    });
    return `g1:${nonce}`;
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [nonce, entry] of this.nonces) {
      if (entry.expiresAt < now) {
        this.nonces.delete(nonce);
      }
    }
  }

  private async send(chatId: number, text: string): Promise<void> {
    try {
      await this.api.sendMessage(chatId, text);
    } catch (error) {
      this.log(`governance send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async answer(cbId: string, text?: string): Promise<void> {
    try {
      await this.api.answerCallbackQuery(cbId, text);
    } catch (error) {
      this.log(`governance answer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
