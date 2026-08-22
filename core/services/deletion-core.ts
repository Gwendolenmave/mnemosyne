/**
 * T05B — deletion, split into the two different things it has always been.
 *
 * LM-GATE-01 amendment C, and the reason it exists: "delete" in a memory system
 * means two incompatible operations, and systems that offer one button for both
 * either cannot honour a real erasure request or destroy history by accident.
 *
 *   FORGET      logical. The item stops existing for retrieval, ranking, context
 *               assembly and every read path, immediately. Nothing is unlinked;
 *               the event history that records the forgetting is itself kept.
 *               This is ordinary, reversible, and needs no special authority.
 *
 *   HARD PURGE  physical. Bytes are destroyed across EVERY registry that holds
 *               them — live databases, derived projections, quarantine, receipts
 *               and, critically, backups, which is the copy naive purges miss and
 *               which resurrects the data on the next restore. It is irreversible,
 *               it destroys evidence by design, and it is Owner's to trigger.
 *
 * This module is pure. It plans; it never deletes. The execution guard below is
 * the boundary the master programme draws in SS4.2 and SS7: the path is built and
 * proven, and it is exercised ONLY against synthetic data. Nothing in this
 * programme's authority can make `assertPurgeExecutable` return ok for a tree
 * holding Owner's real transcripts, memories, backups or Core documents.
 */

/** A logical forget is described by what it makes invisible, never by a file. */
export interface ForgetPlan {
  readonly memoryId: string;
  readonly reason: string;
  /** the read paths that must stop returning it, enumerated so none is forgotten */
  readonly suppressedReadPaths: readonly ReadPath[];
  /** the governance events that record the forgetting; history grows, never shrinks */
  readonly events: readonly { readonly kind: string; readonly detail: string }[];
  readonly bytesDestroyed: 0;
}

export type ReadPath =
  | "anamnesis_context_assembly"
  | "fts_search"
  | "ranking_and_trust"
  | "proactive_candidate_pool"
  | "governance_tray_listing"
  | "episode_projection_input";

export const READ_PATHS: readonly ReadPath[] = [
  "anamnesis_context_assembly", "fts_search", "ranking_and_trust",
  "proactive_candidate_pool", "governance_tray_listing", "episode_projection_input",
] as const;

/**
 * A forget must name EVERY read path. A plan that suppressed four of six would
 * leave a "deleted" memory reachable through the two it forgot, which is the
 * failure mode the audit found in two of the ten deeply reviewed systems.
 */
export function planForget(memoryId: string, reason: string): ForgetPlan {
  return {
    memoryId,
    reason,
    suppressedReadPaths: READ_PATHS,
    events: [
      { kind: "retrieval_set", detail: "false (human)" },
      { kind: "memory_deactivated", detail: reason },
    ],
    bytesDestroyed: 0,
  };
}

// ---------------------------------------------------------------------------
// Hard purge
// ---------------------------------------------------------------------------

/** Every physical place a Delos item's bytes can be. Missing one defeats a purge. */
export type PurgeRegistry =
  | "mnemosyne_items"
  | "mnemosyne_event_log"
  | "mnemosyne_fts_projection"
  | "decision_backlog"
  | "decision_receipts"
  | "episode_projection"
  | "transcript_files"
  | "quarantine_root"
  | "receipt_root"
  | "backup_packages";

export const PURGE_REGISTRIES: readonly PurgeRegistry[] = [
  "mnemosyne_items", "mnemosyne_event_log", "mnemosyne_fts_projection",
  "decision_backlog", "decision_receipts", "episode_projection",
  "transcript_files", "quarantine_root", "receipt_root", "backup_packages",
] as const;

/**
 * Owner's authorisation. Not a boolean: a boolean is something a caller can pass
 * by mistake, and something a config file can hold.
 */
export interface OwnerPurgeAuthorization {
  readonly ownerActor: "owner";
  readonly issuedAt: string;
  /** the exact subject; a wildcard scope is refused below */
  readonly subjectId: string;
  /** typed back by the owner at the moment of authorising, not stored anywhere */
  readonly confirmationPhrase: string;
}

export interface PurgePlanEntry {
  readonly registry: PurgeRegistry;
  readonly locator: string;
  readonly occurrences: number;
}

export interface PurgePlan {
  readonly subjectId: string;
  readonly entries: readonly PurgePlanEntry[];
  /** registries with nothing to purge; listed so "absent" is distinguished from "unchecked" */
  readonly emptyRegistries: readonly PurgeRegistry[];
  /** registries no census covered — a purge with any of these is NOT complete */
  readonly uncheckedRegistries: readonly PurgeRegistry[];
  readonly complete: boolean;
}

/**
 * Build the plan. `census` maps each registry it examined to the occurrences it
 * found; a registry absent from the census is UNCHECKED, not empty, and makes the
 * plan incomplete. A purge that reports success while never having looked in the
 * backup packages is the resurrection bug.
 */
export function planHardPurge(
  subjectId: string,
  census: Readonly<Partial<Record<PurgeRegistry, readonly { locator: string; occurrences: number }[]>>>,
): PurgePlan {
  const entries: PurgePlanEntry[] = [];
  const empty: PurgeRegistry[] = [];
  const unchecked: PurgeRegistry[] = [];
  for (const registry of PURGE_REGISTRIES) {
    const found = census[registry];
    if (found === undefined) {
      unchecked.push(registry);
      continue;
    }
    if (found.length === 0) {
      empty.push(registry);
      continue;
    }
    for (const f of found) {
      entries.push({ registry, locator: f.locator, occurrences: f.occurrences });
    }
  }
  return {
    subjectId,
    entries,
    emptyRegistries: empty,
    uncheckedRegistries: unchecked,
    complete: unchecked.length === 0,
  };
}

/** What the tree being purged holds. There is no third value and no default. */
export type TreeDataClass = "synthetic" | "owner_real";

export type PurgeRefusal =
  | "not_authorized"
  | "wrong_actor"
  | "wildcard_scope_refused"
  | "confirmation_phrase_mismatch"
  | "authorization_stale"
  | "plan_incomplete"
  | "real_owner_data_not_authorized_by_this_programme";

export type PurgeGuard =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly refusal: PurgeRefusal; readonly detail: string };

/** How long an authorisation stays usable. Long enough to act, short enough not to sit in a file. */
export const AUTHORIZATION_MAX_AGE_SECONDS = 15 * 60;

/**
 * The execution guard.
 *
 * `realDataAuthorization` is the ONLY way to purge a tree classed `owner_real`,
 * and it is deliberately not something this programme can produce: the master
 * programme states, in SS4.2 and again in SS7, that it does not authorize physical
 * deletion of Owner's real transcripts, confirmed memories, backups or Core
 * documents. Build the path; do not exercise it on owner data.
 *
 * The parameter exists rather than being absent so the refusal is a NAMED, tested
 * branch instead of an unwritten assumption — and so the day a real erasure is
 * genuinely required, the change is supplying a token under a new work order,
 * not editing this function under time pressure.
 */
export function assertPurgeExecutable(input: {
  readonly authorization: OwnerPurgeAuthorization | null;
  readonly expectedPhrase: string;
  readonly nowIso: string;
  readonly plan: PurgePlan;
  readonly treeDataClass: TreeDataClass;
  readonly realDataAuthorization?: { readonly workOrderId: string; readonly issuedBy: "owner" } | undefined;
}): PurgeGuard {
  const a = input.authorization;
  if (a === null) {
    return { ok: false, refusal: "not_authorized", detail: "no owner authorization supplied" };
  }
  if (a.ownerActor !== "owner") {
    return { ok: false, refusal: "wrong_actor", detail: String(a.ownerActor) };
  }
  if (a.subjectId === "" || a.subjectId === "*" || a.subjectId.includes("*")) {
    return { ok: false, refusal: "wildcard_scope_refused", detail: a.subjectId };
  }
  if (a.confirmationPhrase !== input.expectedPhrase) {
    return { ok: false, refusal: "confirmation_phrase_mismatch", detail: "phrase does not match" };
  }
  const ageSeconds = (Date.parse(input.nowIso) - Date.parse(a.issuedAt)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > AUTHORIZATION_MAX_AGE_SECONDS) {
    return {
      ok: false,
      refusal: "authorization_stale",
      detail: `age ${String(Math.round(ageSeconds))}s, limit ${AUTHORIZATION_MAX_AGE_SECONDS}s`,
    };
  }
  if (!input.plan.complete) {
    return {
      ok: false,
      refusal: "plan_incomplete",
      detail: `unchecked registries: ${input.plan.uncheckedRegistries.join(", ")}`,
    };
  }
  if (input.treeDataClass === "owner_real" && input.realDataAuthorization === undefined) {
    return {
      ok: false,
      refusal: "real_owner_data_not_authorized_by_this_programme",
      detail: "the T05B-D master programme builds and proves the purge path; it does not "
        + "authorize physical deletion of owner data. A separate bounded work order is required.",
    };
  }
  return {
    ok: true,
    detail: input.treeDataClass === "synthetic"
      ? "synthetic tree: the purge path may be exercised"
      : `owner tree: authorized by work order ${input.realDataAuthorization!.workOrderId}`,
  };
}
