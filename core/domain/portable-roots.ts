/**
 * T05A Contract A — the one portable root model.
 *
 * Every path Delos needs is one of seven named roots. Nothing is inferred from
 * how deep a file happens to sit, nothing is read from `process.cwd()`, and no
 * operator home directory appears anywhere in source, config, fixture or report.
 *
 * The rule this file exists to enforce is the one T04 kept re-learning the hard
 * way: a path the code guesses from its own position on disk is not a contract.
 * It was wrong four separate times in T04 — including inside the fixture written
 * to prove the tree was clean. So roots are DECLARED, canonicalised, contained
 * and checked for overlap, or the system refuses to start.
 *
 * This module is pure. It never touches the filesystem: it validates a already-
 * resolved set of absolute paths. The adapter that does the resolving lives in
 * `adapters/config/platform-root-adapters.ts`, so a new operating system is a
 * new adapter rather than an edit here.
 */

/**
 * The nine roots. `backupRoot` is declared in T05A and implemented in T05B.
 *
 * `stateBaseRoot` is new, and it is the whole of Closure A: the canonical platform
 * owner directory that must ALREADY exist. `stateRoot` is exactly one missing leaf
 * beneath it, which makes creating that leaf a bounded, checkable act rather than
 * recursive parent invention. Before this, a genuine day-one machine — one whose
 * state root had never been created — was permanently BLOCKED, because nothing was
 * authorized to create it and no fixture ever ran with it truly absent.
 */
export type RootName =
  | "repoRoot"
  | "assetRoot"
  | "stateBaseRoot"
  | "stateRoot"
  | "cacheRoot"
  | "quarantineRoot"
  | "receiptRoot"
  | "workRoot"
  | "backupRoot";

export const ROOT_NAMES: readonly RootName[] = [
  "repoRoot", "assetRoot", "stateBaseRoot", "stateRoot", "cacheRoot", "quarantineRoot",
  "receiptRoot", "workRoot", "backupRoot",
] as const;

/**
 * What each root is allowed to be. The distinction is not decoration: it decides
 * which roots the safe bootstrap may ever create, and everything else is
 * authoritative — a "repair" that reconstructed one would be destroying
 * evidence.
 */
export const ROOT_KIND: Readonly<Record<RootName, "immutable" | "durable" | "derived" | "retained" | "append-only" | "reserved">> = {
  repoRoot: "immutable",
  assetRoot: "immutable",
  stateRoot: "durable",
  stateBaseRoot: "durable",
  cacheRoot: "derived",
  quarantineRoot: "retained",
  receiptRoot: "append-only",
  workRoot: "derived",
  backupRoot: "reserved",
};

/**
 * The CLOSED set of roots whose own empty directory the safe bootstrap may
 * create. This is the entire filesystem authority T05A ships.
 *
 * What used to be here — a per-action authority table with separate CONTENT and
 * CONTAINER powers, one of which let a machine rewrite file contents — is gone,
 * withdrawn by ruling rather than patched. Six rounds established the pattern:
 * an on-disk record or generic plan supplied a path, an executor interpreted it
 * after an earlier boundary check, and a derived repair acquired authority to
 * rename, displace, replace or delete. The reduction is the fix. There is no
 * content authority, no displacement authority and no deletion authority left
 * to misuse, because there is no code that can express them.
 *
 * A target is selected by a logical TAG (`core/domain/bootstrap-action.ts`) and
 * the path is derived from the validated configuration. No filesystem path,
 * relative string, journal field, receipt field or CLI argument can name one.
 */
export const BOOTSTRAP_TARGET_ROOTS: readonly RootName[] = [
  "stateRoot", "cacheRoot", "quarantineRoot", "receiptRoot", "workRoot",
] as const;

/**
 * The four DERIVED targets, i.e. the bootstrap set minus the owner state root.
 *
 * They are separate because the order matters and the ruling states it: the state
 * root is created first, reclassified physically, and only then are the four
 * derived roots attempted independently.
 */
export const DERIVED_TARGET_ROOTS: readonly RootName[] = [
  "cacheRoot", "quarantineRoot", "receiptRoot", "workRoot",
] as const;

/**
 * The fixed leaf name each owned root must have directly beneath `stateRoot`.
 *
 * A domain fact, not an adapter detail. It lived only in the adapter, which is why
 * `validateRoots` could not state the rule that a derived root must BE its declared
 * leaf — and configuration consequently accepted a cache root in `/tmp`.
 */
export const OWNED_LEAF_NAME: Readonly<Record<
  "cacheRoot" | "quarantineRoot" | "receiptRoot" | "workRoot" | "backupRoot", string
>> = {
  cacheRoot: "cache",
  quarantineRoot: "quarantine",
  receiptRoot: "receipts",
  workRoot: "work",
  backupRoot: "backup",
};

export interface ResolvedRoots {
  readonly repoRoot: string;
  readonly assetRoot: string;
  /** the canonical platform owner directory; must already exist */
  readonly stateBaseRoot: string;
  /** exactly one leaf beneath `stateBaseRoot`; may legitimately be absent */
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly quarantineRoot: string;
  readonly receiptRoot: string;
  readonly workRoot: string;
  readonly backupRoot: string;
}

export type RootsRefusal =
  | "root_missing"
  | "root_not_absolute"
  | "root_traversal"
  | "root_not_canonical"
  | "root_overlap"
  | "root_inside_repository"
  | "root_inside_assets"
  | "root_operator_home_literal"
  /**
   * A derived root is not exactly its declared closed leaf directly beneath
   * `stateRoot`.
   *
   * The mutation boundary already refused to CREATE such a path, so nothing
   * unauthorized was ever made; this closes the configuration side, so doctor never
   * probes or reports on a directory outside the installation either.
   */
  | "root_not_declared_leaf_of_state_root"
  /**
   * `stateBaseRoot` is not the immediate lexical parent of `stateRoot`.
   *
   * The day-one bootstrap's entire safety argument is "one exclusive mkdir of one
   * named leaf inside a directory that already exists". If the base were any other
   * ancestor, that single mkdir would need intermediate parents — which is
   * recursive creation wearing a different name.
   */
  | "root_state_base_not_parent_of_state_root";

export interface RootsIssue {
  readonly code: RootsRefusal;
  /** the root that failed — a logical NAME, never a path */
  readonly root: RootName;
  /** for overlap, the other participant — also a logical name */
  readonly other?: RootName;
}

export type RootsCheck =
  | { ok: true; roots: ResolvedRoots }
  | { ok: false; issues: readonly RootsIssue[] };

/** POSIX-normalised comparison form; both separators are accepted on input. */
export function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Windows drive roots (`C:/…`) and POSIX roots (`/…`) are both absolute. UNC
 * (`//server/share`) is deliberately NOT accepted: it is a network location, and
 * a network path as a state root would quietly make local-first false.
 */
export function isAbsoluteRoot(p: string): boolean {
  const s = normalizeSeparators(p);
  if (s.startsWith("//")) return false;
  return s.startsWith("/") || /^[A-Za-z]:\//.test(s);
}

function hasTraversal(p: string): boolean {
  return normalizeSeparators(p).split("/").some((seg) => seg === ".." || seg === ".");
}

/** A filesystem root: `/` or a Windows drive root. Its canonical spelling ends in `/`. */
function isFilesystemRoot(s: string): boolean {
  return s === "/" || /^[A-Za-z]:\/$/.test(s);
}

function isCanonical(p: string): boolean {
  const s = normalizeSeparators(p);
  // A drive root is spelled `D:/` and there is no other way to write it. Rejecting
  // it as "non-canonical" made an ordinary Windows layout — a state root directly
  // beneath a drive — impossible to express, because its owner directory could not
  // be named. `D:` alone is not absolute, so there was no legal spelling at all.
  if (isFilesystemRoot(s)) return true;
  if (s.length > 1 && s.endsWith("/")) return false;
  if (s.includes("//")) return false;
  return true;
}

/**
 * The owner directory implied by a state root: its immediate lexical parent.
 *
 * ONE derivation, here in the domain, because three callers need it — this
 * module's own validation, the root resolver and the portable config generator —
 * and a second copy of this rule is exactly how they would come to disagree about
 * where the owner directory is. Lexical on purpose: no filesystem access, so it
 * answers the same way whether or not the directory exists yet.
 *
 * A child of a filesystem root gets that root, spelled canonically (`/`, `D:/`).
 * Returns null when there is no parent to name, which every caller turns into a
 * refusal rather than a guess.
 */
export function ownerBaseOf(stateRoot: string): string | null {
  const s = normalizeSeparators(stateRoot).replace(/\/+$/, "");
  const cut = s.lastIndexOf("/");
  if (cut < 0) return null;
  if (cut === 0) return s === "" ? null : "/";
  const parent = s.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

function contains(parent: string, child: string): boolean {
  const a = normalizeSeparators(parent).replace(/\/+$/, "");
  const b = normalizeSeparators(child).replace(/\/+$/, "");
  return b === a || b.startsWith(a + "/");
}

/**
 * A literal operator home directory in a root is not a validation error in the
 * abstract — a real machine legitimately has one. It IS an error in anything
 * that gets COMMITTED or REPORTED, which is why the sentinel check lives here
 * and is applied to declared configuration, never to a runtime resolution.
 */
export const OPERATOR_HOME_SENTINEL = /(^|\/)(?:home|Users)\/[^/]+(\/|$)/;

/**
 * §4 — validate an already-resolved root set.
 *
 * Overlap rules, stated because they are the non-obvious part:
 *  - no root may sit inside `repoRoot` (code is immutable; mutable state under a
 *    checkout gets destroyed by a clean or a branch switch);
 *  - no mutable root may sit inside `assetRoot` (semantic assets are immutable
 *    and hashed; writing beneath them changes their identity);
 *  - `cacheRoot`, `quarantineRoot` and `receiptRoot` MAY sit inside `stateRoot`,
 *    because that is the declared parent-ownership relationship, but they may
 *    never overlap each other — a rebuild of the cache must not be able to
 *    reach a receipt or a quarantined body.
 */
export function validateRoots(roots: ResolvedRoots, opts: { allowOperatorHome?: boolean } = {}): RootsCheck {
  const issues: RootsIssue[] = [];
  for (const name of ROOT_NAMES) {
    const v = roots[name];
    if (typeof v !== "string" || v.trim() === "") { issues.push({ code: "root_missing", root: name }); continue; }
    if (!isAbsoluteRoot(v)) issues.push({ code: "root_not_absolute", root: name });
    if (hasTraversal(v)) issues.push({ code: "root_traversal", root: name });
    if (!isCanonical(v)) issues.push({ code: "root_not_canonical", root: name });
    if (opts.allowOperatorHome !== true && OPERATOR_HOME_SENTINEL.test(normalizeSeparators(v))) {
      issues.push({ code: "root_operator_home_literal", root: name });
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // The base must be the state root's IMMEDIATE parent. This is the property the
  // day-one bootstrap rests on: one exclusive mkdir of one named leaf, inside a
  // directory that already exists. Any other ancestor would require intermediate
  // parents, which is recursive creation under another name.
  {
    const parent = ownerBaseOf(roots.stateRoot);
    if (parent === null || normalizeSeparators(parent) !== normalizeSeparators(roots.stateBaseRoot)) {
      issues.push({ code: "root_state_base_not_parent_of_state_root", root: "stateBaseRoot", other: "stateRoot" });
    }
  }

  // Every derived root must be EXACTLY `<stateRoot>/<declared leaf>`.
  {
    const s = normalizeSeparators(roots.stateRoot).replace(/\/+$/, "");
    for (const [name, leaf] of Object.entries(OWNED_LEAF_NAME)) {
      const want = `${s}/${leaf}`;
      const got = normalizeSeparators(roots[name as keyof typeof OWNED_LEAF_NAME]).replace(/\/+$/, "");
      if (got !== want) {
        issues.push({
          code: "root_not_declared_leaf_of_state_root",
          root: name as RootName,
          other: "stateRoot",
        });
      }
    }
  }

  // `stateBaseRoot` is deliberately ABSENT from this list.
  //
  // It is an OWNER-PROVIDED directory that must already exist, and the only
  // authority anything here has over it is a single exclusive `mkdir` of the one
  // leaf named by `stateRoot` — so it cannot reach a sibling, and the ordinary
  // layout `~/projects/delos` beside `~/projects/state` is not a defect. Including
  // it made every such layout refuse with `root_overlap`, which is a false
  // positive: the containment that matters is the state root's and its children's,
  // and those are all still checked below. The base's own constraint is the
  // parent-of-state-root rule above.
  const MUTABLE: readonly RootName[] = ["stateRoot", "cacheRoot", "quarantineRoot", "receiptRoot", "workRoot", "backupRoot"];
  for (const name of MUTABLE) {
    // `stateRoot` legitimately contains the four derived roots. That is the
    // declared ownership chain, not an overlap: the checks below exempt exactly
    // it and nothing else.
    if (contains(roots.repoRoot, roots[name])) issues.push({ code: "root_inside_repository", root: name });
    if (contains(roots.assetRoot, roots[name])) issues.push({ code: "root_inside_assets", root: name });
    // …and the reverse. A first review found this was checked in one direction
    // only: a stateRoot that CONTAINS the checkout is just as broken as one
    // nested inside it, because a repair operating "within state" would then be
    // operating over the code and the hashed assets.
    if (contains(roots[name], roots.repoRoot)) issues.push({ code: "root_overlap", root: name, other: "repoRoot" });
    if (contains(roots[name], roots.assetRoot)) issues.push({ code: "root_overlap", root: name, other: "assetRoot" });
  }
  // sibling exclusivity among the mutable roots, except the declared
  // stateRoot -> {cache,quarantine,receipt,backup} parent ownership
  const OWNED: readonly RootName[] = ["cacheRoot", "quarantineRoot", "receiptRoot", "workRoot", "backupRoot"];
  for (let i = 0; i < OWNED.length; i += 1) {
    for (let j = i + 1; j < OWNED.length; j += 1) {
      const a = OWNED[i]!;
      const b = OWNED[j]!;
      if (contains(roots[a], roots[b]) || contains(roots[b], roots[a])) {
        issues.push({ code: "root_overlap", root: a, other: b });
      }
    }
  }
  if (contains(roots.assetRoot, roots.repoRoot) && !contains(roots.repoRoot, roots.assetRoot)) {
    issues.push({ code: "root_overlap", root: "assetRoot", other: "repoRoot" });
  }
  return issues.length === 0 ? { ok: true, roots } : { ok: false, issues };
}

/**
 * The report face of a root set: logical names and irreversible identities only.
 * A long-term report may say WHICH root was wrong, never WHERE it is.
 */
export interface RootIdentity {
  readonly root: RootName;
  readonly kind: string;
  /** irreversible; supplied by the caller so this module stays free of crypto */
  readonly identity: string;
}

export function rootIdentities(roots: ResolvedRoots, opaque: (v: string) => string): readonly RootIdentity[] {
  return ROOT_NAMES.map((r) => ({ root: r, kind: ROOT_KIND[r], identity: opaque(roots[r]) }));
}
