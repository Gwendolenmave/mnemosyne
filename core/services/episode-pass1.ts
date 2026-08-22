/**
 * L1-T02 Pass1 engine (§2.12): orchestrates normalize → boundary override
 * compile → boundary decision → episode assembly → global continuation
 * resolution → realm inheritance → domain/status/confidence → id/hash →
 * mandatory self-validation. Pure and deterministic: no I/O, no clock, no
 * random, no locale, no model (realModelCalls ≡ 0). Any failure returns a
 * stable category and produces NO partial result.
 */

import { createHash } from "node:crypto";
import {
  episodeIdFor,
  isDomain,
  maxSensitivity,
  type Domain,
  type Initiator,
  type Participant,
  type Realm,
  type RealmBasis,
  type Sensitivity,
} from "../domain/episode.js";
import {
  validatePass1Config,
  type Pass1Annotation,
  type Pass1Config,
  type Pass1ContinuationLink,
  type Pass1Episode,
  type Pass1Membership,
  type Pass1OverrideRecord,
  type Pass1Result,
  type Pass1UnresolvedCandidate,
  type Pass1Message,
} from "../domain/episode-pass1.js";
import { partitionAndAssemble, type Pass1Partition } from "./episode-pass1-normalize.js";
import {
  buildMessageIndex,
  compileBoundaryOverrides,
  evaluateBoundaries,
  judgeRealmLexicalPrior,
  type Pass1OverrideEvent,
  type RealmJudgment,
} from "./episode-pass1-boundaries.js";
import { auHitIds, contentWords, entitiesLexical, evalFiction, messageStartsWithAny, scoreAu, scoreSensitivity, scoreWeighted } from "./episode-pass1-lexicon.js";
import { SHANGHAI_OFFSET_MS } from "./time-labels.js";

export interface Pass1EngineInput {
  messages: readonly Pass1Message[];
  skippedNonMessage: number;
  malformed: readonly { sourceFileId: string; sourceLine: number; category: string }[];
  overrideEvents: readonly Pass1OverrideEvent[];
  config: Pass1Config;
}

export interface Pass1Failure {
  category: string;
  detail: string;
}

export type Pass1Outcome = { ok: true; result: Pass1Result } | { ok: false; failure: Pass1Failure };

const REALM_CONF: Record<string, number> = {
  configured_prior: 0.7,
  continuation_link: 0.75,
  fiction_signal: 0.3,
  no_evidence: 0.3,
};

function localPlus08(epochMs: number): string {
  return `${new Date(epochMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 23)}+08:00`;
}

function displayRealm(realm: string, auId: string | null): string {
  if (realm === "reality") return "现实";
  if (realm === "au") return auId ?? "层面未定";
  return "层面未定";
}

/**
 * Pass1 mechanical fallback title (§8.6). intimate rows degrade to
 * `YYYY-MM-DD · <realmDisp> · [intimate]` with NO lexical entities (§3.6 /
 * Erratum 5): the title is a leak surface, so intimate content never puts raw
 * entity words into the display name or the FTS index.
 */
function fallbackTitle(date: string, realm: string, auId: string | null, entities: readonly string[], sensitivity: Sensitivity): string {
  if (sensitivity === "intimate") {
    const full = `${date} · ${displayRealm(realm, auId)} · [intimate]`;
    return [...full].length <= 40 ? full : [...full].slice(0, 40).join("");
  }
  const head = `${date} · ${displayRealm(realm, auId)} · `;
  const items = entities.length > 0 ? entities.slice(0, 2) : ["对话"];
  let tail = items.join("、");
  // ≤40 code points: keep date+realm, truncate the tail's last item as needed.
  const budget = 40 - [...head].length;
  while ([...tail].length > budget && items.length > 0) {
    items.pop();
    tail = items.length > 0 ? items.join("、") : "对话";
    if (items.length === 0) break;
  }
  const full = head + tail;
  return [...full].length <= 40 ? full : [...full].slice(0, 40).join("");
}

/**
 * One member of a canonical member-hash: `id\ntimestampUtc\nrole\ncontent\n`.
 * Shared between the Pass1 source_hash and the Pass2 chunk_hash so there is a
 * SINGLE serialization+digest rule (§13#1); slices supply `id = message_id`
 * and the slice's own content (bounded T02 API exposure for T03 reuse).
 */
export interface CanonicalHashUnit {
  id: string;
  timestampUtc: string;
  role: string;
  content: string;
}

/**
 * Canonical member hash — `sha256:` + SHA-256 over the UTF-8/LF serialization
 * `${id}\n${timestampUtc}\n${role}\n${content}\n` joined in the given order.
 * This is the extracted, byte-identical body of the former private
 * `sourceHash`; source_hash below and Pass2 chunk_hash both call it, so no
 * second implementation exists.
 */
export function canonicalMemberHash(units: readonly CanonicalHashUnit[]): string {
  const serial = units.map((u) => `${u.id}\n${u.timestampUtc}\n${u.role}\n${u.content}\n`).join("");
  return `sha256:${createHash("sha256").update(serial, "utf8").digest("hex")}`;
}

function sourceHash(members: readonly Pass1Message[]): string {
  return canonicalMemberHash(members.map((m) => ({ id: m.messageId, timestampUtc: m.timestampUtc, role: m.role, content: m.contentNfc })));
}

/**
 * Pass1 sensitivity initial value (§2.5.4, Erratum 5): `max(effective attributed
 * AU default_sensitivity, highest tier among ambiguous candidates, sensitivity
 * lexicon hits)`. Attribution uses the POST-inheritance effective realm/au_id.
 * A resolved realm (reality/au) is NOT raised by stray other-AU terms; only a
 * genuinely ambiguous fiction_signal segment takes the conservative "就高不就低"
 * raise over its candidate AUs.
 */
function pass1Sensitivity(
  members: readonly Pass1Message[],
  realm: Realm,
  basis: string,
  auId: string | null,
  config: Pass1Config,
): Sensitivity {
  let level: Sensitivity = "normal";
  for (const m of members) level = maxSensitivity(level, scoreSensitivity(m.contentNfc, config.lexicons.sensitivity));
  const auEntry = (id: string) => config.lexicons.au.entries.find((e) => e.au_id === id);
  if (realm === "au" && auId !== null) {
    const e = auEntry(auId);
    if (e) level = maxSensitivity(level, e.default_sensitivity);
  } else if (basis === "fiction_signal") {
    const text = members.map((m) => m.contentNfc).join("\n");
    for (const id of auHitIds(text, config.lexicons.au)) {
      const e = auEntry(id);
      if (e) level = maxSensitivity(level, e.default_sensitivity);
    }
  }
  return level;
}

/**
 * Merge the boundary-context notes (continuation_cue/topic_shift) with the
 * segment typed-fiction trace (fiction_meta/fiction_exit; Erratum 4), dedupe,
 * and order deterministically by (member position, kind, rule_code).
 */
function mergeAnnotations(
  base: readonly Pass1Annotation[],
  metaHits: ReadonlyArray<{ messageId: string; ruleCode: string }>,
  exitHits: ReadonlyArray<{ messageId: string; ruleCode: string }>,
  memberIndex: ReadonlyMap<string, number>,
): Pass1Annotation[] {
  const all: Pass1Annotation[] = [...base];
  for (const h of metaHits) all.push({ kind: "fiction_meta", message_id: h.messageId, rule_code: h.ruleCode });
  for (const h of exitHits) all.push({ kind: "fiction_exit", message_id: h.messageId, rule_code: h.ruleCode });
  const seen = new Set<string>();
  const deduped = all.filter((a) => {
    const key = `${a.kind}${a.message_id}${a.rule_code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.sort((a, b) => {
    const ai = memberIndex.get(a.message_id) ?? Number.MAX_SAFE_INTEGER;
    const bi = memberIndex.get(b.message_id) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.rule_code < b.rule_code ? -1 : a.rule_code > b.rule_code ? 1 : 0;
  });
}

interface Proto {
  conversationId: string;
  members: Pass1Message[];
  episode_id: string;
  startTurnIndex: number;
  isS1Cut: boolean;
  cueMessageId: string | null;
  realm: RealmJudgment;
  entities: string[];
  startConf: number;
  endConf: number;
  isLastInPartition: boolean;
  annotations: Pass1Annotation[];
  continuation_links: Pass1ContinuationLink[];
  has_continuation: boolean;
  overridesAppliedIds: string[];
}

export function runPass1(input: Pass1EngineInput): Pass1Outcome {
  const cfgResult = validatePass1Config(input.config);
  if (!cfgResult.ok) {
    const drift = cfgResult.issues.some((i) => i.message.includes("config_bundle_drift"));
    return { ok: false, failure: { category: drift ? "config_bundle_drift" : "config_invalid", detail: `${cfgResult.issues.length} issue(s)` } };
  }
  if (input.malformed.length > 0) {
    const first = input.malformed[0]!;
    return { ok: false, failure: { category: "malformed_message", detail: `${input.malformed.length} line(s); first ${first.sourceFileId}:${first.sourceLine} ${first.category}` } };
  }

  const { partitions, duplicates } = partitionAndAssemble(input.messages);
  if (duplicates.length > 0) {
    return { ok: false, failure: { category: "duplicate_message", detail: `${duplicates.length} duplicate (conv,message_id)` } };
  }

  const config = input.config;
  const stopwords = new Set(config.lexicons.stopwords.words);
  const messageIndex = buildMessageIndex(partitions);
  const compiled = compileBoundaryOverrides(input.overrideEvents, messageIndex);
  const overrideRecords: Pass1OverrideRecord[] = compiled.records.map((r) => ({ ...r }));

  // --- build proto episodes per partition ---
  const protos: Proto[] = [];
  for (const partition of partitions) {
    const evalRes = evaluateBoundaries(partition.turns, partition.conversationId, compiled, config);
    const bounds = evalRes.boundaryIndices;
    const n = partition.turns.length;
    const annByTurn = new Map<number, Pass1Annotation[]>();
    for (const a of evalRes.annotations) {
      const list = annByTurn.get(a.turnIndex) ?? [];
      list.push({ kind: a.kind, message_id: a.message_id, rule_code: a.rule_code });
      annByTurn.set(a.turnIndex, list);
    }
    const s1LinkByStart = new Map<number, string>();
    for (const l of evalRes.s1Links) s1LinkByStart.set(l.turnIndex, l.message_id);

    for (let k = 0; k < bounds.length; k += 1) {
      const start = bounds[k]!;
      const end = bounds[k + 1] ?? n;
      const rangeTurns = partition.turns.slice(start, end);
      const members = rangeTurns.flatMap((t) => t.messages).slice().sort((a, b) => (a.epochMs !== b.epochMs ? a.epochMs - b.epochMs : a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
      const episode_id = episodeIdFor(partition.conversationId, members[0]!.messageId);
      const realm = judgeRealmLexicalPrior(rangeTurns, config, partition.conversationId);
      const annotations: Pass1Annotation[] = [];
      for (let ti = start; ti < end; ti += 1) for (const a of annByTurn.get(ti) ?? []) annotations.push(a);
      protos.push({
        conversationId: partition.conversationId,
        members,
        episode_id,
        startTurnIndex: start,
        isS1Cut: (evalRes.strengthByIndex.get(start)?.causes ?? []).includes("S1_cut"),
        cueMessageId: s1LinkByStart.get(start) ?? null,
        realm,
        entities: entitiesLexical(members.map((m) => m.contentNfc), stopwords),
        startConf: evalRes.strengthByIndex.get(start)?.strength ?? 1.0,
        endConf: evalRes.strengthByIndex.get(end)?.strength ?? 1.0,
        isLastInPartition: end === n,
        annotations,
        continuation_links: [],
        has_continuation: false,
        overridesAppliedIds: [],
      });
    }
  }

  const byId = new Map<string, Proto>();
  for (const p of protos) byId.set(p.episode_id, p);
  const findEpisodeOfMessage = (conversationId: string, messageId: string): Proto | null => {
    for (const p of protos) if (p.conversationId === conversationId && p.members.some((m) => m.messageId === messageId)) return p;
    return null;
  };
  const startEpoch = (p: Proto): number => p.members[0]!.epochMs;
  const endEpoch = (p: Proto): number => p.members[p.members.length - 1]!.epochMs;

  // --- global continuation resolution (§2.8) for S1-cut episodes ---
  // A cue-initiated episode = its FIRST member message starts with a continuation
  // cue. This captures both S1-cut cues (new episode after a boundary) and
  // conversation-start cues (cross-conversation continuation) — the no-cut cue
  // stays mid-episode and never becomes a first message.
  const isCueInitiated = (p: Proto): boolean =>
    p.members.length > 0 && messageStartsWithAny(p.members[0]!.contentNfc, config.lexicons.continuation.terms);
  const unresolved: Array<{ source_episode_id: string; candidates: Pass1UnresolvedCandidate[] }> = [];
  for (const succ of protos) {
    if (!isCueInitiated(succ)) continue;
    const cueMsg = succ.members[0]!;
    const cueWords = new Set(contentWords(cueMsg.contentNfc, stopwords));
    const cueAu = scoreAu(cueMsg.contentNfc, config.lexicons.au, config.thresholds);
    let candidates = protos.filter((e) => e.episode_id !== succ.episode_id && endEpoch(e) < cueMsg.epochMs);
    if (cueAu.auHitIds.length === 1) {
      const only = cueAu.auHitIds[0]!;
      candidates = candidates.filter((e) => e.realm.auId === only);
    }
    const scored: Pass1UnresolvedCandidate[] = candidates
      .map((e) => ({ episode_id: e.episode_id, score: e.entities.reduce((acc, w) => acc + (cueWords.has(w) ? 1 : 0), 0) }))
      .sort((a, b) => b.score - a.score || (a.episode_id < b.episode_id ? -1 : 1));
    const positive = scored.filter((s) => s.score > 0);
    if (positive.length === 1) {
      const target = byId.get(positive[0]!.episode_id)!;
      succ.continuation_links.push({ target_episode_id: target.episode_id, relation: "continues", evidence: { kind: "explicit_marker", message_id: cueMsg.messageId } });
      target.has_continuation = true;
    } else {
      unresolved.push({ source_episode_id: succ.episode_id, candidates: scored });
    }
  }

  // --- manual link/unlink directives (§2.1.5 / §6) — same-anchor LATEST-WINS (C1) ---
  // Explicit winner semantics: events are grouped by anchor (conversation_id,
  // message_id) in append order. Each event's OWN validity is judged first —
  // an invalid event keeps its honest state (needs_review / unmatched) and
  // never becomes a winner nor supersedes anyone. Among the VALID events at
  // one anchor the LAST is the winner; every earlier valid one flips to
  // no_op (superseded) and contributes nothing to the final graph or to
  // overrides_applied_ids. Winner effects apply in append order on top of
  // the auto-resolved graph:
  //   link(anchor X → T):   replace any link on X's episode evidenced by X
  //                          (the auto cue link when X is the cue) with the
  //                          manual edge → applied.
  //   unlink(anchor X, T):  remove edges from X's episode to T (unlink-one);
  //   unlink(anchor X, —):  remove ALL edges on X's episode (unlink-all);
  //                          removed>0 → applied, else honest no_op.
  interface LinkEval {
    d: (typeof compiled.links)[number];
    rec: Pass1OverrideRecord;
    succ: Proto;
    target: Proto | null;
  }
  const byAnchor = new Map<string, LinkEval[]>();
  for (const d of compiled.links) {
    const rec = overrideRecords[d.recordIdx]!;
    const succ = findEpisodeOfMessage(d.anchorConversationId, d.anchorMessageId);
    if (succ === null) {
      rec.state = "unmatched";
      rec.detail = "anchor_not_found";
      continue;
    }
    let target: Proto | null = null;
    if (d.op === "link_continuation") {
      target = d.targetConversationId !== null && d.targetMessageId !== null ? findEpisodeOfMessage(d.targetConversationId, d.targetMessageId) : null;
      if (target === null || target.episode_id === succ.episode_id || endEpoch(target) >= startEpoch(succ)) {
        rec.state = "needs_review";
        rec.detail = "link_target_invalid";
        continue;
      }
    } else if (d.targetConversationId !== null && d.targetMessageId !== null) {
      target = findEpisodeOfMessage(d.targetConversationId, d.targetMessageId);
      if (target === null) {
        rec.state = "needs_review";
        rec.detail = "unlink_target_not_found";
        continue;
      }
    }
    const key = `${d.anchorConversationId} ${d.anchorMessageId}`;
    const list = byAnchor.get(key) ?? [];
    list.push({ d, rec, succ, target });
    byAnchor.set(key, list);
  }
  const linkWinners: LinkEval[] = [];
  for (const [, evs] of byAnchor) {
    for (let i = 0; i < evs.length - 1; i += 1) {
      evs[i]!.rec.state = "no_op";
      evs[i]!.rec.detail = "superseded_by_later_event";
    }
    linkWinners.push(evs[evs.length - 1]!);
  }
  linkWinners.sort((a, b) => a.d.recordIdx - b.d.recordIdx);
  for (const w of linkWinners) {
    if (w.d.op === "link_continuation") {
      w.succ.continuation_links = w.succ.continuation_links.filter((l) => l.evidence.message_id !== w.d.anchorMessageId);
      w.succ.continuation_links.push({ target_episode_id: w.target!.episode_id, relation: "continues", evidence: { kind: "manual", message_id: w.d.anchorMessageId } });
      w.rec.state = "applied";
      w.rec.detail = "link";
      w.succ.overridesAppliedIds.push(w.d.override_id);
    } else {
      const before = w.succ.continuation_links.length;
      w.succ.continuation_links = w.target === null ? [] : w.succ.continuation_links.filter((l) => l.target_episode_id !== w.target!.episode_id);
      const removed = before - w.succ.continuation_links.length;
      w.rec.state = removed > 0 ? "applied" : "no_op";
      w.rec.detail = removed > 0 ? "unlink" : "unlink_no_op";
      if (removed > 0) w.succ.overridesAppliedIds.push(w.d.override_id);
    }
  }
  // recompute has_continuation from the final link graph
  for (const p of protos) p.has_continuation = false;
  for (const p of protos) for (const l of p.continuation_links) { const t = byId.get(l.target_episode_id); if (t) t.has_continuation = true; }

  // record split/merge applied ids onto their episodes (by anchor turn's episode)
  for (const rec of overrideRecords) {
    if (rec.kind === "boundary" && (rec.op === "split_before_message" || rec.op === "merge_adjacent") && rec.state === "applied") {
      const owner = protos.find((p) => p.members.some((m) => messageIndex.get(`${p.conversationId} ${m.messageId}`)?.turnKey === rec.target));
      if (owner) owner.overridesAppliedIds.push(rec.override_id);
    }
  }

  // --- realm inheritance (§2.5.2 step 2 / §8.1), TIME-ORDERED (C2) ---
  // A chain A→B→C must inherit through EFFECTIVE values: the link validity
  // invariant end(target) < start(successor) implies start(target) <
  // start(successor), so processing episodes in start-time order guarantees a
  // link target's effective realm/au_id is already resolved when its
  // successor is judged — continuation_link is itself a legal AU basis for a
  // further hop. No inheritance from the future is possible (links only point
  // backward in time); a conflicting other-AU term or an unresolved link
  // stops the chain (the middle episode never becomes au, so its successor
  // sees a non-au target and does not inherit).
  interface EffectiveRealm { realm: Realm; basis: RealmBasis; auId: string | null }
  const effectiveById = new Map<string, EffectiveRealm>();
  const timeOrdered = [...protos].sort((a, b) => startEpoch(a) - startEpoch(b) || (a.episode_id < b.episode_id ? -1 : 1));
  for (const p of timeOrdered) {
    let eff: EffectiveRealm = { realm: p.realm.realm, basis: p.realm.basis, auId: p.realm.auId };
    if (isCueInitiated(p) && eff.basis !== "au_lexicon") {
      const link = p.continuation_links.find((l) => l.evidence.kind === "explicit_marker");
      const targetEff = link ? effectiveById.get(link.target_episode_id) : undefined;
      if (targetEff !== undefined && targetEff.realm === "au" && targetEff.auId !== null) {
        const auMarker = scoreAu(p.members.map((m) => m.contentNfc).join("\n"), config.lexicons.au, config.thresholds);
        const conflict = auMarker.auHitIds.some((id) => id !== targetEff.auId);
        if (!conflict) eff = { realm: "au", basis: "continuation_link", auId: targetEff.auId };
      }
    }
    effectiveById.set(p.episode_id, eff);
  }

  // --- domain, status, confidence, assemble ---
  const episodes: Pass1Episode[] = [];
  const memberships: Pass1Membership[] = [];
  let proactiveMessages = 0;
  const uncertain = { fiction_signal: 0, no_evidence: 0 };
  const lowConfidence: string[] = [];

  for (const p of protos) {
    const eff = effectiveById.get(p.episode_id)!;
    const realm = eff.realm;
    const basis = eff.basis;
    const auId = eff.auId;
    if (realm === "uncertain") { if (basis === "fiction_signal") uncertain.fiction_signal += 1; else if (basis === "no_evidence") uncertain.no_evidence += 1; }

    const rangeTurns = collectTurns(partitions, p);
    const memberIndex = new Map<string, number>();
    p.members.forEach((m, i) => memberIndex.set(m.messageId, i));
    const text = p.members.map((m) => m.contentNfc).join("\n");
    const fic = evalFiction(rangeTurns, config.lexicons.au, config.lexicons.fiction);
    const initiator = firstInitiator(rangeTurns);
    const ownerTurns = rangeTurns.filter((t) => !t.proactive && t.messages.some((m) => m.role === "owner")).length;
    const domain = judgeDomain({ realm, basis, initiator, ownerTurns, fic, text, config });

    const sensitivity = pass1Sensitivity(p.members, realm, basis, auId, config);
    const proactiveCount = p.members.filter((m) => m.proactive).length;
    proactiveMessages += proactiveCount;
    const realmConf = basis === "au_lexicon" ? (p.realm.auId !== null && auLead(text, config) >= 2 * config.thresholds.auLeadMin ? 0.9 : 0.7) : (REALM_CONF[basis] ?? 0.3);
    const confidence = Math.round(Math.min(p.startConf, p.endConf, realmConf) * 100) / 100;
    if (confidence <= 0.6) lowConfidence.push(p.episode_id);

    const firstUtc = p.members[0]!.timestampUtc;
    const lastUtc = p.members[p.members.length - 1]!.timestampUtc;
    const localDate = localPlus08(p.members[0]!.epochMs).slice(0, 10);

    episodes.push({
      episode_id: p.episode_id,
      channel: "telegram",
      thread: p.conversationId,
      realm,
      realm_basis: basis,
      au_id: auId,
      domain,
      start_message_id: p.members[0]!.messageId,
      end_message_id: p.members[p.members.length - 1]!.messageId,
      started_at_utc: firstUtc,
      ended_at_utc: lastUtc,
      started_at_local: localPlus08(p.members[0]!.epochMs),
      ended_at_local: localPlus08(p.members[p.members.length - 1]!.epochMs),
      participants: participantsOf(p.members),
      initiator,
      title: fallbackTitle(localDate, realm, auId, p.entities, sensitivity),
      entities_lexical: p.entities,
      status: p.isLastInPartition ? "open_at_archive_end" : "closed",
      continuation_links: p.continuation_links,
      has_continuation: p.has_continuation,
      source_hash: sourceHash(p.members),
      index_version: config.indexVersion,
      summary_version: config.summaryVersion,
      confidence,
      sensitivity,
      message_count: p.members.length,
      proactive_count: proactiveCount,
      overrides_applied_ids: [...new Set(p.overridesAppliedIds)],
      annotations: mergeAnnotations(p.annotations, fic.metaHits, fic.exitHits, memberIndex),
    });
    p.members.forEach((m, seq) => memberships.push({ conversation_id: p.conversationId, message_id: m.messageId, episode_id: p.episode_id, seq }));
  }

  const overrideStates = { applied: 0, reanchored: 0, needs_review: 0, unmatched: 0, no_op: 0 };
  for (const r of overrideRecords) overrideStates[r.state] += 1;

  const report: Pass1Result["report"] = {
    index_version: config.indexVersion,
    summary_version: config.summaryVersion,
    pass1_config_hash: config.expectedConfigHash,
    counts: {
      partitions: partitions.length,
      messages: input.messages.length,
      turns: partitions.reduce((a, p) => a + p.turns.length, 0),
      episodes: episodes.length,
      skipped_non_message: input.skippedNonMessage,
      orphan_assistant: partitions.reduce((a, p) => a + p.turns.filter((t) => t.orphanAssistant).length, 0),
      malformed_message: input.malformed.length,
      proactive_messages: proactiveMessages,
      deferred_field_overrides: compiled.deferredFieldCount,
    },
    uncertain_by_basis: uncertain,
    unresolved_continuations: unresolved,
    low_confidence_episode_ids: lowConfidence,
    override_states: overrideStates,
    realModelCalls: 0,
  };

  const result: Pass1Result = { episodes, memberships, overrides: overrideRecords, report };
  const failure = selfValidatePass1(result, input.messages, partitions, config);
  if (failure !== null) return { ok: false, failure };
  return { ok: true, result };
}

// --- helpers ---------------------------------------------------------------

function collectTurns(partitions: readonly Pass1Partition[], p: Proto) {
  const partition = partitions.find((x) => x.conversationId === p.conversationId)!;
  const memberIds = new Set(p.members.map((m) => m.messageId));
  return partition.turns.filter((t) => t.messages.some((m) => memberIds.has(m.messageId)));
}

function firstInitiator(turns: ReturnType<typeof collectTurns>): Initiator {
  const first = turns[0];
  if (first === undefined) return "owner";
  if (first.proactive) return "companion_proactive";
  return first.messages[0]!.role;
}

function participantsOf(members: readonly Pass1Message[]): Participant[] {
  const set = new Set(members.map((m) => m.role));
  const out: Participant[] = [];
  if (set.has("owner")) out.push("owner");
  if (set.has("companion")) out.push("companion");
  return out;
}

function auLead(text: string, config: Pass1Config): number {
  return scoreAu(text, config.lexicons.au, config.thresholds).lead;
}

function meetsAssign(top: number, second: number, config: Pass1Config): boolean {
  return top >= config.thresholds.auAssignMin && top - second >= config.thresholds.auLeadMin;
}

function judgeDomain(a: {
  realm: string;
  basis: string;
  initiator: Initiator;
  ownerTurns: number;
  fic: { enactmentValid: boolean; metaValid: boolean };
  text: string;
  config: Pass1Config;
}): Domain {
  if (a.initiator === "companion_proactive" && a.ownerTurns === 0) return "proactive";
  if (a.fic.enactmentValid || (a.realm === "au" && !a.fic.metaValid)) return "scene";
  const proj = scoreWeighted(a.text, a.config.lexicons.project);
  const rel = scoreWeighted(a.text, a.config.lexicons.relationship);
  const sched = scoreWeighted(a.text, a.config.lexicons.schedule);
  if (meetsAssign(proj, Math.max(rel, sched), a.config)) return "project";
  if (sched > 0 && sched >= proj && sched >= rel) return "planning";
  if (a.realm === "reality" && meetsAssign(rel, Math.max(proj, sched), a.config)) return "relationship";
  if (a.realm === "reality" || (a.realm === "au" && a.basis !== "au_lexicon")) return "daily";
  if (a.realm === "au") return "daily";
  return "uncertain";
}

const EP_ID = /^ep-[0-9a-f]{32}$/;
const OVERRIDE_STATES = ["applied", "reanchored", "needs_review", "unmatched", "no_op"] as const;

const fail = (detail: string): Pass1Failure => ({ category: "self_validate", detail });

/** Recursively collect every string VALUE (not keys) in a JSON-safe object. */
function collectStringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStringValues(v, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) collectStringValues(v, out);
}

/**
 * Result-internal invariants (C3) — a PURE validation surface checkable from
 * the Pass1Result alone, exported so it is negatively unit-testable and so the
 * offline writer can refuse a corrupted result before writing a single row.
 * Returns the FIRST violation as a stable-category failure, else null.
 */
export function validatePass1ResultInternal(result: Pass1Result): Pass1Failure | null {
  const byEpisode = new Map<string, Pass1Episode>();
  for (const e of result.episodes) {
    if (byEpisode.has(e.episode_id)) return fail("duplicate episode_id");
    byEpisode.set(e.episode_id, e);
  }

  // membership: unique (conv,message_id), episode must exist, no
  // cross-conversation membership, seq contiguous per episode
  const seenMembership = new Set<string>();
  const memsByEp = new Map<string, (typeof result.memberships)[number][]>();
  for (const m of result.memberships) {
    const key = `${m.conversation_id} ${m.message_id}`;
    if (seenMembership.has(key)) return fail("duplicate membership");
    seenMembership.add(key);
    const ep = byEpisode.get(m.episode_id);
    if (ep === undefined) return fail("membership references missing episode");
    if (ep.thread !== m.conversation_id) return fail("membership crosses conversation");
    const mems = memsByEp.get(m.episode_id) ?? [];
    mems.push(m);
    memsByEp.set(m.episode_id, mems);
  }
  for (const [, mems] of memsByEp) {
    const sorted = [...mems].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < sorted.length; i += 1) if (sorted[i]!.seq !== i) return fail("membership seq not contiguous from 0");
  }

  const openByThread = new Map<string, number>();
  const latestEndByThread = new Map<string, number>();
  for (const e of result.episodes) {
    if (!EP_ID.test(e.episode_id)) return fail("malformed episode_id");
    if (episodeIdFor(e.thread, e.start_message_id) !== e.episode_id) return fail("episode_id not derivable from first member");
    if (e.status !== "closed" && e.status !== "open_at_archive_end") return fail("illegal status");
    if (!isDomain(e.domain)) return fail("domain outside the closed enum");
    const okCombo =
      (e.realm === "reality" && e.realm_basis === "configured_prior" && e.au_id === null) ||
      (e.realm === "au" && (e.realm_basis === "au_lexicon" || e.realm_basis === "continuation_link" || e.realm_basis === "configured_prior") && e.au_id !== null) ||
      (e.realm === "uncertain" && (e.realm_basis === "fiction_signal" || e.realm_basis === "no_evidence") && e.au_id === null);
    if (!okCombo) return fail(`illegal realm/basis/au_id combo for ${e.episode_id}`);
    if (Date.parse(e.started_at_utc) > Date.parse(e.ended_at_utc)) return fail("started_at after ended_at");

    const mems = (memsByEp.get(e.episode_id) ?? []).slice().sort((a, b) => a.seq - b.seq);
    if (mems.length === 0) return fail("episode without membership");
    if (mems[0]!.message_id !== e.start_message_id) return fail("start_message_id mismatch");
    if (mems[mems.length - 1]!.message_id !== e.end_message_id) return fail("end_message_id mismatch");
    if (e.message_count !== mems.length) return fail("message_count mismatch");

    for (const l of e.continuation_links) {
      const target = byEpisode.get(l.target_episode_id);
      if (target === undefined) return fail("dangling continuation target");
      if (target.episode_id === e.episode_id) return fail("self-continuation");
      if (Date.parse(target.ended_at_utc) >= Date.parse(e.started_at_utc)) return fail("continuation target not before source");
    }
    if (e.status === "open_at_archive_end") openByThread.set(e.thread, (openByThread.get(e.thread) ?? 0) + 1);
    const end = Date.parse(e.ended_at_utc);
    if (end > (latestEndByThread.get(e.thread) ?? Number.NEGATIVE_INFINITY)) latestEndByThread.set(e.thread, end);
  }
  for (const [, count] of openByThread) if (count > 1) return fail("multiple open_at_archive_end in a thread");
  for (const e of result.episodes) {
    if (e.status === "open_at_archive_end" && Date.parse(e.ended_at_utc) !== latestEndByThread.get(e.thread)) return fail("open episode not thread-latest");
  }

  // has_continuation consistent with the final link graph
  const targeted = new Set<string>();
  for (const e of result.episodes) for (const l of e.continuation_links) targeted.add(l.target_episode_id);
  for (const e of result.episodes) if (e.has_continuation !== targeted.has(e.episode_id)) return fail("has_continuation inconsistent with link graph");

  // every override record carries exactly one legal state, and the report
  // counters must equal a per-state RECOUNT from the actual records
  const recount: Record<string, number> = { applied: 0, reanchored: 0, needs_review: 0, unmatched: 0, no_op: 0 };
  for (const r of result.overrides) {
    if (!(OVERRIDE_STATES as readonly string[]).includes(r.state)) return fail("override record with illegal state");
    recount[r.state]! += 1;
  }
  for (const s of OVERRIDE_STATES) {
    if (result.report.override_states[s] !== recount[s]) return fail(`override state counter mismatch (${s})`);
  }

  if (result.report.realModelCalls !== 0) return fail("nonzero model calls");
  return null;
}

/**
 * Mandatory fail-closed self-validation (§2.12 step 14 / §10 / C3) — the
 * result-internal invariants PLUS the input-dependent checks: full coverage as
 * a set (no omission, no phantom), turn integrity (a turn is never split),
 * member time order, started/ended recomputation, source_hash recomputation,
 * and the report privacy face (no member content, no title, no lexical entity,
 * no lexicon term in any report string value). Exported as a pure surface so
 * every check is negatively unit-testable. Any failure fails the whole build
 * with a stable category and NO partial result.
 */
export function selfValidatePass1(
  result: Pass1Result,
  messages: readonly Pass1Message[],
  partitions: readonly Pass1Partition[],
  config: Pass1Config,
): Pass1Failure | null {
  const internal = validatePass1ResultInternal(result);
  if (internal !== null) return internal;

  const epByMsg = new Map<string, string>();
  const memsByEp = new Map<string, (typeof result.memberships)[number][]>();
  for (const m of result.memberships) {
    epByMsg.set(`${m.conversation_id} ${m.message_id}`, m.episode_id);
    const mems = memsByEp.get(m.episode_id) ?? [];
    mems.push(m);
    memsByEp.set(m.episode_id, mems);
  }

  // full coverage as a SET (no uncovered input, no phantom member)
  const inputKeys = new Set(messages.map((m) => `${m.conversationId} ${m.messageId}`));
  if (epByMsg.size !== inputKeys.size) return fail("membership count mismatch");
  for (const k of inputKeys) if (!epByMsg.has(k)) return fail("uncovered input message");
  for (const k of epByMsg.keys()) if (!inputKeys.has(k)) return fail("phantom membership");

  // turn coverage: every turn's messages all belong to ONE episode (S0)
  for (const part of partitions) {
    for (const turn of part.turns) {
      const eps = new Set<string>();
      for (const m of turn.messages) {
        const ep = epByMsg.get(`${part.conversationId} ${m.messageId}`);
        if (ep === undefined) return fail("turn message not in any episode");
        eps.add(ep);
      }
      if (eps.size !== 1) return fail("turn split across episodes");
    }
  }

  // member time order, timestamps, and source_hash recomputation
  const msgByKey = new Map<string, Pass1Message>();
  for (const m of messages) msgByKey.set(`${m.conversationId} ${m.messageId}`, m);
  for (const e of result.episodes) {
    const mems = (memsByEp.get(e.episode_id) ?? []).slice().sort((a, b) => a.seq - b.seq);
    const members = mems.map((mm) => msgByKey.get(`${mm.conversation_id} ${mm.message_id}`));
    if (members.some((x) => x === undefined)) return fail("episode members gap");
    const mem = members as Pass1Message[];
    for (let i = 1; i < mem.length; i += 1) {
      const a = mem[i - 1]!;
      const b = mem[i]!;
      if (a.epochMs > b.epochMs || (a.epochMs === b.epochMs && a.messageId > b.messageId)) return fail("member time order not monotonic");
    }
    if (mem[0]!.timestampUtc !== e.started_at_utc) return fail("started_at_utc mismatch");
    if (mem[mem.length - 1]!.timestampUtc !== e.ended_at_utc) return fail("ended_at_utc mismatch");
    if (sourceHash(mem) !== e.source_hash) return fail("source_hash mismatch");
  }

  // privacy face: no member content, episode title, lexical entity, or vetted
  // lexicon term may appear in ANY report string value (values only — schema
  // keys are fixed English words and would false-positive on prefix terms)
  const values: string[] = [];
  collectStringValues(result.report, values);
  // Structural values (episode ids, sha256 hashes, the registered version
  // identifiers) can never carry content — exclude them so a short lexical
  // entity cannot false-positive on an id substring or a version label.
  const joined = values
    .filter((v) => !EP_ID.test(v) && !/^sha256:[0-9a-f]{64}$/.test(v) && v !== config.indexVersion && v !== config.summaryVersion)
    .join("\n");
  for (const m of messages) if (m.contentNfc.length >= 4 && joined.includes(m.contentNfc)) return fail("member content leaked into report");
  for (const e of result.episodes) {
    if (e.title.length > 0 && joined.includes(e.title)) return fail("episode title leaked into report");
    for (const w of e.entities_lexical) if (w.length >= 2 && joined.includes(w)) return fail("lexical entity leaked into report");
  }
  const lex = config.lexicons;
  const allTerms: string[] = [
    ...lex.continuation.terms,
    ...lex.au.entries.flatMap((a) => [...a.unique_terms, ...a.shared_terms]),
    ...lex.fiction.entries.map((f) => f.term),
    ...lex.project.terms.map((t) => t.term),
    ...lex.relationship.terms.map((t) => t.term),
    ...lex.schedule.terms.map((t) => t.term),
    ...lex.sensitivity.entries.map((s) => s.term),
  ];
  for (const t of allTerms) if (t.length >= 2 && joined.includes(t)) return fail("lexicon term leaked into report");

  return null;
}
