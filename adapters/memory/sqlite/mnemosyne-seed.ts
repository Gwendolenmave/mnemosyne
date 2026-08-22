/**
 * Mnemosyne reviewed seed pack (M2-5): the only supported way real House
 * Priors and first confirmed Memory Cards enter a database. A pack is a
 * human-reviewed JSON document; this module validates it as untrusted
 * input, refuses the WHOLE pack on any violation, and otherwise lands it
 * atomically in a FRESH database file (never an existing one).
 *
 * Standing refusals (each aborts with nothing left on disk):
 *   - the target database already exists (seeding is for fresh isolated
 *     files; migrating a live household database is a different, human-
 *     approved operation that does not exist yet);
 *   - any card title/body caught by directive/structural quarantine —
 *     seeding cannot bypass the admission gate retrieval enforces;
 *   - any sensitivity other than "normal" (M2-5 batch rule: no intimate
 *     or high-sensitivity seed cards);
 *   - House Prior texts exceeding the approved priors token budget;
 *   - anything the domain validators reject. The loader emits ONLY
 *     attributes_set / confirmed / prior_proposed / prior_approved —
 *     it has no vocabulary for retrieval_set, sealing, or expiry
 *     overrides, so a pack cannot force-release quarantined text.
 *
 * Confirmation and prior approval events carry the human actor named in
 * the pack; "system" is structurally impossible here and would also be
 * rejected by the domain's human-actor rule.
 */

import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { MemoryEventEnvelope } from "../../../core/domain/memory.js";
import { isCanonicalUuid } from "../../../core/domain/ids.js";
import { isIsoUtcTimestamp } from "../../../core/domain/memory-validation.js";
import type { MnemosyneEnvelope, PriorKey } from "../../../core/domain/mnemosyne.js";
import {
  DEFAULT_BUDGETS,
  assessUntrustedBody,
  estimateTokens,
} from "../../../core/services/anamnesis.js";
import { openMnemosyne } from "./mnemosyne-facade.js";
import type { SqliteBackupReport } from "./sqlite-memory-event-log.js";

export interface SeedIssue {
  path: string;
  message: string;
}

export interface SeedPrior {
  key: PriorKey;
  body: string;
  changelog: string;
  /** UTC Date.toISOString() instant or null for no expiry. */
  expiresAt: string | null;
  approvedBy: "owner" | "companion" | "both";
  /** Exact provenance pointer (document@checksum#anchor); stored as a prior source row. */
  sourcePointer: string;
}

export interface SeedCard {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  scope: "global" | "relationship" | "project" | "au";
  auId?: string;
  importance: 1 | 2 | 3;
  /** M2-5 batch rule: only "normal" is accepted. */
  sensitivity: "normal";
  sourceBasis: "explicit" | "inferred" | "derived";
  /** Locator inside the pack's source document (e.g. "#B.1"). */
  recordLocator: string;
  /** Who authored the cited record content. */
  author: "user" | "assistant" | "unknown";
  /** null leaves the card as a candidate awaiting human confirmation. */
  confirmedBy: "owner" | "companion" | "both" | null;
}

export interface SeedPack {
  packName: string;
  /** The reviewed document every evidence pointer resolves against. */
  sourceDocument: { importId: string; path: string; sha256: string };
  priors: SeedPrior[];
  cards: SeedCard[];
}

export interface SeedManifest {
  packName: string;
  dbPath: string;
  backup: SqliteBackupReport;
  sourceDocument: SeedPack["sourceDocument"];
  priors: Array<{
    key: string;
    version: number;
    tokenEst: number;
    expiresAt: string | null;
    approvedBy: string;
    sourcePointer: string;
  }>;
  priorTokenTotal: number;
  priorTokenBudget: number;
  cards: Array<{
    slug: string;
    memoryId: string;
    approvalState: "confirmed" | "candidate";
    confirmedBy: string | null;
    sourcePointer: string;
  }>;
  events: Array<{
    eventId: string;
    stream: "kernel" | "governance";
    type: string;
    subject: string;
    actor: string;
  }>;
  checks: {
    quarantineAssessed: number;
    retrievalSetEvents: 0;
    sealEvents: 0;
    sensitivityAllNormal: true;
    fragmentsSeeded: 0;
  };
}

export type SeedOutcome =
  | { status: "seeded"; manifest: SeedManifest }
  | { status: "refused"; issues: SeedIssue[] };

const PRIOR_KEYS: readonly string[] = ["identity", "relationship", "household_now", "project_now"];
const SEED_SCOPES: readonly string[] = ["global", "relationship", "project", "au"];
const SLUG_RE = /^[a-z][a-z0-9-]{0,47}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural + policy validation of an untrusted seed pack document. */
export function validateSeedPack(
  input: unknown,
): { ok: true; value: SeedPack } | { ok: false; issues: SeedIssue[] } {
  const issues: SeedIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "$", message: "seed pack must be an object" }] };
  }
  if (typeof input.packName !== "string" || input.packName.trim().length === 0) {
    issues.push({ path: "$.packName", message: "packName required" });
  }
  const doc = input.sourceDocument;
  if (!isRecord(doc)) {
    issues.push({ path: "$.sourceDocument", message: "sourceDocument required" });
  } else {
    if (typeof doc.importId !== "string" || !isCanonicalUuid(doc.importId)) {
      issues.push({ path: "$.sourceDocument.importId", message: "importId must be a canonical UUID" });
    }
    if (typeof doc.path !== "string" || doc.path.length === 0) {
      issues.push({ path: "$.sourceDocument.path", message: "path required" });
    }
    if (typeof doc.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(doc.sha256)) {
      issues.push({ path: "$.sourceDocument.sha256", message: "sha256 must be 64 lowercase hex chars" });
    }
  }

  const priors = input.priors;
  if (!Array.isArray(priors)) {
    issues.push({ path: "$.priors", message: "priors must be an array" });
  } else {
    const seenKeys = new Set<string>();
    let priorTokenTotal = 0;
    priors.forEach((raw, i) => {
      const path = `$.priors[${i}]`;
      if (!isRecord(raw)) {
        issues.push({ path, message: "prior must be an object" });
        return;
      }
      if (typeof raw.key !== "string" || !PRIOR_KEYS.includes(raw.key)) {
        issues.push({ path: `${path}.key`, message: "invalid prior key" });
      } else if (seenKeys.has(raw.key)) {
        issues.push({ path: `${path}.key`, message: "duplicate prior key in pack" });
      } else {
        seenKeys.add(raw.key);
      }
      if (typeof raw.body !== "string" || raw.body.trim().length === 0) {
        issues.push({ path: `${path}.body`, message: "body required" });
      } else {
        priorTokenTotal += estimateTokens(raw.body);
      }
      if (typeof raw.changelog !== "string" || raw.changelog.trim().length === 0) {
        issues.push({ path: `${path}.changelog`, message: "changelog required" });
      }
      if (raw.expiresAt !== null && (typeof raw.expiresAt !== "string" || !isIsoUtcTimestamp(raw.expiresAt))) {
        issues.push({
          path: `${path}.expiresAt`,
          message: "expiresAt must be null or a UTC Date.toISOString() timestamp",
        });
      }
      if (!["owner", "companion", "both"].includes(raw.approvedBy as string)) {
        issues.push({ path: `${path}.approvedBy`, message: "approvedBy must be owner|companion|both" });
      }
      if (typeof raw.sourcePointer !== "string" || raw.sourcePointer.trim().length === 0) {
        issues.push({ path: `${path}.sourcePointer`, message: "sourcePointer required" });
      }
    });
    if (priorTokenTotal > DEFAULT_BUDGETS.priorsTokens) {
      issues.push({
        path: "$.priors",
        message:
          `House Prior texts estimate ${priorTokenTotal} tokens, over the approved ` +
          `${DEFAULT_BUDGETS.priorsTokens}-token budget — trim the texts or get the budget re-approved`,
      });
    }
  }

  const cards = input.cards;
  if (!Array.isArray(cards)) {
    issues.push({ path: "$.cards", message: "cards must be an array" });
  } else {
    const seenSlugs = new Set<string>();
    cards.forEach((raw, i) => {
      const path = `$.cards[${i}]`;
      if (!isRecord(raw)) {
        issues.push({ path, message: "card must be an object" });
        return;
      }
      if (typeof raw.slug !== "string" || !SLUG_RE.test(raw.slug)) {
        issues.push({ path: `${path}.slug`, message: "slug must match ^[a-z][a-z0-9-]{0,47}$" });
      } else if (seenSlugs.has(raw.slug)) {
        issues.push({ path: `${path}.slug`, message: "duplicate slug in pack" });
      } else {
        seenSlugs.add(raw.slug);
      }
      for (const field of ["title", "body", "recordLocator"] as const) {
        if (typeof raw[field] !== "string" || (raw[field] as string).trim().length === 0) {
          issues.push({ path: `${path}.${field}`, message: `${field} required` });
        }
      }
      if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== "string" || t.length === 0)) {
        issues.push({ path: `${path}.tags`, message: "tags must be non-empty strings" });
      }
      if (typeof raw.scope !== "string" || !SEED_SCOPES.includes(raw.scope)) {
        issues.push({
          path: `${path}.scope`,
          message: "seed scope must be global|relationship|project|au (session is not seedable)",
        });
      }
      if (raw.scope === "au" && (typeof raw.auId !== "string" || raw.auId.length === 0)) {
        issues.push({ path: `${path}.auId`, message: "au scope requires auId" });
      }
      if (raw.scope !== "au" && raw.auId !== undefined) {
        issues.push({ path: `${path}.auId`, message: "auId is only allowed with au scope" });
      }
      if (![1, 2, 3].includes(raw.importance as number)) {
        issues.push({ path: `${path}.importance`, message: "importance must be 1..3" });
      }
      if (raw.sensitivity !== "normal") {
        issues.push({
          path: `${path}.sensitivity`,
          message: 'M2-5 batch rule: sensitivity must be "normal" (no intimate or high-sensitivity seeds)',
        });
      }
      if (!["explicit", "inferred", "derived"].includes(raw.sourceBasis as string)) {
        issues.push({ path: `${path}.sourceBasis`, message: "sourceBasis must be explicit|inferred|derived" });
      }
      if (!["user", "assistant", "unknown"].includes(raw.author as string)) {
        issues.push({ path: `${path}.author`, message: "author must be user|assistant|unknown" });
      }
      if (raw.confirmedBy !== null && !["owner", "companion", "both"].includes(raw.confirmedBy as string)) {
        issues.push({
          path: `${path}.confirmedBy`,
          message: "confirmedBy must be owner|companion|both, or null to leave the card a candidate",
        });
      }
      // Admission quarantine runs at seed time too: a directive-like card
      // is refused outright, never stored and never force-releasable.
      for (const field of ["title", "body"] as const) {
        const text = raw[field];
        if (typeof text === "string") {
          const admission = assessUntrustedBody(text);
          if (!admission.ok) {
            issues.push({ path: `${path}.${field}`, message: admission.reason });
          }
        }
      }
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: structuredClone(input) as unknown as SeedPack };
}

class SeedRefusal extends Error {
  constructor(readonly issues: SeedIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "SeedRefusal";
  }
}

/** A human actor for a governance event approved/confirmed by `by`. */
function humanActor(by: "owner" | "companion" | "both"): "owner" | "companion" {
  return by === "companion" ? "companion" : "owner";
}

/**
 * Land a validated pack in a FRESH database. All-or-nothing: on any
 * refusal or error the created file (and its sidecars) is removed.
 */
export async function runSeed(packInput: unknown, dbPath: string): Promise<SeedOutcome> {
  const validated = validateSeedPack(packInput);
  if (!validated.ok) {
    return { status: "refused", issues: validated.issues };
  }
  const pack = validated.value;
  if (existsSync(dbPath)) {
    return {
      status: "refused",
      issues: [
        {
          path: "$",
          message: `refusing to seed into an existing database (${dbPath}); seeding only creates fresh isolated files`,
        },
      ],
    };
  }

  const base = Date.now();
  let tick = 0;
  const stampNext = (): string => new Date(base + tick++).toISOString();

  const handle = openMnemosyne(dbPath);
  const events: SeedManifest["events"] = [];
  try {
    // Kernel stream: one memory_created per card, evidence pointing at the
    // reviewed source document (pointers only — never copied text).
    const cardIds = new Map<string, string>();
    const kernelEnvelopes: MemoryEventEnvelope[] = pack.cards.map((card) => {
      const memoryId = randomUUID();
      cardIds.set(card.slug, memoryId);
      const envelope = {
        schemaVersion: 1,
        eventId: randomUUID(),
        occurredAt: stampNext(),
        event: {
          type: "memory_created",
          memoryId,
          content: card.body,
          evidence: {
            kind: "imported",
            source: {
              kind: "imported_record",
              importId: pack.sourceDocument.importId,
              recordLocator: `${pack.sourceDocument.path}@sha256:${pack.sourceDocument.sha256.slice(0, 12)}${card.recordLocator}`,
              author: card.author,
            },
          },
          scope: { kind: "shared" },
        },
      };
      events.push({
        eventId: envelope.eventId,
        stream: "kernel",
        type: "memory_created",
        subject: card.slug,
        actor: "system",
      });
      return envelope as unknown as MemoryEventEnvelope;
    });

    const governance: MnemosyneEnvelope[] = [];
    for (const card of pack.cards) {
      const memoryId = cardIds.get(card.slug)!;
      const attributes: MnemosyneEnvelope = {
        eventId: randomUUID(),
        occurredAt: stampNext(),
        actor: "system",
        event: {
          type: "attributes_set",
          memoryId,
          title: card.title,
          tags: [...card.tags],
          scope: card.scope,
          ...(card.scope === "au" ? { auId: card.auId! } : {}),
          sensitivity: card.sensitivity,
          importance: card.importance,
          sourceBasis: card.sourceBasis,
        },
      };
      governance.push(attributes);
      events.push({
        eventId: attributes.eventId,
        stream: "governance",
        type: "attributes_set",
        subject: card.slug,
        actor: "system",
      });
      if (card.confirmedBy !== null) {
        const confirmed: MnemosyneEnvelope = {
          eventId: randomUUID(),
          occurredAt: stampNext(),
          actor: humanActor(card.confirmedBy),
          event: { type: "confirmed", memoryId, by: card.confirmedBy },
        };
        governance.push(confirmed);
        events.push({
          eventId: confirmed.eventId,
          stream: "governance",
          type: "confirmed",
          subject: card.slug,
          actor: confirmed.actor,
        });
      }
    }
    for (const prior of pack.priors) {
      const proposed: MnemosyneEnvelope = {
        eventId: randomUUID(),
        occurredAt: stampNext(),
        actor: "system",
        event: {
          type: "prior_proposed",
          key: prior.key,
          body: prior.body,
          tokenEst: estimateTokens(prior.body),
          changelog: prior.changelog,
          expiresAt: prior.expiresAt,
        },
      };
      const approved: MnemosyneEnvelope = {
        eventId: randomUUID(),
        occurredAt: stampNext(),
        actor: humanActor(prior.approvedBy),
        event: { type: "prior_approved", key: prior.key, by: prior.approvedBy },
      };
      governance.push(proposed, approved);
      events.push({
        eventId: proposed.eventId,
        stream: "governance",
        type: "prior_proposed",
        subject: prior.key,
        actor: "system",
      });
      events.push({
        eventId: approved.eventId,
        stream: "governance",
        type: "prior_approved",
        subject: prior.key,
        actor: approved.actor,
      });
    }

    // Belt and suspenders for the M2-5 "no force-release" rule: the loader
    // must never have produced an override event of any kind.
    const forbidden = governance.filter((envelope) =>
      ["retrieval_set", "sealed", "unsealed", "expiry_set"].includes(envelope.event.type),
    );
    if (forbidden.length > 0) {
      throw new SeedRefusal([
        { path: "$", message: "internal error: seed loader produced an override event" },
      ]);
    }

    const kernelOutcome = await handle.log.appendToEmpty(kernelEnvelopes);
    if (kernelOutcome.status !== "appended") {
      throw new SeedRefusal(
        kernelOutcome.status === "rejected"
          ? kernelOutcome.issues
          : [{ path: "$", message: "database was not empty at seed time" }],
      );
    }
    const governanceOutcome = handle.store.appendGovernance(governance);
    if (governanceOutcome.status !== "appended") {
      throw new SeedRefusal(governanceOutcome.issues);
    }
    for (const prior of pack.priors) {
      handle.store.addSource({
        id: randomUUID(),
        subjectKind: "prior",
        subjectId: prior.key,
        kind: "directive",
        pointer: prior.sourcePointer,
      });
    }
    await handle.store.rebuildProjections();

    // Post-seed verification: the projections must say exactly what the
    // reviewed pack intended before we call this database seeded.
    const verifyIssues: SeedIssue[] = [];
    const manifestCards: SeedManifest["cards"] = [];
    for (const card of pack.cards) {
      const memoryId = cardIds.get(card.slug)!;
      const item = handle.store.getItem(memoryId);
      const wanted = card.confirmedBy !== null ? "confirmed" : "candidate";
      if (item === undefined) {
        verifyIssues.push({ path: card.slug, message: "card missing from projections" });
        continue;
      }
      if (item.approval_state !== wanted) {
        verifyIssues.push({
          path: card.slug,
          message: `approval_state ${item.approval_state}, wanted ${wanted}`,
        });
      }
      if (item.retrieval !== "enabled") {
        verifyIssues.push({ path: card.slug, message: `retrieval ${item.retrieval}, wanted enabled` });
      }
      manifestCards.push({
        slug: card.slug,
        memoryId,
        approvalState: wanted,
        confirmedBy: card.confirmedBy,
        sourcePointer: handle.store.listSources("memory", memoryId)[0]?.pointer ?? "(missing)",
      });
    }
    const priorRows = handle.store.listPriors();
    if (priorRows.length !== pack.priors.length) {
      verifyIssues.push({
        path: "$.priors",
        message: `${priorRows.length} priors materialized, wanted ${pack.priors.length}`,
      });
    }
    const firstTag = pack.cards[0]?.tags[0];
    if (firstTag !== undefined && handle.store.ftsSearch(firstTag, 1).length === 0) {
      verifyIssues.push({ path: "$.cards", message: `fts probe for "${firstTag}" returned nothing` });
    }
    if (verifyIssues.length > 0) {
      throw new SeedRefusal(verifyIssues);
    }

    const backup = handle.log.backupTo(`${dbPath}.backup`);
    const manifest: SeedManifest = {
      packName: pack.packName,
      dbPath,
      backup,
      sourceDocument: pack.sourceDocument,
      priors: pack.priors.map((prior) => ({
        key: prior.key,
        version: 1,
        tokenEst: estimateTokens(prior.body),
        expiresAt: prior.expiresAt,
        approvedBy: prior.approvedBy,
        sourcePointer: prior.sourcePointer,
      })),
      priorTokenTotal: pack.priors.reduce((sum, prior) => sum + estimateTokens(prior.body), 0),
      priorTokenBudget: DEFAULT_BUDGETS.priorsTokens,
      cards: manifestCards,
      events,
      checks: {
        quarantineAssessed: pack.cards.length * 2,
        retrievalSetEvents: 0,
        sealEvents: 0,
        sensitivityAllNormal: true,
        fragmentsSeeded: 0,
      },
    };
    handle.log.close();
    return { status: "seeded", manifest };
  } catch (error) {
    cleanupFreshDb(handle, dbPath);
    if (error instanceof SeedRefusal) {
      return { status: "refused", issues: error.issues };
    }
    throw error;
  }
}

function cleanupFreshDb(handle: { log: { close(): void } }, dbPath: string): void {
  try {
    handle.log.close();
  } catch {
    // already closed or unusable — removal below is what matters
  }
  for (const suffix of ["", "-wal", "-shm", ".backup"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}
