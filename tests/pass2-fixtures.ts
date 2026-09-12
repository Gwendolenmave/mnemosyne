/**
 * Shared L1-T03 Pass2 test fixtures (NOT a test file). Synthetic-only:
 * clearly-synthetic prompts, lexicons, model id, and 2099 dates — no real
 * prompt, model, transcript, or vocabulary. Provides the injected summary
 * bundle / manifest / config builders plus small helpers reused across the
 * Pass2 pure-core tests.
 */

import { PAYLOAD_VERSION } from "../core/domain/episode.js";
import { canonicalMemberHash } from "../core/services/episode-pass1.js";
import { localParts } from "../core/services/time-labels.js";
import { summaryBundleHash } from "../core/services/episode-summary-bundle.js";
import { buildMetaHeader } from "../core/services/episode-summary-input.js";
import type { ValidatorContext } from "../core/services/episode-summary-validation.js";
import type { Pass1Episode, Pass1Message } from "../core/domain/episode-pass1.js";
import type {
  ChunkModelOutput,
  EpisodeModelOutput,
  Pass2Config,
  SummaryBundle,
  SummaryBundleManifest,
} from "../core/domain/episode-pass2.js";

/** A synthetic summary bundle — all term lists ascending-sorted for stable authoring. */
export function syntheticBundle(overrides: Partial<SummaryBundle> = {}): SummaryBundle {
  return {
    bundleSchemaVersion: "bundle-synthetic-v0",
    summaryVersion: "sum-synthetic-v0",
    episodePrompt: "SYNTHETIC EPISODE PROMPT — record what happened.",
    chunkPrompt: "SYNTHETIC CHUNK PROMPT — extract facts from this block.",
    assemblyPrompt: "SYNTHETIC ASSEMBLY PROMPT — merge validated chunk summaries.",
    fewShots: ["SYNTH-FEWSHOT-POS", "SYNTH-FEWSHOT-NEG"],
    predictionBlacklist: ["PREDICT-NEXT", "PREDICT-WILL"],
    sensitivityLexicon: ["SENS-INTIMATE-A", "SENS-INTIMATE-B"],
    auLexiconVersion: "synthetic-test-v0",
    fictionLexiconVersion: "synthetic-test-v0",
    // R1 typed lexicon: REL-LASTNIGHT carries the previous-evening day rule
    // (byte-equal output to the retired synthetic recompute, so frozen V12
    // expectations keyed on it stay valid); REL-SOON is an explicit null rule.
    temporalHintLexicon: [
      { term: "REL-LASTNIGHT", normalizer: { kind: "day", offset_days: -1, start_minute: 1020, end_minute: 1439 } },
      { term: "REL-SOON", normalizer: null },
    ],
    // Two entries so a key-order-independence fixture is expressible (B). The
    // synthetic row's au-alpha resolves to AU-ALPHA-DISPLAY — the display word
    // used by header/prompt/V4 everywhere.
    auDisplayById: { "au-alpha": "AU-ALPHA-DISPLAY", "au-beta": "AU-BETA-DISPLAY" },
    ...overrides,
  };
}

/** A manifest whose registered hash matches the given bundle (no drift). */
export function syntheticManifest(bundle: SummaryBundle = syntheticBundle()): SummaryBundleManifest {
  return { summaryVersion: bundle.summaryVersion, summaryBundleHash: summaryBundleHash(bundle) };
}

/** A synthetic Pass2 config — payloadVersion pinned to the T01 contract. */
export function syntheticConfig(overrides: Partial<Pass2Config> = {}): Pass2Config {
  return {
    chunkMax: 200,
    maxChunks: 8,
    payloadVersion: PAYLOAD_VERSION,
    summaryVersion: "sum-synthetic-v0",
    modelId: "synthetic-model-x",
    indexVersion: "p1-v1",
    createdAt: "2099-01-01T12:00:00+08:00",
    ...overrides,
  };
}

/** A minimal valid chunk model output (5 fields). */
export function chunkOutput(overrides: Partial<ChunkModelOutput> = {}): ChunkModelOutput {
  return {
    claims: [{ text: "a fact occurred", kind: "event", evidence_message_ids: ["m-1"] }],
    entities: [],
    temporal_hints: [],
    confidence: 0.8,
    uncertain_flags: [],
    ...overrides,
  };
}

/** A minimal episode/assembly model output (9 fields). */
export function episodeOutput(overrides: Partial<EpisodeModelOutput> = {}): EpisodeModelOutput {
  return {
    title: "synthetic title",
    summary: "placeholder.",
    claims: [{ text: "a fact occurred", kind: "event", evidence_message_ids: ["m-1"] }],
    entities: [],
    temporal_hints: [],
    domain_suggestion: null,
    sensitivity: "normal",
    confidence: 0.8,
    uncertain_flags: [],
    ...overrides,
  };
}

// --- synthetic Pass1 episode row + ordered members ------------------------

export interface MemberSpec {
  role: "owner" | "companion";
  offsetSec: number;
  content: string;
  messageId: string;
  proactive?: boolean;
}

const CONV = "c-20990101-0002";
const BASE_UTC = "2099-01-02T12:00:00.000Z";

export function syntheticMembers(specs: readonly MemberSpec[]): Pass1Message[] {
  const baseMs = Date.parse(BASE_UTC);
  return specs.map((s, i) => {
    const ts = new Date(baseMs + s.offsetSec * 1000).toISOString();
    return {
      sourceFileId: `${CONV}.jsonl`,
      sourceLine: i + 1,
      conversationId: CONV,
      eventType: s.role === "owner" ? "user_message_persisted" : "assistant_message_persisted",
      role: s.role,
      messageId: s.messageId,
      turnId: null,
      timestampUtc: ts,
      epochMs: Date.parse(ts),
      contentNfc: s.content.normalize("NFC"),
      proactive: s.proactive === true,
    } satisfies Pass1Message;
  });
}

/**
 * A synthetic Pass1 episode row whose source_hash is a REAL canonicalMemberHash
 * over the members (so candidate-builder tests find provenance.source_hash
 * consistent). Realm defaults to au/au-alpha/scene.
 */
export function syntheticEpisode(
  memberSpecs: readonly MemberSpec[] = [
    { role: "owner", offsetSec: 0, content: "we set the plan for tomorrow", messageId: "m-1" },
    { role: "companion", offsetSec: 60, content: "understood, noted it", messageId: "m-2" },
  ],
  rowOverrides: Partial<Pass1Episode> = {},
): { row: Pass1Episode; members: Pass1Message[] } {
  const members = syntheticMembers(memberSpecs);
  const first = members[0]!;
  const last = members[members.length - 1]!;
  const source_hash = canonicalMemberHash(members.map((m) => ({ id: m.messageId, timestampUtc: m.timestampUtc, role: m.role, content: m.contentNfc })));
  const row: Pass1Episode = {
    episode_id: `ep-${"a".repeat(32)}`,
    channel: "telegram",
    thread: CONV,
    realm: "au",
    realm_basis: "au_lexicon",
    au_id: "au-alpha",
    domain: "scene",
    start_message_id: first.messageId,
    end_message_id: last.messageId,
    started_at_utc: first.timestampUtc,
    ended_at_utc: last.timestampUtc,
    started_at_local: `${localParts(first.timestampUtc)!.localDate}T${localParts(first.timestampUtc)!.localClock}:00.000+08:00`,
    ended_at_local: `${localParts(last.timestampUtc)!.localDate}T${localParts(last.timestampUtc)!.localClock}:00.000+08:00`,
    participants: [...new Set(members.map((m) => m.role))],
    initiator: members[0]!.role,
    title: "synthetic pass1 title",
    entities_lexical: [],
    status: "closed",
    continuation_links: [],
    has_continuation: false,
    source_hash,
    index_version: "p1-v1",
    summary_version: "sum-synthetic-v0",
    confidence: 0.9,
    sensitivity: "normal",
    message_count: members.length,
    proactive_count: members.filter((m) => m.proactive).length,
    overrides_applied_ids: [],
    annotations: [],
    ...rowOverrides,
  };
  return { row, members };
}

// --- validator context + a passing model output ---------------------------

const VALIDATOR_MEMBERS: MemberSpec[] = [
  { role: "owner", offsetSec: 0, content: "we planned the trip to the coast", messageId: "m-1" },
  { role: "companion", offsetSec: 60, content: "noted it and confirmed", messageId: "m-2" },
];

/**
 * A synthetic episode ValidatorContext (kind=episode) over known member text.
 * Convenience: passing `memberText` sets BOTH `visibleText` (V8) and
 * `fullMessageText` (V6/V12) to the same map — for an episode there is no
 * chunk-local/whole-message distinction. A closure-review-A test that needs the
 * two to differ overrides `visibleText`/`fullMessageText` explicitly.
 */
export function validatorContext(overrides: Partial<ValidatorContext> & { memberText?: ReadonlyMap<string, string> } = {}): ValidatorContext {
  const { row, members } = syntheticEpisode(VALIDATOR_MEMBERS);
  const bundle = overrides.bundle ?? syntheticBundle();
  const header = buildMetaHeader(row, bundle.auDisplayById)!; // synthetic au-alpha resolves
  const { memberText, ...rest } = overrides;
  const baseText = memberText ?? new Map(members.map((m) => [m.messageId, m.contentNfc]));
  return {
    kind: "episode",
    header,
    memberIds: new Set(members.map((m) => m.messageId)),
    visibleText: baseText,
    fullMessageText: baseText,
    memberTimestamps: new Map(members.map((m) => [m.messageId, m.timestampUtc])),
    sliceOrdinals: new Map(),
    legalRefs: null,
    metadataLabels: [header.realmDisplay, ...header.participants, ...header.domainSuggestions],
    bundle,
    pass1Domain: row.domain,
    assemblyEvidenceUnion: null,
    ...rest,
  };
}

/** A model output that PASSES every episode validator for a given context. */
export function passingEpisodeOutput(ctx: ValidatorContext): EpisodeModelOutput {
  return {
    title: "行程记录",
    summary: `${ctx.header.timeString}在${ctx.header.realmDisplay}层面展开。计划已确定。细节已记录。`,
    claims: [{ text: "计划已确定", kind: "decision", evidence_message_ids: ["m-1"] }],
    entities: ["trip"],
    temporal_hints: [],
    domain_suggestion: ctx.pass1Domain,
    sensitivity: "normal",
    confidence: 0.8,
    uncertain_flags: [],
  };
}
