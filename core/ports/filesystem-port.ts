/**
 * T05A — the filesystem capability boundary.
 *
 * This is the primary authority proof, replacing a homemade regex "reachability
 * walker" that a reviewer showed was hollow: it was blind to `node:fs/promises`,
 * to `child_process`, to computed member access, and its forbidden-API list
 * contained the token `openSync_w`, which no identifier can ever match — an
 * assertion that could not fail. Injecting `rm`, `writeFile` and `execSync` into
 * a governed, reachable module left it printing `AUTHORITY_REDUCED`.
 *
 * A capability boundary is a different kind of claim. It is not "we searched and
 * found nothing"; it is "the code that could do it was never handed the means".
 * Domain and service modules receive `ReadOnlyFs` and therefore cannot mutate
 * anything whatever they contain. The safe bootstrap additionally receives
 * `DirectoryCreator`, whose entire surface is one exclusive `mkdir`. Plain doctor
 * is never given the second one.
 *
 * The ports are also what makes hostile-condition evidence honest. A permission
 * fixture that relies on `chmod 000` proves nothing when the test runs as root,
 * and silently passes for the wrong reason. With a port, `EACCES` is injected
 * deterministically and the same code path is exercised on every host.
 */

/** What occupies a path, decided WITHOUT following symlinks. */
export type FsObjectType =
  | "absent"
  | "regular"
  | "directory"
  | "symlink"
  | "fifo"
  | "socket"
  | "blockDevice"
  | "charDevice"
  | "unknown";

/**
 * Why a read did not happen. `unreadable` is deliberately distinct from
 * `absent`: conflating them is how an unreadable ledger directory became
 * indistinguishable from one that was never created, which is a defect this
 * round exists to close.
 */
export type ReadRefusal = "absent" | "not_a_regular_file" | "unreadable" | "too_large";

export type ReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly refusal: ReadRefusal; readonly type: FsObjectType };

export type ReadBytesResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly refusal: ReadRefusal; readonly type: FsObjectType };

/**
 * Why a directory listing did not happen — `unreadable` is not `absent`.
 *
 * A successful listing carries whether it was TRUNCATED, and the true total. The
 * previous shape carried neither, so a capped listing was indistinguishable from a
 * complete one and a reviewer made a declared ledger that exists report as absent.
 * A bounded enumerator is fine; a bounded enumerator that cannot say it was bounded
 * is a silent lie.
 */
export type ListResult =
  | {
    readonly ok: true;
    readonly names: readonly string[];
    readonly truncated: boolean;
    /** entries present before the cap was applied */
    readonly total: number;
  }
  | { readonly ok: false; readonly refusal: "absent" | "not_a_directory" | "unreadable" };

export type RealPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly refusal: "absent" | "unreadable" | "loop" };

export type PrefixResult =
  | { readonly ok: true; readonly bytes: Buffer; readonly fileBytes: number }
  | { readonly ok: false; readonly refusal: ReadRefusal; readonly type: FsObjectType };

/**
 * Observation only. Every operation is total — it returns a typed refusal rather
 * than throwing — so a caller cannot accidentally treat "I could not look" as
 * "there is nothing there".
 */
export interface ReadOnlyFs {
  /** no-follow classification of the entry itself */
  readonly objectType: (path: string) => FsObjectType;
  /** byte length of the entry itself, no-follow; null when it cannot be taken */
  readonly sizeOf: (path: string) => number | null;
  /** whole-file read, refused above `maxBytes` BEFORE any bytes are consumed */
  readonly readRegularFile: (path: string, maxBytes: number) => ReadResult;
  readonly readRegularFileBytes: (path: string, maxBytes: number) => ReadBytesResult;
  /** bounded prefix read; `want` is clamped by the caller's own limit */
  readonly readPrefix: (path: string, want: number) => PrefixResult;
  /** directory listing, capped; `unreadable` is its own answer */
  readonly listDirectory: (path: string, maxEntries: number) => ListResult;
  /** fully resolved physical path (follows links, by design, once, explicitly) */
  readonly realPath: (path: string) => RealPathResult;
  /** where a link points, for evidence only; never used to decide authority */
  readonly linkTarget: (path: string) => string | null;
  /** is the entry writable by this process? */
  readonly isWritable: (path: string) => boolean;
}

export type CreateOutcome =
  | "created"
  | "exists"
  | "denied"
  | "no_parent"
  | "name_too_long"
  | "no_space"
  | "read_only_filesystem"
  | "refused";

/**
 * The ENTIRE mutation capability of T05A.
 *
 * One operation, which creates one directory, non-recursively and exclusively,
 * at an absolute path the caller derived. There is no rename, no unlink, no
 * removal, no write-file, no chmod, no process spawn and no arbitrary-path
 * operation, so a module holding this capability cannot perform one however it
 * is written.
 *
 * `createExclusive` reports WHY it failed as a closed enum rather than a string,
 * because a reviewer found four distinct owner actions (fix a mode, free disk
 * space, shorten a path, remount read-write) collapsed into one code called
 * `creation_refused_by_filesystem`.
 */
export interface DirectoryCreator {
  readonly createExclusive: (absolutePath: string, mode: number) => CreateOutcome;
}

/** Opening one of these never returns, so nothing may read one. Pure. */
export function isBlockingOnOpen(t: FsObjectType): boolean {
  return t === "fifo" || t === "socket" || t === "blockDevice" || t === "charDevice";
}

export function occupies(fs: ReadOnlyFs, path: string): boolean {
  return fs.objectType(path) !== "absent";
}

export function isRealDirectory(fs: ReadOnlyFs, path: string): boolean {
  return fs.objectType(path) === "directory";
}

export function isRegularFile(fs: ReadOnlyFs, path: string): boolean {
  return fs.objectType(path) === "regular";
}

/**
 * Byte limits, declared centrally because a reviewer measured 5 GiB of RSS from
 * a single sparse file at a governed source path, and an `anchorBytes` taken
 * from mutable state driving a `Buffer.alloc`. A program meant to run on a timer
 * needs its reads bounded by ITS number, not by the file's.
 */
export const READ_LIMITS = {
  /** a governed source file; the largest real one is ~30 KB */
  governedSource: 4 * 1024 * 1024,
  /** a declared semantic asset */
  asset: 16 * 1024 * 1024,
  /** a registry, manifest, config or anchor declaration */
  declaration: 4 * 1024 * 1024,
  /** the sealed prefix of a ledger */
  anchorPrefix: 8 * 1024 * 1024,
  /** entries returned from any single directory listing */
  directoryEntries: 4096,
} as const;
