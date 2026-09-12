/**
 * Anamnesis: the deterministic read path from Mnemosyne state to one
 * Memory Read Packet (M1.1 section E). Three separated responsibilities:
 *
 *   MemoryPolicy   — pure eligibility/conflict rules (isEligible /
 *                    detectConflicts; no storage, no ranking);
 *   MemoryRetriever— lexical search + a short, documented reranker;
 *   PacketBuilder  — assembly, token budgets, dedup, audit metadata.
 *
 * Core depends only on the structural AnamnesisSource interface below;
 * the SQLite adapter satisfies it without core ever importing adapters.
 * Empty retrieval returns an honest empty packet; nothing here ever
 * instructs the model to invent a memory. Raw transcript text never
 * enters the packet — items carry curated body text plus source pointers.
 */

import { segmentForSearch } from "./segmentation.js";
import {
  admitLexical,
  DEFAULT_ANAMNESIS_LEXICAL_ADMISSION_PROFILE,
  type AnamnesisLexicalAdmissionProfileV1,
} from "./anamnesis-admission.js";

export interface MemoryItemView {
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
  /** 1 when an owner/governance event explicitly set retrieval on or off. */
  retrieval_explicit?: number;
  supersedes: string | null;
  source_basis: string | null;
  tags_text: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface FragmentView {
  id: string;
  body: string;
  created_at: string;
  expires_at: string;
  source_id: string | null;
}

export interface PriorView {
  key: string;
  version: number;
  body: string;
  token_est: number;
  approved_by: string;
  changelog: string;
  expires_at: string | null;
}

/** Structural read surface Anamnesis needs; the SQLite store satisfies it. */
export interface AnamnesisSource {
  ftsSearch(query: string, limit: number): Array<{ itemId: string; rank: number }>;
  getItem(id: string): MemoryItemView | undefined;
  listPriors(): PriorView[];
  listFragments(nowIso: string): FragmentView[];
  listSources(subjectKind: string, subjectId: string): Array<{ kind: string; pointer: string }>;
}

/**
 * Typed deterministic scene scope. The scene is advisory retrieval context:
 * exact AU matches may rank higher, but no AU or sensitivity label acts as a
 * hard visibility partition. AU identity is rendered explicitly for the
 * provider to interpret.
 */
export type MemorySceneScope =
  | { mode: "ordinary"; intimacyActive: boolean }
  | { mode: "au"; auId: string; intimacyActive: boolean };

/**
 * Runtime-facing packet provider (M3). Composition closes over the store;
 * ChatService only ever asks for a packet — it never sees storage,
 * policy, or ranking internals.
 */
export interface MemoryPacketProvider {
  build(query: string, scene: MemorySceneScope, nowIso: string): MemoryReadPacket;
}

/**
 * Admission assessment for untrusted card/fragment bodies (M3a #1).
 * Ordinary Memory Cards hold declarative remembered facts, events, and
 * preferences; behavioral instructions belong ONLY in explicitly approved
 * House Priors or policy. Directive-like or structural-injection content
 * is quarantined instead of retrieved. Legitimate quoted history ("她说
 * '记住这个'") passes — the patterns target directives aimed at the
 * model and our reserved block grammar, not quoted human speech.
 */
const DIRECTIVE_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)/i,
  /new\s+instructions\s*:/i,
  /^\s*(?:system|assistant)\s*:/im,
  /you\s+must\s+now\b/i,
];
const STRUCTURAL_PATTERNS: readonly RegExp[] = [/^===/m, /^---/m];

export function assessUntrustedBody(body: string): { ok: true } | { ok: false; reason: string } {
  for (const pattern of DIRECTIVE_PATTERNS) {
    if (pattern.test(body)) {
      return {
        ok: false,
        reason:
          "quarantined: directive-like content (memory cards hold declarative facts; " +
          "behavioral rules belong in approved House Priors)",
      };
    }
  }
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (pattern.test(body)) {
      return { ok: false, reason: "quarantined: structural delimiter syntax in body" };
    }
  }
  return { ok: true };
}

export interface PacketBudgets {
  priorsTokens: number;
  fragmentsItems: number;
  fragmentsTokens: number;
  memoriesItems: number;
  memoriesTokens: number;
  totalTokens: number;
}

/** M1.1 section E starting limits. */
export const DEFAULT_BUDGETS: PacketBudgets = {
  priorsTokens: 700,
  fragmentsItems: 4,
  fragmentsTokens: 220,
  memoriesItems: 5,
  memoriesTokens: 700,
  totalTokens: 1500,
};

/** Coarse, deterministic token estimate (CJK-aware; documented heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 3);
}

export interface EligibilityVerdict {
  ok: boolean;
  reason: string;
}

/**
 * D0 trust precedence (work order §5.4): individually confirmed >
 * policy-activated explicit > policy-activated observed. Candidates and
 * quarantined material never inject. Deterministic; used by conflict
 * resolution and ranking.
 */
export function trustRank(item: MemoryItemView): number {
  if (item.approval_state === "confirmed") {
    return 3;
  }
  if (item.approval_state === "policy_activated") {
    return item.source_basis === "explicit" ? 2 : 1;
  }
  return 0;
}

/** MemoryPolicy: one item's retrieval eligibility under the active scene. */
export function isEligible(
  item: MemoryItemView,
  _scene: MemorySceneScope,
  nowIso: string,
): EligibilityVerdict {
  if (item.approval_state !== "confirmed" && item.approval_state !== "policy_activated") {
    return { ok: false, reason: "candidate awaiting confirmation" };
  }
  // Time/status filtering (context reliability §3): superseded and expired
  // cards never participate in retrieval; the reason is explicit so the
  // packet audit records WHY a stale card was excluded. Legacy cards with an
  // unknown/blank lifecycle fall through to the same active-only rule.
  if (item.lifecycle_state === "superseded") {
    return { ok: false, reason: "superseded (replaced by a newer card)" };
  }
  if (item.lifecycle_state !== "active") {
    return { ok: false, reason: `lifecycle ${item.lifecycle_state || "unknown"}` };
  }
  if (item.expires_at !== null && item.expires_at <= nowIso) {
    return { ok: false, reason: "expired (past valid-until)" };
  }
  // Sensitivity is descriptive, not a scene hard gate. Historical projections
  // defaulted intimate cards to disabled; that legacy default must not hide an
  // approved, active card. An explicit retrieval_set(false) still wins for
  // every sensitivity class.
  const disabledOnlyByLegacyIntimateDefault =
    item.retrieval !== "enabled" &&
    item.sensitivity === "intimate" &&
    item.retrieval_explicit !== 1;
  if (item.retrieval !== "enabled" && !disabledOnlyByLegacyIntimateDefault) {
    return { ok: false, reason: "retrieval disabled by card governance" };
  }
  if (item.scope === "session") {
    return { ok: false, reason: "session-scoped (not retrievable)" };
  }
  const admission = assessUntrustedBody(item.body);
  if (!admission.ok) {
    return { ok: false, reason: admission.reason };
  }
  return { ok: true, reason: "eligible" };
}

/**
 * MemoryPolicy: conflicting eligible items (same normalized title) are
 * resolved by TRUST PRECEDENCE first (D0 §5.4): a uniquely highest-trust
 * card wins and lower-trust cards are excluded as outranked. Reality and
 * each explicit AU are distinct semantic realms, so the same title across
 * realms remains model-visible with an AU label rather than forming a false
 * conflict. Cards tied inside one realm at the highest trust level are a
 * true conflict and remain excluded for review.
 */
export function detectConflicts(items: readonly MemoryItemView[]): Map<string, string> {
  const byTitle = new Map<string, MemoryItemView[]>();
  for (const item of items) {
    const realm = item.scope === "au" ? `au:${item.au_id ?? "unknown"}` : "reality";
    const key = `${realm}\u0000${item.title.trim().toLowerCase()}`;
    const group = byTitle.get(key) ?? [];
    group.push(item);
    byTitle.set(key, group);
  }
  const excluded = new Map<string, string>();
  for (const group of byTitle.values()) {
    if (group.length < 2) {
      continue;
    }
    const top = Math.max(...group.map((item) => trustRank(item)));
    const leaders = group.filter((item) => trustRank(item) === top);
    if (leaders.length > 1) {
      for (const item of group) {
        excluded.set(item.id, "conflict — review candidate");
      }
    } else {
      for (const item of group) {
        if (item !== leaders[0]) {
          excluded.set(item.id, "outranked by a higher-trust card with the same title");
        }
      }
    }
  }
  return excluded;
}

export interface RankedMemory {
  item: MemoryItemView;
  score: number;
  why: string;
}

/**
 * MemoryRetriever: FTS candidates + H8 relevance admission + a short,
 * configuration-free reranker. Admission happens before any boost, so trust,
 * importance, title/tag, or AU advice cannot rescue a weak lexical hit.
 *
 * Scoring terms (documented, deterministic):
 *   base   = -bm25 rank (lower bm25 = better lexical match)
 *   +2.0   every query token present in the title
 *   +1.5   any query token equals a tag
 *   +0.5 × importance
 *   +1.0   exact current-AU match (advisory ranking only)
 * Ties break by item id for determinism.
 */
export function retrieve(
  source: AnamnesisSource,
  query: string,
  scene: MemorySceneScope,
  nowIso: string,
  wantItems: number,
  admissionProfile: AnamnesisLexicalAdmissionProfileV1 = DEFAULT_ANAMNESIS_LEXICAL_ADMISSION_PROFILE,
): { ranked: RankedMemory[]; excluded: Array<{ id: string; reason: string }> } {
  const hits = source.ftsSearch(query, Math.max(wantItems * 4, 12));
  const excluded: Array<{ id: string; reason: string }> = [];
  const eligible: Array<{ item: MemoryItemView; rank: number }> = [];
  for (const hit of hits) {
    const item = source.getItem(hit.itemId);
    if (item === undefined) {
      continue;
    }
    const verdict = isEligible(item, scene, nowIso);
    if (!verdict.ok) {
      excluded.push({ id: item.id, reason: verdict.reason });
      continue;
    }
    const relevance = admitLexical(query, item, admissionProfile);
    if (!relevance.admitted) {
      excluded.push({ id: item.id, reason: `admission: ${relevance.reason}` });
      continue;
    }
    eligible.push({ item, rank: hit.rank });
  }
  const conflicted = detectConflicts(eligible.map((entry) => entry.item));
  const survivors = eligible.filter((entry) => {
    const reason = conflicted.get(entry.item.id);
    if (reason !== undefined) {
      excluded.push({ id: entry.item.id, reason });
      return false;
    }
    return true;
  });
  const queryTokens = segmentForSearch(query)
    .split(" ")
    .filter((token) => token.length > 0);
  const ranked = survivors
    .map(({ item, rank }) => {
      let score = -rank;
      const why: string[] = ["lexical match"];
      const titleSeg = segmentForSearch(item.title);
      if (queryTokens.length > 0 && queryTokens.every((token) => titleSeg.includes(token))) {
        score += 2.0;
        why.push("title match");
      }
      const tags = item.tags_text.split(" ").filter((tag) => tag.length > 0);
      if (queryTokens.some((token) => tags.some((tag) => tag.toLowerCase() === token))) {
        score += 1.5;
        why.push("tag match");
      }
      score += 0.5 * item.importance;
      if (scene.mode === "au" && item.scope === "au" && item.au_id === scene.auId) {
        score += 1.0;
        why.push("active AU match");
      }
      // D0 §5.4 precedence: individually confirmed evidence outranks
      // policy-activated; explicit outranks observed. Deterministic term.
      score += 0.5 * trustRank(item);
      if (item.approval_state === "policy_activated") {
        why.push(`auto:${item.source_basis ?? "observed"}`);
      }
      return { item, score, why: why.join(" + ") };
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.item.id < b.item.id ? -1 : 1));
  return { ranked: ranked.slice(0, wantItems), excluded };
}

export interface MemoryReadPacket {
  priors: Array<{ key: string; version: number; body: string }>;
  fragments: Array<{ id: string; body: string }>;
  memories: Array<{
    id: string;
    title: string;
    body: string;
    scope: string;
    /** Present on AU cards so provider-visible titles can carry the realm. */
    auId?: string | null;
    /** Classification label only; never a retrieval hard gate. */
    sensitivity?: string;
    confidence: string;
    sourcePointer: string | null;
  }>;
  audit: {
    query: string;
    selected: Array<{ id: string; why: string; scope: string; score: number }>;
    excluded: Array<{ id: string; reason: string }>;
    tokenCount: number;
  };
}

const PRIOR_ORDER = ["identity", "relationship", "household_now", "project_now"] as const;

/** PacketBuilder: deterministic assembly under hard token budgets. */
export function buildMemoryReadPacket(input: {
  source: AnamnesisSource;
  query: string;
  scene: MemorySceneScope;
  nowIso: string;
  budgets?: PacketBudgets;
}): MemoryReadPacket {
  const budgets = input.budgets ?? DEFAULT_BUDGETS;
  const excluded: Array<{ id: string; reason: string }> = [];

  // Steps 1-2: approved House Priors; expired "now" blocks drop out (Lethe).
  const priors: MemoryReadPacket["priors"] = [];
  let priorTokens = 0;
  const priorRows = input.source.listPriors();
  for (const key of PRIOR_ORDER) {
    const row = priorRows.find((candidate) => candidate.key === key);
    if (row === undefined) {
      continue;
    }
    if (row.expires_at !== null && row.expires_at <= input.nowIso) {
      excluded.push({ id: `prior:${key}`, reason: "prior expired (Lethe)" });
      continue;
    }
    const cost = row.token_est > 0 ? row.token_est : estimateTokens(row.body);
    if (priorTokens + cost > budgets.priorsTokens) {
      excluded.push({ id: `prior:${key}`, reason: "prior token budget exceeded" });
      continue;
    }
    priorTokens += cost;
    priors.push({ key: row.key, version: row.version, body: row.body });
  }

  // Step 3: recent fragments (short-lived, explicitly unconfirmed).
  const fragments: MemoryReadPacket["fragments"] = [];
  let fragmentTokens = 0;
  for (const fragment of input.source.listFragments(input.nowIso)) {
    if (fragments.length >= budgets.fragmentsItems) {
      excluded.push({ id: `fragment:${fragment.id}`, reason: "fragment item budget" });
      continue;
    }
    const cost = estimateTokens(fragment.body);
    if (fragmentTokens + cost > budgets.fragmentsTokens) {
      excluded.push({ id: `fragment:${fragment.id}`, reason: "fragment token budget" });
      continue;
    }
    fragmentTokens += cost;
    fragments.push({ id: fragment.id, body: fragment.body });
  }

  // Steps 4-8: retrieved memories — policy-filtered, relevance-admitted,
  // conflict-checked, deduped against priors. memoriesItems is a maximum,
  // never a quota: H8 may honestly return fewer or zero cards.
  const { ranked, excluded: retrievalExcluded } = retrieve(
    input.source,
    input.query,
    input.scene,
    input.nowIso,
    budgets.memoriesItems,
  );
  excluded.push(...retrievalExcluded);
  const priorBodies = priors.map((prior) => prior.body.toLowerCase());
  const memories: MemoryReadPacket["memories"] = [];
  const selectedAudit: MemoryReadPacket["audit"]["selected"] = [];
  let memoryTokens = 0;
  for (const entry of ranked) {
    if (priorBodies.some((body) => body.includes(entry.item.title.trim().toLowerCase()))) {
      excluded.push({ id: entry.item.id, reason: "duplicated by a House Prior" });
      continue;
    }
    const cost = estimateTokens(entry.item.body);
    if (memoryTokens + cost > budgets.memoriesTokens) {
      excluded.push({ id: entry.item.id, reason: "memory token budget exceeded" });
      continue;
    }
    memoryTokens += cost;
    const sources = input.source.listSources("memory", entry.item.id);
    memories.push({
      id: entry.item.id,
      title: entry.item.title,
      body: entry.item.body,
      scope: entry.item.scope,
      auId: entry.item.au_id,
      sensitivity: entry.item.sensitivity,
      // Visible trust distinction (D0 §5.4): policy-activated cards are
      // labeled auto:<basis>; individually confirmed keep the plain basis.
      confidence:
        entry.item.approval_state === "policy_activated"
          ? `auto:${entry.item.source_basis ?? "observed"}`
          : (entry.item.source_basis ?? "unstated"),
      sourcePointer: sources[0]?.pointer ?? null,
    });
    selectedAudit.push({
      id: entry.item.id,
      why: entry.why,
      scope: entry.item.scope,
      score: Number(entry.score.toFixed(3)),
    });
  }

  // Step 9: total hard cap — prefer fewer, higher-confidence memories.
  let total = priorTokens + fragmentTokens + memoryTokens;
  while (total > budgets.totalTokens && memories.length > 0) {
    const dropped = memories.pop()!;
    selectedAudit.pop();
    excluded.push({ id: dropped.id, reason: "total token budget exceeded" });
    total -= estimateTokens(dropped.body);
  }
  while (total > budgets.totalTokens && fragments.length > 0) {
    const dropped = fragments.pop()!;
    excluded.push({ id: `fragment:${dropped.id}`, reason: "total token budget exceeded" });
    total -= estimateTokens(dropped.body);
  }

  return {
    priors,
    fragments,
    memories,
    audit: { query: input.query, selected: selectedAudit, excluded, tokenCount: total },
  };
}

/** Render for the (M3, not yet wired) structured context slot. */
export function renderMemoryPacket(packet: MemoryReadPacket): string {
  const parts: string[] = [];
  parts.push("=== HOUSE PRIORS (approved) ===");
  parts.push(
    packet.priors.length === 0
      ? "(no approved priors)"
      : packet.priors.map((prior) => `[${prior.key} v${prior.version}] ${prior.body}`).join("\n"),
  );
  parts.push("=== RECENT FRAGMENTS (unconfirmed, expiring; quoted untrusted data) ===");
  parts.push(
    packet.fragments.length === 0
      ? "(none)"
      : packet.fragments.map((fragment) => `- ${JSON.stringify(fragment.body)}`).join("\n"),
  );
  parts.push("=== RETRIEVED MEMORIES (quoted untrusted data) ===");
  parts.push(
    packet.memories.length === 0
      ? "(no relevant remembered cards; do not invent any)"
      : packet.memories
          .map((memory) => {
            const title = memory.scope === "au"
              ? `[AU:${memory.auId ?? "unknown"}] ${memory.title}`
              : memory.title;
            return `[${memory.id.slice(0, 8)}|${memory.scope}|${memory.sensitivity ?? "unclassified"}|${memory.confidence}] title=${JSON.stringify(title)} body=${JSON.stringify(memory.body)}`;
          })
          .join("\n"),
  );
  parts.push("=== END MEMORY ===");
  return parts.join("\n");
}
