/**
 * L1-T02 Pass1 lexical evaluation (§2.5 / §5.4 / §5.5). Pure, deterministic,
 * no regex — only NFC + case-folded EXACT/PREFIX term matching (Erratum 1:
 * a term hit must begin at a token boundary; embedded/suffix substrings of a
 * longer Latin/digit run never fire), integer scoring, and fixed-window
 * co-occurrence checks.
 *
 * Provides: content-word extraction (entities_lexical + S5 Jaccard), AU
 * scoring, weighted content-lexicon scoring, sensitivity, continuation-cue
 * matching, and typed-fiction evaluation (strong/weak, cooccur, negctx) over
 * a contiguous turn list — message-granular so `same_message` cooccur is
 * strictly one message (Erratum 4), reporting the actual meta/exit hits
 * (message_id + rule_code) for the typed trace.
 */

import type { Pass1Turn } from "../domain/episode-pass1.js";
import type {
  AuLexicon,
  FictionLexicon,
  FictionSignalEntry,
  Pass1Thresholds,
  SensitivityLexicon,
  WeightedLexicon,
} from "../domain/episode-pass1.js";
import { maxSensitivity, type Sensitivity } from "../domain/episode.js";

// ---------------------------------------------------------------------------
// Character classes + content words
// ---------------------------------------------------------------------------

const isLatinDigit = (ch: string): boolean => /^[A-Za-z0-9]$/.test(ch);

function isCjk(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf);
}

/**
 * Content words in first-appearance order (may repeat): maximal Latin/digit
 * runs (lower-cased, length ≥2) and adjacent CJK bigrams, minus versioned
 * stopwords (§5.5). Deterministic; no sampling, no truncation.
 */
export function contentWords(text: string, stopwords: ReadonlySet<string>): string[] {
  const chars = [...text.normalize("NFC")];
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (isLatinDigit(ch)) {
      let word = "";
      while (i < chars.length && isLatinDigit(chars[i]!)) {
        word += chars[i]!.toLowerCase();
        i += 1;
      }
      if (word.length >= 2 && !stopwords.has(word)) out.push(word);
    } else if (isCjk(ch)) {
      const run: string[] = [];
      while (i < chars.length && isCjk(chars[i]!)) {
        run.push(chars[i]!);
        i += 1;
      }
      for (let k = 0; k + 1 < run.length; k += 1) {
        const bigram = run[k]! + run[k + 1]!;
        if (!stopwords.has(bigram)) out.push(bigram);
      }
    } else {
      i += 1;
    }
  }
  return out;
}

/** Ordered, deduplicated entities_lexical across an episode's messages (§5.5). */
export function entitiesLexical(texts: readonly string[], stopwords: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const word of contentWords(text, stopwords)) {
      if (!seen.has(word)) {
        seen.add(word);
        out.push(word);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Term matching — deterministic EXACT/PREFIX, boundary-anchored (Erratum 1)
// ---------------------------------------------------------------------------

const fold = (s: string): string => s.normalize("NFC").toLowerCase();

/** True iff the first code point of `term` is Latin/digit (boundary rule applies). */
function firstIsLatinDigit(term: string): boolean {
  const first = [...term.normalize("NFC")][0];
  return first !== undefined && isLatinDigit(first);
}

/** A folded-needle occurrence at `idx` in folded `hay` begins at a token boundary. */
function leftBoundaryOk(hay: string, idx: number): boolean {
  return idx === 0 || !isLatinDigit(hay.charAt(idx - 1));
}

/**
 * First index in folded `hay` where folded `needle` occurs as an exact/prefix
 * match, or -1. For a Latin/digit-first term the match must begin at a token
 * boundary (left char not Latin/digit) — this forbids left-embedded/suffix
 * hits ("scatter" ⊄ "cat") while allowing prefix hits ("category" ⊃ "cat").
 * For a CJK/other-first term, plain substring (CJK has no run boundary).
 */
function findBoundaryMatch(hay: string, foldedNeedle: string, latinFirst: boolean): number {
  if (foldedNeedle.length === 0) return -1;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(foldedNeedle, from);
    if (idx < 0) return -1;
    if (!latinFirst || leftBoundaryOk(hay, idx)) return idx;
    from = idx + 1;
  }
}

export function textContains(text: string, term: string): boolean {
  if (term.length === 0) return false;
  return findBoundaryMatch(fold(text), fold(term), firstIsLatinDigit(term)) >= 0;
}

/** Same exact/prefix semantics against an already-folded window (for negctx). */
function foldedWindowContains(foldedWindow: string, term: string): boolean {
  if (term.length === 0) return false;
  return findBoundaryMatch(foldedWindow, fold(term), firstIsLatinDigit(term)) >= 0;
}

/** Continuation cue: the (whitespace-trimmed) message starts with a cue term. */
export function messageStartsWithAny(text: string, terms: readonly string[]): boolean {
  const hay = fold(text).replace(/^\s+/, "");
  return terms.some((t) => t.length > 0 && hay.startsWith(fold(t)));
}

// ---------------------------------------------------------------------------
// AU scoring (§2.5.1 / §2.5.3)
// ---------------------------------------------------------------------------

export interface AuScore {
  winner: string | null;
  topScore: number;
  secondScore: number;
  lead: number;
  meetsAssign: boolean;
  qualifies: boolean;
  /** AUs with ≥1 term hit, sorted — for the continuation AU hard-filter (§2.8). */
  auHitIds: string[];
}

export function scoreAu(text: string, au: AuLexicon, thresholds: Pass1Thresholds): AuScore {
  const scored = au.entries.map((e) => {
    let score = 0;
    let hit = false;
    for (const t of e.unique_terms) {
      if (textContains(text, t)) {
        score += 2;
        hit = true;
      }
    }
    for (const t of e.shared_terms) {
      if (textContains(text, t)) {
        score += 1;
        hit = true;
      }
    }
    return { au_id: e.au_id, score, hit };
  });
  const sorted = [...scored].sort((a, b) => b.score - a.score || (a.au_id < b.au_id ? -1 : 1));
  const topScore = sorted[0]?.score ?? 0;
  const secondScore = sorted[1]?.score ?? 0;
  const lead = topScore - secondScore;
  const meetsAssign = topScore >= thresholds.auAssignMin;
  const qualifies = meetsAssign && lead >= thresholds.auLeadMin;
  return {
    winner: qualifies ? sorted[0]!.au_id : null,
    topScore,
    secondScore,
    lead,
    meetsAssign,
    qualifies,
    auHitIds: scored.filter((s) => s.hit).map((s) => s.au_id).sort(),
  };
}

/** Any AU term present in the text (for fiction cooccur=au_term and inheritance conflict checks). */
export function anyAuTerm(text: string, au: AuLexicon): boolean {
  for (const e of au.entries) {
    for (const t of e.unique_terms) if (textContains(text, t)) return true;
    for (const t of e.shared_terms) if (textContains(text, t)) return true;
  }
  return false;
}

/** The au_ids whose unique/shared terms hit in `text` (default_sensitivity lookups, §2.5.4). */
export function auHitIds(text: string, au: AuLexicon): string[] {
  const out: string[] = [];
  for (const e of au.entries) {
    if ([...e.unique_terms, ...e.shared_terms].some((t) => textContains(text, t))) out.push(e.au_id);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Weighted content lexicons (project / relationship / schedule) + sensitivity
// ---------------------------------------------------------------------------

export function scoreWeighted(text: string, lex: WeightedLexicon): number {
  let score = 0;
  for (const t of lex.terms) if (textContains(text, t.term)) score += t.weight;
  return score;
}

export function scoreSensitivity(text: string, lex: SensitivityLexicon): Sensitivity {
  let level: Sensitivity = "normal";
  for (const e of lex.entries) if (textContains(text, e.term)) level = maxSensitivity(level, e.level);
  return level;
}

// ---------------------------------------------------------------------------
// Typed fiction evaluation over a contiguous turn list (§2.5.5)
// ---------------------------------------------------------------------------

/** A raw term appearance not cancelled by a preceding negctx term within its window. */
function rawHit(text: string, entry: FictionSignalEntry): boolean {
  const hay = fold(text);
  const needle = fold(entry.term);
  if (needle.length === 0) return false;
  const latinFirst = firstIsLatinDigit(entry.term);
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    const boundaryOk = !latinFirst || leftBoundaryOk(hay, idx);
    if (boundaryOk) {
      if (entry.negctx === null) return true;
      const pre = hay.slice(Math.max(0, idx - entry.negctx.charWindow), idx);
      const negated = entry.negctx.terms.some((n) => foldedWindowContains(pre, n));
      if (!negated) return true;
    }
    from = idx + 1;
  }
}

/** A valid typed-fiction hit anchored to a specific message (Erratum 4). */
export interface FictionHit {
  turnIdx: number;
  messageId: string;
  /**
   * STABLE rule identifier `fic:<lexicon version>:<entry index>` (C3) — the
   * index is stable because config governance forces ascending term order and
   * any lexicon change is a version bump. The term itself NEVER enters the
   * trace: the typed trace carries IDs and rule codes, not vetted vocabulary.
   */
  ruleCode: string;
}

export interface FictionEval {
  enactmentValid: boolean;
  metaValid: boolean;
  anyAuTermHit: boolean;
  /** turnKeys of turns carrying a valid exit hit (for the S3 回切 rule). */
  exitValidTurnKeys: Set<string>;
  /** Valid meta hits (for the segment typed trace). */
  metaHits: FictionHit[];
  /** Valid exit hits (for the segment typed trace). */
  exitHits: FictionHit[];
}

interface RawFictionHit {
  turnIdx: number;
  msgIdx: number;
  messageId: string;
  entry: FictionSignalEntry;
  entryIdx: number;
}

/**
 * Evaluate typed fiction over a contiguous turn list. Two passes so weak
 * entries requiring another fiction signal ground on pass-1 hits (strong
 * entries + weak entries grounded by AU terms) — never on each other (config
 * validation forbids the circular case). `same_message` cooccur is evaluated
 * strictly within one message; adjacent-turn cooccur over the declared window.
 */
export function evalFiction(turns: readonly Pass1Turn[], au: AuLexicon, fiction: FictionLexicon): FictionEval {
  const turnAuTerm = turns.map((t) => t.messages.some((m) => anyAuTerm(m.contentNfc, au)));
  const msgAuTerm = (turnIdx: number, msgIdx: number): boolean =>
    anyAuTerm(turns[turnIdx]!.messages[msgIdx]!.contentNfc, au);
  const auInTurnWindow = (turnIdx: number, adjacent: number): boolean => {
    const lo = Math.max(0, turnIdx - adjacent);
    const hi = Math.min(turns.length - 1, turnIdx + adjacent);
    for (let k = lo; k <= hi; k += 1) if (turnAuTerm[k]) return true;
    return false;
  };

  const raws: RawFictionHit[] = [];
  turns.forEach((turn, turnIdx) => {
    turn.messages.forEach((msg, msgIdx) => {
      fiction.entries.forEach((entry, entryIdx) => {
        if (rawHit(msg.contentNfc, entry)) raws.push({ turnIdx, msgIdx, messageId: msg.messageId, entry, entryIdx });
      });
    });
  });

  // Pass 1: strong entries, and weak entries whose cooccur is au_term.
  const pass1: RawFictionHit[] = [];
  for (const r of raws) {
    const e = r.entry;
    if (e.strength === "strong") {
      pass1.push(r);
    } else if (e.cooccur !== null && e.cooccur.requires === "au_term") {
      const ok = e.cooccur.window === "same_message" ? msgAuTerm(r.turnIdx, r.msgIdx) : auInTurnWindow(r.turnIdx, e.cooccur.window.adjacentTurns);
      if (ok) pass1.push(r);
    }
  }

  // Pass 2: weak entries whose cooccur requires another fiction signal.
  const pass1SameMsg = (messageId: string): boolean => pass1.some((r) => r.messageId === messageId);
  const pass1InTurnWindow = (turnIdx: number, adjacent: number): boolean => pass1.some((r) => Math.abs(r.turnIdx - turnIdx) <= adjacent);
  const pass2: RawFictionHit[] = [];
  for (const r of raws) {
    const e = r.entry;
    if (e.strength !== "weak" || e.cooccur === null || e.cooccur.requires !== "fiction_signal") continue;
    const grounded = e.cooccur.window === "same_message" ? pass1SameMsg(r.messageId) : pass1InTurnWindow(r.turnIdx, e.cooccur.window.adjacentTurns);
    if (grounded) pass2.push(r);
  }

  const valid = [...pass1, ...pass2];
  const exitValidTurnKeys = new Set<string>();
  const exitHits: FictionHit[] = [];
  const metaHits: FictionHit[] = [];
  for (const r of valid) {
    const ruleCode = `fic:${fiction.version}:${r.entryIdx}`;
    if (r.entry.mode === "exit") {
      exitValidTurnKeys.add(turns[r.turnIdx]!.turnKey);
      exitHits.push({ turnIdx: r.turnIdx, messageId: r.messageId, ruleCode });
    } else if (r.entry.mode === "meta") {
      metaHits.push({ turnIdx: r.turnIdx, messageId: r.messageId, ruleCode });
    }
  }
  return {
    enactmentValid: valid.some((r) => r.entry.mode === "enactment"),
    metaValid: valid.some((r) => r.entry.mode === "meta"),
    anyAuTermHit: turnAuTerm.some((v) => v),
    exitValidTurnKeys,
    metaHits,
    exitHits,
  };
}
