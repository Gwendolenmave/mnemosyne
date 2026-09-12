/**
 * T05A — the closed action algebra, as plain canonical data.
 *
 * An action is a TAG. There is no field to put a path in, one constructor that
 * takes a tag from the closed set, and no code anywhere that maps a string to a
 * target.
 *
 * The validator below is the part this round rewrote. The previous version read
 * `o["target"]` twice — once to test it, once to copy it — so a getter could pass
 * `isBootstrapTarget` on the first read and hand back something else on the
 * second. A reviewer used exactly that to make the function whose entire purpose
 * is closure return `{ok: true, target: "__proto__"}`. Reading an untrusted
 * property twice is the defect; the fix is not a better test but a different
 * discipline:
 *
 *   - require an ordinary record with an accepted prototype;
 *   - inspect own property DESCRIPTORS, never read through the object;
 *   - reject accessors, inherited fields, extra fields and symbol keys;
 *   - take each accepted data value ONCE into a local;
 *   - validate the locals against the closed enums;
 *   - return a NEWLY ALLOCATED, FROZEN canonical object;
 *   - and let the caller execute only that object, never the one it was given.
 *
 * A getter is never invoked, so it cannot change a value between reads and cannot
 * run a side effect. That is a property of the mechanism rather than of the order
 * of two lines.
 */

import { BOOTSTRAP_TARGET_ROOTS, type RootName } from "./portable-roots.js";

/** The only logical targets a bootstrap may name. */
export type BootstrapTarget =
  | "STATE_ROOT"
  | "CACHE_ROOT"
  | "QUARANTINE_ROOT"
  | "RECEIPT_ROOT"
  | "WORK_ROOT";

/**
 * Ordered deliberately: `STATE_ROOT` first, because the four derived roots are its
 * children and the coordinator creates it, reclassifies it physically, and only
 * then attempts the rest. Iterating this constant IS the topological order.
 */
export const BOOTSTRAP_TARGETS: readonly BootstrapTarget[] = [
  "STATE_ROOT", "CACHE_ROOT", "QUARANTINE_ROOT", "RECEIPT_ROOT", "WORK_ROOT",
] as const;

/** The four derived targets, in order, excluding the owner state root. */
export const DERIVED_TARGETS: readonly BootstrapTarget[] = [
  "CACHE_ROOT", "QUARANTINE_ROOT", "RECEIPT_ROOT", "WORK_ROOT",
] as const;

/** Tag -> logical root name. Total over the closed tag set; no default branch. */
const TARGET_ROOT: Readonly<Record<BootstrapTarget, RootName>> = {
  STATE_ROOT: "stateRoot",
  CACHE_ROOT: "cacheRoot",
  QUARANTINE_ROOT: "quarantineRoot",
  RECEIPT_ROOT: "receiptRoot",
  WORK_ROOT: "workRoot",
};

/**
 * Which root is the PARENT each target must sit exactly one leaf beneath.
 *
 * The state root's parent is the platform owner directory that must already
 * exist; the four derived roots' parent is the state root. Stating it as data is
 * what lets one derivation routine serve all five targets without a special case
 * that could drift.
 */
const TARGET_PARENT: Readonly<Record<BootstrapTarget, RootName>> = {
  STATE_ROOT: "stateBaseRoot",
  CACHE_ROOT: "stateRoot",
  QUARANTINE_ROOT: "stateRoot",
  RECEIPT_ROOT: "stateRoot",
  WORK_ROOT: "stateRoot",
};

export function parentRootFor(target: BootstrapTarget): RootName {
  return TARGET_PARENT[target];
}

/** The single authorized mutation kind. There is no second one. */
export const CREATE_MISSING_DERIVED_DIRECTORY = "CREATE_MISSING_DERIVED_DIRECTORY" as const;

export interface BootstrapAction {
  readonly kind: typeof CREATE_MISSING_DERIVED_DIRECTORY;
  readonly target: BootstrapTarget;
}

export function isBootstrapTarget(v: unknown): v is BootstrapTarget {
  return typeof v === "string" && (BOOTSTRAP_TARGETS as readonly string[]).includes(v);
}

/**
 * The ONLY constructor, and the only producer of a canonical action.
 *
 * Internal paths use this, so they never hand an unknown object to the executor
 * at all — `validateBootstrapAction` exists for values arriving from outside, and
 * for the fixtures that prove hostile objects are refused.
 */
export function createMissingDerivedDirectory(target: BootstrapTarget): BootstrapAction {
  if (!isBootstrapTarget(target)) throw new Error("bootstrap_action_unknown_target");
  return Object.freeze({ kind: CREATE_MISSING_DERIVED_DIRECTORY, target });
}

export type ActionRefusal =
  | "not_an_object"
  | "unacceptable_prototype"
  | "symbol_keys_present"
  | "extra_keys_present"
  | "missing_keys"
  | "accessor_property"
  | "non_writable_shape"
  | "unknown_kind"
  | "unknown_target";

export type ActionValidation =
  | { readonly ok: true; readonly action: BootstrapAction }
  | { readonly ok: false; readonly refusal: ActionRefusal };

const ALLOWED_KEYS = ["kind", "target"] as const;

/**
 * Validate a value of unknown origin into a canonical action, without ever
 * reading through it.
 *
 * Every decision below is made from a property DESCRIPTOR. `getOwnPropertyDescriptor`
 * returns the descriptor itself — for an accessor it returns `{get, set}` and does
 * not call the getter — so a hostile object's code never runs. A Proxy that
 * fabricates descriptors is deterministically caught by the prototype and
 * descriptor-shape requirements below in the cases that matter; where it is not
 * deterministically detectable, the value is still copied out once and the copy
 * is what executes, so a later mutation of the caller's object changes nothing.
 */
export function validateBootstrapAction(v: unknown): ActionValidation {
  if (typeof v !== "object" || v === null) return { ok: false, refusal: "not_an_object" };

  // (1) an ordinary record. `Object.prototype` or a null prototype only: a class
  //     instance, an Array, a Date or anything with a custom prototype is not
  //     plain data and is refused rather than duck-typed.
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) return { ok: false, refusal: "unacceptable_prototype" };

  // (3) symbol keys are refused outright — they cannot be part of the closed
  //     shape, and their presence means the object was built to be interesting.
  if (Object.getOwnPropertySymbols(v).length > 0) return { ok: false, refusal: "symbol_keys_present" };

  // (2)+(3) exact own string keys: no extras, none missing, nothing inherited.
  const own = Object.getOwnPropertyNames(v);
  for (const k of own) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(k)) return { ok: false, refusal: "extra_keys_present" };
  }
  for (const k of ALLOWED_KEYS) {
    if (!own.includes(k)) return { ok: false, refusal: "missing_keys" };
  }

  // (4) data descriptors only. This is where an accessor is rejected WITHOUT
  //     being invoked: the descriptor is inspected, not the value behind it.
  const descriptors: Record<string, PropertyDescriptor> = {};
  for (const k of ALLOWED_KEYS) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (d === undefined) return { ok: false, refusal: "missing_keys" };
    if (typeof d.get === "function" || typeof d.set === "function") {
      return { ok: false, refusal: "accessor_property" };
    }
    if (!("value" in d)) return { ok: false, refusal: "non_writable_shape" };
    descriptors[k] = d;
  }

  // (5) each accepted value read EXACTLY ONCE, out of the descriptor, into a
  //     local. Nothing below touches `v` again.
  const kind: unknown = descriptors["kind"]!.value;
  const target: unknown = descriptors["target"]!.value;

  // (6) closed enums
  if (kind !== CREATE_MISSING_DERIVED_DIRECTORY) return { ok: false, refusal: "unknown_kind" };
  if (!isBootstrapTarget(target)) return { ok: false, refusal: "unknown_target" };

  // (7) a newly allocated, frozen canonical object — never the caller's
  return { ok: true, action: Object.freeze({ kind: CREATE_MISSING_DERIVED_DIRECTORY, target }) };
}

/** The logical root a tag selects. Total; no default branch exists. */
export function rootNameFor(target: BootstrapTarget): RootName {
  return TARGET_ROOT[target];
}

/** The tag that selects a logical root, if that root is bootstrappable at all. */
export function targetForRoot(root: RootName): BootstrapTarget | null {
  for (const t of BOOTSTRAP_TARGETS) if (TARGET_ROOT[t] === root) return t;
  return null;
}

/**
 * Consistency between the two closed sets, asserted rather than assumed: every
 * tag maps to a bootstrappable root, and every bootstrappable root has a tag. A
 * fixture calls this, so the two lists cannot drift apart silently.
 */
export function targetSetsAgree(): boolean {
  const fromTags = BOOTSTRAP_TARGETS.map((t) => TARGET_ROOT[t]).sort();
  const fromRoots = [...BOOTSTRAP_TARGET_ROOTS].sort();
  return fromTags.length === fromRoots.length && fromTags.every((v, i) => v === fromRoots[i]);
}
