/**
 * T05A Contract A/E — platform adapters and the runtime resolution of roots.
 *
 * A new operating system must be a new adapter, not an edit to the domain. The
 * adapters differ only in where a *default* state root would live; every one of
 * them can be overridden explicitly, and the explicit override is the supported
 * path for anything that matters.
 *
 * Nothing here reads `process.cwd()`. The repository is found by landmark, which
 * is the correction T04 paid for four times over.
 */

import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { isRegularFile, type ReadOnlyFs } from "../../core/ports/filesystem-port.js";
import {
  OWNED_LEAF_NAME, normalizeSeparators, ownerBaseOf, validateRoots,
  type ResolvedRoots, type RootsCheck,
} from "../../core/domain/portable-roots.js";

export type Platform = "windows" | "wsl-linux" | "macos" | "explicit";

/**
 * A provider binary is hashed, so it is read; like every other read in T05A it is
 * bounded by OUR number. A reviewer measured the previous unbounded version at
 * roughly 2.7x the file size in memory.
 */
export const PROVIDER_MAX_BYTES = 256 * 1024 * 1024;

/** Irreversible, length-prefixed so no two inputs can collide by moving a delimiter. */
export function opaque(v: string): string {
  return `sha256:${createHash("sha256").update(`delos-t05a-opaque:${Buffer.byteLength(v, "utf8")}:${v}`).digest("hex")}`;
}

export function detectPlatform(env: Readonly<Record<string, string | undefined>>, platform: string): Platform {
  if (typeof env["DELOS_ROOTS_EXPLICIT"] === "string" && env["DELOS_ROOTS_EXPLICIT"] !== "") return "explicit";
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "wsl-linux";
}

// ---------------------------------------------------------------------------
// Landmark repository resolution — never `../` arithmetic, never cwd
// ---------------------------------------------------------------------------

export const REPO_LANDMARKS = ["package.json", "tsconfig.json"] as const;

export type RepoRootRefusal = "repo_from_dir_invalid" | "repo_landmark_missing" | "repo_landmark_ambiguous" | "repo_not_contained";

export function resolveRepoRootByLandmark(
  fs: ReadOnlyFs,
  fromDir: string,
  landmarks: readonly string[] = REPO_LANDMARKS,
  maxDepth = 12,
): { ok: true; root: string } | { ok: false; code: RepoRootRefusal } {
  if (typeof fromDir !== "string" || fromDir === "" || !isAbsolute(fromDir)) return { ok: false, code: "repo_from_dir_invalid" };
  const startReal = fs.realPath(resolve(fromDir));
  if (!startReal.ok) return { ok: false, code: "repo_from_dir_invalid" };
  const start = startReal.path;
  const hits: string[] = [];
  let dir = start;
  for (let i = 0; i < maxDepth; i += 1) {
    // A landmark must be a real regular file. `existsSync` followed links, so
    // a symlink named `package.json` in any directory could nominate that
    // directory as the repository root — the one input from which every other
    // path is derived.
    if (landmarks.every((l) => isRegularFile(fs, join(dir, l)))) hits.push(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (hits.length === 0) return { ok: false, code: "repo_landmark_missing" };
  if (hits.length > 1) return { ok: false, code: "repo_landmark_ambiguous" };
  const root = hits[0]!;
  if (start !== root && !start.startsWith(root + sep)) return { ok: false, code: "repo_not_contained" };
  return { ok: true, root };
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

export interface RootResolutionInput {
  /** every root may be given explicitly; this is the supported production path */
  readonly explicit?: Partial<ResolvedRoots>;
  /** where to start the landmark search from, when repoRoot is not explicit */
  readonly fromDir?: string;
  readonly platform: Platform;
  /** injected so a fixture can present a synthetic machine without touching the host */
  readonly homeDir?: string;
  /**
   * The read-only capability, required only when `repoRoot` must be found by
   * landmark. Passing it explicitly keeps this module free of any filesystem
   * choice of its own.
   */
  readonly fs?: ReadOnlyFs;
}

export type RootResolution =
  | { ok: true; roots: ResolvedRoots; platform: Platform }
  | { ok: false; code: "roots_unresolvable"; detail: string }
  | { ok: false; code: "roots_invalid"; check: RootsCheck };

/**
 * The default LAYOUT (not the default location): a state root owns its derived
 * children, so relocating the state root relocates all four together and no
 * caller has to remember four separate settings.
 */
export function deriveOwnedRoots(stateRoot: string): Pick<ResolvedRoots, "cacheRoot" | "quarantineRoot" | "receiptRoot" | "workRoot" | "backupRoot"> {
  const s = normalizeSeparators(stateRoot).replace(/\/+$/, "");
  return {
    cacheRoot: `${s}/cache`,
    quarantineRoot: `${s}/quarantine`,
    receiptRoot: `${s}/receipts`,
    workRoot: `${s}/work`,
    backupRoot: `${s}/backup`,
  };
}

/**
 * The default state-root LEAF beneath the platform owner directory.
 *
 * A constant, so `stateRoot` is always exactly one nameable leaf and the bootstrap
 * never has to invent intermediate parents.
 */
export const STATE_ROOT_LEAF = "delos";

/**
 * The fixed direct-child name each owned root must have under the anchor.
 *
 * The safe bootstrap derives its target from the CANONICALIZED anchor plus this
 * name, and then requires the configured root to be exactly that path. So a
 * configuration value is an input to be checked, never the path that gets
 * created — which is the whole point of the authority reduction.
 */
export const OWNED_CHILD_NAME = OWNED_LEAF_NAME;

export function resolveRoots(input: RootResolutionInput): RootResolution {
  const e = input.explicit ?? {};

  let repoRoot = e.repoRoot;
  if (repoRoot === undefined) {
    if (input.fromDir === undefined) return { ok: false, code: "roots_unresolvable", detail: "repoRoot_not_given_and_no_search_origin" };
    if (input.fs === undefined) return { ok: false, code: "roots_unresolvable", detail: "landmark_search_requires_a_filesystem_capability" };
    const r = resolveRepoRootByLandmark(input.fs, input.fromDir);
    if (!r.ok) return { ok: false, code: "roots_unresolvable", detail: r.code };
    repoRoot = r.root;
  }
  const assetRoot = e.assetRoot ?? `${normalizeSeparators(repoRoot).replace(/\/+$/, "")}/assets`;

  // The platform owner directory. It must already exist; the bootstrap creates the
  // LEAF beneath it, never the chain above.
  let stateBaseRoot = e.stateBaseRoot;
  let stateRoot = e.stateRoot;
  if (stateRoot === undefined) {
    // A default location is a convenience, never a contract: it exists so a
    // fresh machine can run doctor at all, and every deployment is expected to
    // pass an explicit stateRoot instead.
    const home = input.homeDir;
    if (home === undefined || home === "") return { ok: false, code: "roots_unresolvable", detail: "stateRoot_not_given_and_no_home" };
    const h = normalizeSeparators(home).replace(/\/+$/, "");
    // The owner directory is the platform's state area; the leaf beneath it is
    // ours to create. Splitting them is what makes day-one bootstrap bounded.
    stateBaseRoot = stateBaseRoot ?? (input.platform === "windows" ? `${h}/AppData/Local/Delos` : `${h}/.local/state`);
    stateRoot = `${normalizeSeparators(stateBaseRoot).replace(/\/+$/, "")}/${STATE_ROOT_LEAF}`;
  }
  if (stateBaseRoot === undefined) {
    const derived = ownerBaseOf(stateRoot);
    if (derived === null) return { ok: false, code: "roots_unresolvable", detail: "stateRoot_has_no_owner_parent" };
    stateBaseRoot = derived;
  }

  const owned = deriveOwnedRoots(stateRoot);
  const roots: ResolvedRoots = {
    repoRoot: normalizeSeparators(repoRoot).replace(/\/+$/, ""),
    assetRoot: normalizeSeparators(assetRoot).replace(/\/+$/, ""),
    stateBaseRoot: normalizeSeparators(stateBaseRoot).replace(/\/+$/, ""),
    stateRoot: normalizeSeparators(stateRoot).replace(/\/+$/, ""),
    cacheRoot: e.cacheRoot ?? owned.cacheRoot,
    quarantineRoot: e.quarantineRoot ?? owned.quarantineRoot,
    receiptRoot: e.receiptRoot ?? owned.receiptRoot,
    workRoot: e.workRoot ?? owned.workRoot,
    backupRoot: e.backupRoot ?? owned.backupRoot,
  };

  // A resolved runtime root legitimately contains a home directory; the sentinel
  // ban applies to DECLARED configuration and to reports, not to this.
  const check = validateRoots(roots, { allowOperatorHome: true });
  if (!check.ok) return { ok: false, code: "roots_invalid", check };
  return { ok: true, roots, platform: input.platform };
}

// ---------------------------------------------------------------------------
// Provider command resolution — identity includes CONTENT
// ---------------------------------------------------------------------------

export type ProviderRefusal =
  | "provider_ref_undeclared" | "provider_env_unset" | "provider_not_absolute"
  | "provider_unreadable" | "provider_not_a_file" | "provider_not_executable";

export interface ProviderIdentity { readonly identity: string; readonly size: number }

/**
 * The reference in config is LOGICAL (an env-var name). Resolution happens here,
 * at runtime, so the same committed config works on every machine — and the
 * identity covers the file's bytes, so a same-size same-mtime swap is still a
 * different provider.
 */
export function resolveProviderFromRef(
  fs: ReadOnlyFs,
  ref: string | null,
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; provider: ProviderIdentity } | { ok: false; code: ProviderRefusal } {
  if (ref === null || ref.trim() === "") return { ok: false, code: "provider_ref_undeclared" };
  const raw = env[ref];
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, code: "provider_env_unset" };
  const given = raw.trim();
  if (!isAbsolute(given) || given.split("/").some((s) => s === "..")) return { ok: false, code: "provider_not_absolute" };

  // The one deliberate FOLLOW in the governed surface, and it follows exactly
  // once, explicitly: an installed provider binary is very often a symlink (a
  // version manager, a package-manager shim), and the identity that matters is
  // the file it resolves to. Nothing is ever repaired here — the provider is
  // reported, never touched — and it is never executed.
  const real = fs.realPath(resolve(given));
  if (!real.ok) return { ok: false, code: "provider_unreadable" };
  if (fs.objectType(real.path) !== "regular") return { ok: false, code: "provider_not_a_file" };
  // A provider binary is read to hash it; the read is bounded like every other.
  const content = fs.readRegularFileBytes(real.path, PROVIDER_MAX_BYTES);
  if (!content.ok) return { ok: false, code: "provider_unreadable" };
  return {
    ok: true,
    provider: {
      identity: `sha256:${createHash("sha256").update(content.bytes).digest("hex")}`,
      size: content.bytes.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Child environment allowlist
// ---------------------------------------------------------------------------

export const PROVIDER_ENV_ALLOWLIST = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"] as const;

/**
 * A child process gets exactly the allowlisted keys. T04 shipped a launcher that
 * exported the whole `.env` — bot token included — into the provider CLI; the
 * fix is not "be careful", it is "the set is enumerated in code".
 */
export function buildChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  allowlist: readonly string[] = PROVIDER_ENV_ALLOWLIST,
): { env: Record<string, string>; droppedCount: number } {
  const env: Record<string, string> = {};
  for (const k of allowlist) {
    const v = parent[k];
    if (typeof v === "string" && v !== "") env[k] = v;
  }
  return { env, droppedCount: Object.keys(parent).filter((k) => !(k in env)).length };
}
