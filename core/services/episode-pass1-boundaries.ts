/**
 * L1-T02 Pass1 boundary evaluation (§2.1.5 / §2.2 / §2.4 / §2.5.2 windows).
 * Pure and deterministic. Compiles boundary overrides into forced
 * constraints (append-order LATEST-WINS per anchor turn — Erratum 2), judges
 * realm/basis for windows (lexical+prior parts only), identifies proactive
 * blocks and evaluates the P-0 rules over the COMPLETE block (Erratum 3), and
 * decides episode boundaries per the §2.2.7 resolution and §2.2.8 suppression
 * order.
 *
 * Continuation link RESOLUTION and per-episode realm inheritance (step 2) are
 * the engine's job (§2.8 global pass); this module produces the cut set,
 * per-boundary strength/causes, continuation-cue markers, and topic-shift
 * notes. The typed fiction meta/exit trace is emitted at segment assembly by
 * the engine (Erratum 4) from `evalFiction` over each episode's turns.
 */

import type {
  Pass1Config,
  Pass1OverrideRecord,
  Pass1OverrideState,
} from "../domain/episode-pass1.js";
import type { Pass1Turn } from "../domain/episode-pass1.js";
import { validateBoundaryEvent } from "../domain/episode-validation.js";
import { isEnabledOverrideAuthor } from "../domain/episode.js";
import type { Realm, RealmBasis, Sensitivity } from "../domain/episode.js";
import { maxSensitivity } from "../domain/episode.js";
import { auHitIds, contentWords, evalFiction, messageStartsWithAny, scoreAu, scoreSensitivity, textContains } from "./episode-pass1-lexicon.js";

// ---------------------------------------------------------------------------
// Realm window judgment (§2.5.2 steps 1/3/4/5 — NO inheritance)
// ---------------------------------------------------------------------------

export interface RealmJudgment {
  realm: Realm;
  basis: RealmBasis;
  auId: string | null;
}

function combineText(turns: readonly Pass1Turn[]): string {
  const parts: string[] = [];
  for (const t of turns) for (const m of t.messages) parts.push(m.contentNfc);
  return parts.join("\n");
}

export function judgeRealmLexicalPrior(
  turns: readonly Pass1Turn[],
  config: Pass1Config,
  conversationId: string,
): RealmJudgment {
  const text = combineText(turns);
  const au = scoreAu(text, config.lexicons.au, config.thresholds);
  if (au.qualifies) return { realm: "au", basis: "au_lexicon", auId: au.winner };
  const fic = evalFiction(turns, config.lexicons.au, config.lexicons.fiction);
  if (fic.enactmentValid || (au.meetsAssign && !au.qualifies)) {
    return { realm: "uncertain", basis: "fiction_signal", auId: null };
  }
  const cfg = config.defaultRealms.entries.find((e) => e.conversation_id === conversationId);
  if (cfg !== undefined) {
    return { realm: cfg.default_realm, basis: "configured_prior", auId: cfg.default_realm === "au" ? cfg.au_id : null };
  }
  return { realm: "uncertain", basis: "no_evidence", auId: null };
}

const isFictionSide = (j: RealmJudgment): boolean =>
  j.basis === "au_lexicon" || j.basis === "fiction_signal" || (j.basis === "configured_prior" && j.realm === "au");
const isRealitySide = (j: RealmJudgment): boolean => j.basis === "configured_prior" && j.realm === "reality";

/** S3 boundary by realm_basis comparison (§2.2 Table A). no_evidence is never a boundary. */
function s3Boundary(front: RealmJudgment, back: RealmJudgment): boolean {
  if (front.basis === "no_evidence" || back.basis === "no_evidence") return false;
  // au_lexicon ↔ au_lexicon: cut iff different au_id
  if (front.basis === "au_lexicon" && back.basis === "au_lexicon") return front.auId !== back.auId;
  // au_lexicon ↔ configured_prior(au=Y): cut iff Y≠X
  const auVsCfgAu = (a: RealmJudgment, b: RealmJudgment): boolean | null =>
    a.basis === "au_lexicon" && b.basis === "configured_prior" && b.realm === "au" ? a.auId !== b.auId : null;
  const c1 = auVsCfgAu(front, back);
  if (c1 !== null) return c1;
  const c2 = auVsCfgAu(back, front);
  if (c2 !== null) return c2;
  // reality ↔ any fiction-side (au_lexicon / fiction_signal / configured_prior(au)) → cut
  if (isRealitySide(front) && isFictionSide(back)) return true;
  if (isRealitySide(back) && isFictionSide(front)) return true;
  // same side (both fiction-side non-differing, or both reality) → no cut
  return false;
}

/** realm compatibility for proactive merge (§2.4): same effective realm value, and if both au then same au_id. */
export function realmCompatible(a: RealmJudgment, b: RealmJudgment): boolean {
  if (a.realm !== b.realm) return false;
  if (a.realm === "au") return a.auId === b.auId;
  return true;
}

// ---------------------------------------------------------------------------
// Content sensitivity of a turn span (§2.2.8 window upgrade gate). Uses the
// SAME exact/prefix matcher as the rest of Pass1 (Erratum 1). This is the
// WINDOW proxy used for the merge "sensitivity upgrade" comparison; the final
// row sensitivity (§2.5.4, resolved-realm) is computed in the engine.
// ---------------------------------------------------------------------------

const SENS_RANK: Record<Sensitivity, number> = { normal: 0, sensitive: 1, intimate: 2 };

export function contentSensitivity(turns: readonly Pass1Turn[], config: Pass1Config): Sensitivity {
  let level: Sensitivity = "normal";
  for (const t of turns) {
    for (const m of t.messages) {
      level = maxSensitivity(level, scoreSensitivity(m.contentNfc, config.lexicons.sensitivity));
      for (const au of config.lexicons.au.entries) {
        const hit = [...au.unique_terms, ...au.shared_terms].some((term) => textContains(m.contentNfc, term));
        if (hit) level = maxSensitivity(level, au.default_sensitivity);
      }
    }
  }
  return level;
}

// ---------------------------------------------------------------------------
// Boundary override compilation (§2.1.5) — append-order LATEST-WINS per anchor
// ---------------------------------------------------------------------------

export interface Pass1OverrideEvent {
  raw: Record<string, unknown>;
  order: number;
}

export interface LinkDirective {
  op: "link_continuation" | "unlink_continuation";
  override_id: string;
  /** Index of this event's record in CompiledOverrides.records — the accounting
   * binding is positional, never by override_id (ids can repeat; C1). */
  recordIdx: number;
  anchorConversationId: string;
  anchorMessageId: string;
  targetConversationId: string | null;
  targetMessageId: string | null;
}

export interface CompiledOverrides {
  /** turnKey → force a boundary before this turn (manual split). */
  forcedSplit: Set<string>;
  /** turnKey → suppress any auto boundary before this turn (manual merge). */
  forcedMerge: Set<string>;
  links: LinkDirective[];
  records: Pass1OverrideRecord[];
  deferredFieldCount: number;
}

interface MessageLocation {
  turnKey: string;
  isTurnFirst: boolean;
}

/** Build a (conversationId, messageId) → turn location index. */
export function buildMessageIndex(partitions: ReadonlyArray<{ conversationId: string; turns: readonly Pass1Turn[] }>): Map<string, MessageLocation> {
  const index = new Map<string, MessageLocation>();
  for (const p of partitions) {
    for (const turn of p.turns) {
      turn.messages.forEach((m, i) => {
        index.set(`${p.conversationId} ${m.messageId}`, { turnKey: turn.turnKey, isTurnFirst: i === 0 });
      });
    }
  }
  return index;
}

export function compileBoundaryOverrides(
  events: readonly Pass1OverrideEvent[],
  messageIndex: ReadonlyMap<string, MessageLocation>,
): CompiledOverrides {
  const forcedSplit = new Set<string>();
  const forcedMerge = new Set<string>();
  const links: LinkDirective[] = [];
  const records: Pass1OverrideRecord[] = [];
  let deferredFieldCount = 0;

  // Per anchor turnKey: record index of the current (latest) winner + its op.
  // Earlier same-anchor split/merge events are flipped to no_op; only the last
  // survives as `applied`, and the set membership is materialized from that
  // winner op after the loop (Erratum 2: append-order latest-wins).
  const latestByTurn = new Map<string, number>();
  const latestOpByTurn = new Map<string, "split" | "merge">();

  const ordered = [...events].sort((a, b) => a.order - b.order);
  for (const ev of ordered) {
    const raw = ev.raw;
    if (raw["kind"] === "field") {
      deferredFieldCount += 1;
      continue;
    }
    const result = validateBoundaryEvent(raw);
    const overrideId = typeof raw["override_id"] === "string" ? raw["override_id"] : `ov-order-${ev.order}`;
    const op = typeof raw["op"] === "string" ? raw["op"] : "unknown";
    const pushRecord = (state: Pass1OverrideState, target: string, detail: string | null): number => {
      records.push({ override_id: overrideId, kind: "boundary", op, target, state, detail });
      return records.length - 1;
    };
    if (!result.ok) {
      pushRecord("needs_review", "-", "invalid_shape");
      continue;
    }
    const author = raw["author"];
    if (typeof author !== "string" || !isEnabledOverrideAuthor(author)) {
      pushRecord("needs_review", "-", "author_not_enabled");
      continue;
    }
    const anchor = raw["anchor"] as { conversation_id?: unknown; message_id?: unknown };
    const anchorConv = typeof anchor.conversation_id === "string" ? anchor.conversation_id : "";
    const anchorMsg = typeof anchor.message_id === "string" ? anchor.message_id : "";
    const loc = messageIndex.get(`${anchorConv} ${anchorMsg}`);
    if (loc === undefined) {
      pushRecord("unmatched", `${anchorConv}/${anchorMsg}`, "anchor_not_found");
      continue;
    }
    const winSplitMerge = (opKind: "split" | "merge", detail: string | null): void => {
      const idx = pushRecord("applied", loc.turnKey, detail);
      const prev = latestByTurn.get(loc.turnKey);
      if (prev !== undefined) records[prev]!.state = "no_op";
      latestByTurn.set(loc.turnKey, idx);
      latestOpByTurn.set(loc.turnKey, opKind);
    };
    if (op === "split_before_message") {
      winSplitMerge("split", loc.isTurnFirst ? null : "anchor_normalized_to_turn_start");
    } else if (op === "merge_adjacent") {
      winSplitMerge("merge", null);
    } else if (op === "link_continuation" || op === "unlink_continuation") {
      const lt = raw["link_target"] as { conversation_id?: unknown; message_id?: unknown } | undefined;
      // Link/unlink final state is set by the engine after link resolution
      // (same-anchor latest-wins, C1); the record binding is positional.
      const recordIdx = pushRecord("applied", loc.turnKey, `${op}_pending`);
      links.push({
        op,
        override_id: overrideId,
        recordIdx,
        anchorConversationId: anchorConv,
        anchorMessageId: anchorMsg,
        targetConversationId: lt && typeof lt.conversation_id === "string" ? lt.conversation_id : null,
        targetMessageId: lt && typeof lt.message_id === "string" ? lt.message_id : null,
      });
    } else {
      pushRecord("needs_review", "-", "unknown_op");
    }
  }

  // Materialize the forced sets from ONLY the latest winner op per anchor turn.
  // A merge→split anchor ends as split; split→merge ends as merge.
  for (const [turnKey, op] of latestOpByTurn) {
    if (op === "split") {
      forcedMerge.delete(turnKey);
      forcedSplit.add(turnKey);
    } else {
      forcedSplit.delete(turnKey);
      forcedMerge.add(turnKey);
    }
  }
  return { forcedSplit, forcedMerge, links, records, deferredFieldCount };
}

// ---------------------------------------------------------------------------
// Boundary decision (§2.2 / §2.4)
// ---------------------------------------------------------------------------

export interface BoundaryStrength {
  strength: number;
  causes: string[];
}

export interface EvaluatedBoundaries {
  /** Sorted turn indices that START an episode; always includes 0 and turns.length. */
  boundaryIndices: number[];
  strengthByIndex: Map<number, BoundaryStrength>;
  /** Boundary-context notes (continuation_cue at S1 no-cut, topic_shift at S5). */
  annotations: Array<{ turnIndex: number; message_id: string; kind: "continuation_cue" | "topic_shift"; rule_code: string }>;
  /** Turn indices that begin an S1-cut episode + the cue message that links it. */
  s1Links: Array<{ turnIndex: number; message_id: string }>;
}

function windowSlice(turns: readonly Pass1Turn[], start: number, end: number): Pass1Turn[] {
  return turns.slice(Math.max(0, start), Math.min(turns.length, end));
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function evaluateBoundaries(
  turns: readonly Pass1Turn[],
  conversationId: string,
  compiled: CompiledOverrides,
  config: Pass1Config,
): EvaluatedBoundaries {
  const n = turns.length;
  const K = config.thresholds.windowTurns;
  const stopwords = new Set(config.lexicons.stopwords.words);
  const boundaryIndices: number[] = [0];
  const strengthByIndex = new Map<number, BoundaryStrength>();
  strengthByIndex.set(0, { strength: 1.0, causes: ["S6"] });
  strengthByIndex.set(n, { strength: 1.0, causes: ["S6"] });
  const annotations: EvaluatedBoundaries["annotations"] = [];
  const s1Links: EvaluatedBoundaries["s1Links"] = [];

  const judge = (span: readonly Pass1Turn[]): RealmJudgment => judgeRealmLexicalPrior(span, config, conversationId);

  // proactive blocks: maximal runs of proactive turns. blockEndByFront maps the
  // front index → the last (inclusive) block turn index, so P-0 can evaluate
  // realm/sensitivity over the COMPLETE block (Erratum 3).
  const inBlockInterior = new Set<number>();
  const blockFront = new Set<number>();
  const blockTail = new Set<number>();
  const blockEndByFront = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    if (turns[i]!.proactive && (i === 0 || !turns[i - 1]!.proactive)) {
      let j = i;
      while (j + 1 < n && turns[j + 1]!.proactive) j += 1;
      blockFront.add(i);
      blockEndByFront.set(i, j);
      if (j + 1 <= n) blockTail.add(j + 1);
      for (let k = i + 1; k <= j; k += 1) inBlockInterior.add(k);
    }
  }

  const state = { segStart: 0 };
  const cut = (i: number, strength: number, causes: string[]): void => {
    boundaryIndices.push(i);
    strengthByIndex.set(i, { strength, causes });
    state.segStart = i;
  };

  for (let i = 1; i < n; i += 1) {
    const prev = turns[i - 1]!;
    const cur = turns[i]!;
    const gapMin = (cur.startedAtEpochMs - prev.endedAtEpochMs) / 60000;

    if (compiled.forcedSplit.has(cur.turnKey)) {
      cut(i, 1.0, ["manual_split"]);
      continue;
    }
    const merged = compiled.forcedMerge.has(cur.turnKey);
    if (inBlockInterior.has(i)) continue; // P-1: never split inside a proactive block

    // exit validity for cur, evaluated over a window that includes prior turns
    // so an adjacent-turn weak exit can ground on them; the boundary only lands
    // before the turn actually carrying the exit hit (Erratum 4c).
    const exitWin = windowSlice(turns, i - K, i + 1);
    const curExitValid = evalFiction(exitWin, config.lexicons.au, config.lexicons.fiction).exitValidTurnKeys.has(cur.turnKey);

    // current segment (front side of the candidate point)
    const segTurns = windowSlice(turns, state.segStart, i);
    const segJ = judge(segTurns);
    const segSens = contentSensitivity(segTurns, config);

    // --- proactive block-front point (P-0): current segment ↔ COMPLETE block ---
    if (blockFront.has(i)) {
      const j = blockEndByFront.get(i)!;
      const blockTurns = windowSlice(turns, i, j + 1);
      const blockJ = judge(blockTurns);
      const blockSens = contentSensitivity(blockTurns, config);
      const s3 = !merged && s3Boundary(segJ, blockJ);
      const exitCut = !merged && isFictionSide(segJ) && curExitValid;
      const sensUpgrade = SENS_RANK[blockSens] > SENS_RANK[segSens];
      if (s3 || exitCut) {
        cut(i, 0.9, [s3 ? "S3" : "S3_exit"]);
      } else if (merged || (realmCompatible(blockJ, segJ) && gapMin < config.thresholds.gapSoftMinutes && !sensUpgrade)) {
        // merge the block into the current segment (S2/S5 not evaluated)
      } else {
        cut(i, 0.9, ["S4"]);
      }
      continue;
    }

    // --- proactive block-tail point (P-0): segment (block) ↔ Owner reply side ---
    if (blockTail.has(i)) {
      const replyWin = windowSlice(turns, i, i + K);
      const replyJ = judge(replyWin);
      const replySens = contentSensitivity([cur], config);
      const s3 = !merged && s3Boundary(segJ, replyJ);
      const exitCut = !merged && isFictionSide(segJ) && curExitValid;
      const sensUpgrade = SENS_RANK[replySens] > SENS_RANK[segSens];
      if (merged || (!s3 && !exitCut && gapMin < config.thresholds.gapHardMinutes && realmCompatible(segJ, replyJ) && !sensUpgrade)) {
        continue; // Owner reply merges into the proactive segment
      }
      // otherwise fall through to the normal cascade
    }

    // --- normal resolution cascade (§2.2.7 / §2.2.8) ---
    const frontWin = windowSlice(turns, i - K, i);
    const backWin = windowSlice(turns, i, i + K);
    const frontJ = judge(frontWin);
    const backJ = judge(backWin);
    const s3 = !merged && s3Boundary(frontJ, backJ);
    const exitCut = !merged && isFictionSide(frontJ) && curExitValid;
    if (s3 || exitCut) {
      cut(i, 0.9, [s3 ? "S3" : "S3_exit"]);
      continue;
    }
    const cueHit = cur.messages.length > 0 && messageStartsWithAny(cur.messages[0]!.contentNfc, config.lexicons.continuation.terms);
    const cueMsgId = cur.messages[0]?.messageId ?? "";
    if (cueHit) {
      const realmConsistent = !exitCut && !cueHasForeignFiction(cur, segJ.auId, config);
      const candSens = contentSensitivity([cur], config);
      const sensUpgrade = SENS_RANK[candSens] > SENS_RANK[segSens];
      if (gapMin < config.thresholds.gapSoftMinutes && realmConsistent && !sensUpgrade) {
        annotations.push({ turnIndex: i, message_id: cueMsgId, kind: "continuation_cue", rule_code: "S1_no_cut" });
        continue;
      }
      cut(i, 0.9, ["S1_cut"]);
      s1Links.push({ turnIndex: i, message_id: cueMsgId });
      continue;
    }
    if (!merged && gapMin >= config.thresholds.gapHardMinutes) {
      cut(i, 0.95, ["S2_hard"]);
      continue;
    }
    const softGap = gapMin >= config.thresholds.gapSoftMinutes && gapMin < config.thresholds.gapHardMinutes;
    const topicShift = jaccard(contentWords(combineText(frontWin), stopwords), contentWords(combineText(backWin), stopwords)) < config.thresholds.topicJaccardMin;
    if (topicShift && !softGap) {
      annotations.push({ turnIndex: i, message_id: cueMsgId, kind: "topic_shift", rule_code: "S5_topic_note" });
    }
    if (!merged && softGap && topicShift) {
      cut(i, 0.6, ["S5"]);
      continue;
    }
    // no boundary
  }

  boundaryIndices.sort((a, b) => a - b);
  return { boundaryIndices, strengthByIndex, annotations, s1Links };
}

/**
 * The cue turn carries independent foreign-fiction evidence: an enactment valid
 * hit, or an AU term belonging to some OTHER AU than the current segment's
 * au_id (Erratum 4a — the current segment's own AU terms are NOT a conflict;
 * §2.5.5 rule / S1 condition 3). A null segment au_id means any AU hit is foreign.
 */
function cueHasForeignFiction(turn: Pass1Turn, segAuId: string | null, config: Pass1Config): boolean {
  const fic = evalFiction([turn], config.lexicons.au, config.lexicons.fiction);
  if (fic.enactmentValid) return true;
  const text = combineText([turn]);
  return auHitIds(text, config.lexicons.au).some((id) => id !== segAuId);
}
