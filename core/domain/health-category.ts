/**
 * T05A — typed health categories and the four-state terminal row algebra.
 *
 * Two separate lessons live in this file.
 *
 * ── Categories are typed, names are data ─────────────────────────────────────
 *
 * The previous report identified anchor-source results by string prefix —
 * `code.startsWith("anchor_source_")` — over a namespace that also contained
 * interpolated ledger filenames. A reviewer produced two consequences from one
 * file name:
 *
 *   `source_a.jsonl`     -> check code `anchor_source_a` -> counted as an anchor
 *                           SOURCE -> denominator 2 vs expected 1 -> invariant
 *                           violation -> exit 4 with EMPTY stdout, after the
 *                           bootstrap had already created four directories
 *   `denominator.jsonl`  -> check code `anchor_denominator` -> a DUPLICATE of a
 *                           real check code, so any consumer keyed by `code`
 *                           silently reads whichever comes first
 *
 * The fix is not a better prefix. A category is a typed field and a name is data,
 * so no filename can be mistaken for a category and none can change control flow.
 *
 * ── `repairable` is a first-class terminal state ─────────────────────────────
 *
 * The earlier three-state set forced an untenable choice for a directory that is
 * merely absent and safely creatable. Calling it `failed` made a fresh machine
 * look broken and — worse — would have vetoed its own repair, because
 * `--repair-safe` acts on a REPAIRABLE verdict. Calling it `verified` produced the
 * report an independent reviewer measured and rejected:
 *
 *     delos doctor: REPAIRABLE
 *       profile runtime: 52 required, 52 verified, 0 failed, 1 profile-excluded
 *
 * Fifty-two verified rows beside a verdict that says work is outstanding, with ten
 * of those rows describing directories that do not exist. Both readings were
 * false, so the ruling withdrew the three-state algebra and made the fourth state
 * explicit. A missing-but-creatable directory is now `repairable`, it carries the
 * exact closed tag that will create it, and it stays in the denominator.
 */

import type { BootstrapTarget } from "./bootstrap-action.js";

/** The closed category set. Nothing outside this list is a category. */
export type HealthCategory =
  | "configuration"
  | "runtime_asset"
  | "derived_root"
  | "proxy_observation"
  | "legacy_backend"
  | "governance_anchor_source"
  | "governance_ledger"
  | "report_internal";

export const HEALTH_CATEGORIES: readonly HealthCategory[] = [
  "configuration", "runtime_asset", "derived_root", "proxy_observation",
  "legacy_backend", "governance_anchor_source", "governance_ledger", "report_internal",
] as const;

export function isHealthCategory(v: unknown): v is HealthCategory {
  return typeof v === "string" && (HEALTH_CATEGORIES as readonly string[]).includes(v);
}

/**
 * Which profile REQUIRES a category.
 *
 * `runtime` requires everything a production machine needs to run. Governance
 * evidence is excluded there — explicitly, as a reported state, never as silence.
 * `governance` requires everything runtime does, plus the historical evidence.
 */
export type HealthProfile = "runtime" | "governance";

export const HEALTH_PROFILES: readonly HealthProfile[] = ["runtime", "governance"] as const;

export function isHealthProfile(v: unknown): v is HealthProfile {
  return typeof v === "string" && (HEALTH_PROFILES as readonly string[]).includes(v);
}

const GOVERNANCE_ONLY: readonly HealthCategory[] = ["governance_anchor_source", "governance_ledger"] as const;

/**
 * Is this category required under this profile?
 *
 * The single place the profile decision is expressed. A category is either
 * required, or explicitly excluded — there is no third state in which something is
 * neither checked nor mentioned, because that third state is how a fresh machine
 * came to be told its evidence was missing when the evidence was never a runtime
 * dependency in the first place.
 */
export function categoryRequiredBy(profile: HealthProfile, category: HealthCategory): boolean {
  if (category === "report_internal") return false;
  if (GOVERNANCE_ONLY.includes(category)) return profile === "governance";
  return true;
}

export function categoryExcludedBy(profile: HealthProfile, category: HealthCategory): boolean {
  return GOVERNANCE_ONLY.includes(category) && profile === "runtime";
}

/**
 * The terminal disposition of one expectation. Four values, closed.
 *
 * `repairable` means: this expectation is not satisfied, and exactly one closed
 * bootstrap tag would satisfy it safely. It is neither health nor damage, and
 * collapsing it into either was the defect.
 *
 * `profile_excluded` is a first-class outcome, not a synonym for pass. Runtime
 * doctor must never claim it cryptographically checked something it excluded.
 */
export type ComponentStatus = "verified" | "repairable" | "failed" | "profile_excluded";

export const COMPONENT_STATUSES: readonly ComponentStatus[] =
  ["verified", "repairable", "failed", "profile_excluded"] as const;

export function isComponentStatus(v: unknown): v is ComponentStatus {
  return typeof v === "string" && (COMPONENT_STATUSES as readonly string[]).includes(v);
}

export interface HealthComponent {
  /**
   * Stable typed expectation ID, assigned by the PLAN before any probe runs.
   *
   * The plan and the report are compared on this field as independent sets, so it
   * cannot be derived from whatever the probes happened to emit.
   */
  readonly id: string;
  /** typed; drives all arithmetic and all control flow */
  readonly category: HealthCategory;
  /**
   * A stable machine identifier for WHICH component of that category this is.
   * Derived from code-side declarations only — never interpolated from a
   * filename. Ledger names travel in `logicalName` instead.
   */
  readonly component: string;
  /** operator-controlled data, reported and never interpreted */
  readonly logicalName: string | null;
  readonly status: ComponentStatus;
  /** stable, non-empty for every status including `verified` */
  readonly detail: string;
  /**
   * Present exactly when `status === "repairable"`: the one closed tag that would
   * satisfy this expectation. A repairable row without an action is an internal
   * defect, because "the machine can fix this" with no named fix is not a claim.
   */
  readonly typedAction?: BootstrapTarget;
}

export interface ProfileDenominator {
  readonly profile: HealthProfile;
  readonly expected: number;
  readonly required: number;
  readonly verified: number;
  readonly repairable: number;
  readonly failed: number;
  readonly excluded: number;
}

/**
 * What the PLAN independently says must appear.
 *
 * Supplied separately from the rows so the comparison is between two sets built by
 * different code from different inputs. Deriving both sides from the final row
 * array and calling the resulting identity an invariant is precisely what the
 * ruling forbids.
 */
export interface PlanFacts {
  readonly requiredIds: readonly string[];
  readonly excludedIds: readonly string[];
  /**
   * The category the PLAN assigned to each id.
   *
   * Carried so a row's category can be checked against the plan's rather than
   * trusted. A category that changed between plan and report means something
   * downstream reclassified an expectation, which is how operator data used to
   * reach typed control flow.
   */
  readonly categoryById: Readonly<Record<string, HealthCategory>>;
}

export type DenominatorViolation =
  | "no_required_components"
  | "required_arithmetic_mismatch"
  | "expected_arithmetic_mismatch"
  | "excluded_component_also_required"
  | "duplicate_component_identity"
  | "duplicate_expectation_id"
  | "component_status_not_closed"
  | "repairable_row_without_typed_action"
  | "non_repairable_row_with_typed_action"
  | "planned_required_id_not_emitted"
  | "emitted_required_id_not_planned"
  | "planned_excluded_id_not_emitted"
  | "emitted_excluded_id_not_planned";

/** The report's own counters, summarised from the rows it is about to print. */
export function denominatorOf(
  profile: HealthProfile,
  components: readonly HealthComponent[],
): ProfileDenominator {
  let required = 0;
  let verified = 0;
  let repairable = 0;
  let failed = 0;
  let excluded = 0;
  for (const c of components) {
    if (c.status === "profile_excluded") { excluded += 1; continue; }
    required += 1;
    if (c.status === "verified") verified += 1;
    else if (c.status === "repairable") repairable += 1;
    else failed += 1;
  }
  return {
    profile,
    expected: components.length,
    required,
    verified,
    repairable,
    failed,
    excluded,
  };
}

/**
 * The invariants over a component set AND the plan that predicted it.
 *
 * The arithmetic checks are deliberately kept — they catch a corrupted or
 * hand-built report — but they are no longer described as independent, because
 * they are not: they compare a summary with the array it summarises. The
 * independent checks are the four set comparisons at the end, where one side comes
 * from `planExpectations` before any I/O and the other from the emitted rows.
 */
export function denominatorViolations(
  profile: HealthProfile,
  components: readonly HealthComponent[],
  plan: PlanFacts,
  /**
   * The totals the report STORES, when there are any.
   *
   * Supplied separately because the arithmetic has to be checked on the stored
   * numbers to mean anything: `denominatorOf` fills all six columns in one pass over
   * the rows, so an identity computed from its output is true by construction. That
   * tautology is exactly what the ruling forbids calling an invariant.
   */
  stored?: ProfileDenominator,
): readonly DenominatorViolation[] {
  const out: DenominatorViolation[] = [];
  const den = denominatorOf(profile, components);
  if (den.required === 0) out.push("no_required_components");
  const arith = stored ?? den;
  if (arith.verified + arith.repairable + arith.failed !== arith.required) {
    out.push("required_arithmetic_mismatch");
  }
  if (arith.required + arith.excluded !== arith.expected) out.push("expected_arithmetic_mismatch");

  const identities = new Set<string>();
  const ids = new Set<string>();
  for (const c of components) {
    const key = JSON.stringify([c.category, c.component]);
    if (identities.has(key) && !out.includes("duplicate_component_identity")) {
      out.push("duplicate_component_identity");
    }
    identities.add(key);
    if (ids.has(c.id) && !out.includes("duplicate_expectation_id")) {
      out.push("duplicate_expectation_id");
    }
    ids.add(c.id);
  }
  for (const c of components) {
    if (!isComponentStatus(c.status)) { out.push("component_status_not_closed"); break; }
  }
  for (const c of components) {
    if (c.status === "repairable" && c.typedAction === undefined) {
      out.push("repairable_row_without_typed_action");
      break;
    }
  }
  for (const c of components) {
    if (c.status !== "repairable" && c.typedAction !== undefined) {
      out.push("non_repairable_row_with_typed_action");
      break;
    }
  }
  // Excluded and required must be disjoint: a component cannot be both something
  // this profile checked and something it declined to check.
  for (const c of components) {
    if (c.status === "profile_excluded" && categoryRequiredBy(profile, c.category)) {
      out.push("excluded_component_also_required");
      break;
    }
  }

  // ── the independent half ───────────────────────────────────────────────────
  const emittedRequired = new Set(components.filter((c) => c.status !== "profile_excluded").map((c) => c.id));
  const emittedExcluded = new Set(components.filter((c) => c.status === "profile_excluded").map((c) => c.id));
  const plannedRequired = new Set(plan.requiredIds);
  const plannedExcluded = new Set(plan.excludedIds);
  for (const id of plannedRequired) {
    if (!emittedRequired.has(id)) { out.push("planned_required_id_not_emitted"); break; }
  }
  for (const id of emittedRequired) {
    if (!plannedRequired.has(id)) { out.push("emitted_required_id_not_planned"); break; }
  }
  for (const id of plannedExcluded) {
    if (!emittedExcluded.has(id)) { out.push("planned_excluded_id_not_emitted"); break; }
  }
  for (const id of emittedExcluded) {
    if (!plannedExcluded.has(id)) { out.push("emitted_excluded_id_not_planned"); break; }
  }
  return out;
}

/** The closed verdict set the denominator implies. One rule, one place. */
export type HealthVerdict = "OK" | "REPAIRABLE" | "BLOCKED";

export function verdictFor(den: ProfileDenominator): HealthVerdict {
  if (den.failed >= 1) return "BLOCKED";
  if (den.repairable >= 1) return "REPAIRABLE";
  return "OK";
}
