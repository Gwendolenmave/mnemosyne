/**
 * T05A — the one and only module that imports a filesystem MUTATION API.
 *
 * `mkdirSync` appears here, once, and nowhere else in the product. That is the
 * capability boundary made physical: every other module receives a port, so no
 * amount of code in it can rename, unlink, remove, write or spawn — not because
 * a checker looked for those calls, but because it was never handed them.
 *
 * The AST guard in `scripts/t05a-ast-guard.ts` allowlists exactly this file and
 * exactly the identifiers below, and fails on any other module importing from
 * `node:fs`, `node:fs/promises`, `child_process` or `node:child_process` in any
 * form — multiline, aliased, namespace, `require`, dynamic import or computed
 * access. It is a regression alarm on top of the boundary, not a substitute for
 * it.
 */

import {
  accessSync, constants, lstatSync, mkdirSync, openSync, closeSync, readSync,
  readFileSync, readdirSync, readlinkSync, realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  isBlockingOnOpen, type CreateOutcome, type DirectoryCreator, type FsObjectType,
  type ListResult, type PrefixResult, type ReadBytesResult, type ReadOnlyFs,
  type ReadResult, type RealPathResult,
} from "../../core/ports/filesystem-port.js";
import {
  classifyPrefixRead, PREFIX_BLOCK_BYTES, SEALED_PREFIX_POLICY_CEILING,
  type PrefixHashResult, type PrefixHasher,
} from "../../core/ports/prefix-hash-port.js";

function classify(path: string): FsObjectType {
  let st;
  try { st = lstatSync(path); } catch (e) {
    // An error that is NOT "there is nothing here" must not be reported as
    // absence. A reviewer showed `chmod 000` on a ledger directory making its
    // registered anchors vanish from the report with a passing verdict, because
    // every lstat failure collapsed to `absent`.
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "absent" : "unknown";
  }
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "directory";
  if (st.isFile()) return "regular";
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isBlockDevice()) return "blockDevice";
  if (st.isCharacterDevice()) return "charDevice";
  return "unknown";
}

function sizeOf(path: string): number | null {
  try {
    const st = lstatSync(path);
    return Number.isSafeInteger(st.size) ? st.size : null;
  } catch { return null; }
}

/**
 * Size is checked BEFORE any bytes are consumed, and the limit is the caller's.
 * `too_large` is a distinct refusal so a report can say "I declined to read this"
 * rather than "this was fine".
 */
function guardedRead(path: string, maxBytes: number): { ok: false; refusal: "absent" | "not_a_regular_file" | "unreadable" | "too_large"; type: FsObjectType } | { ok: true; type: FsObjectType } {
  const t = classify(path);
  if (t === "absent") return { ok: false, refusal: "absent", type: t };
  if (t !== "regular") return { ok: false, refusal: "not_a_regular_file", type: t };
  const size = sizeOf(path);
  if (size === null) return { ok: false, refusal: "unreadable", type: t };
  if (size > maxBytes) return { ok: false, refusal: "too_large", type: t };
  return { ok: true, type: t };
}

function readRegularFile(path: string, maxBytes: number): ReadResult {
  const g = guardedRead(path, maxBytes);
  if (!g.ok) return g;
  try { return { ok: true, text: readFileSync(path, "utf8") }; }
  catch { return { ok: false, refusal: "unreadable", type: g.type }; }
}

function readRegularFileBytes(path: string, maxBytes: number): ReadBytesResult {
  const g = guardedRead(path, maxBytes);
  if (!g.ok) return g;
  try { return { ok: true, bytes: readFileSync(path) }; }
  catch { return { ok: false, refusal: "unreadable", type: g.type }; }
}

/**
 * A bounded prefix. `want` is clamped to the file's real size and to the
 * caller's limit, so a number arriving from mutable state cannot drive the
 * allocation — a reviewer drove `Buffer.alloc(1_500_000_000)` from an anchor
 * declaration on disk.
 */
function readPrefix(path: string, want: number): PrefixResult {
  const t = classify(path);
  if (t === "absent") return { ok: false, refusal: "absent", type: t };
  if (t !== "regular") return { ok: false, refusal: "not_a_regular_file", type: t };
  if (!Number.isSafeInteger(want) || want <= 0) return { ok: false, refusal: "too_large", type: t };
  const size = sizeOf(path);
  if (size === null) return { ok: false, refusal: "unreadable", type: t };
  const n = Math.min(want, size);
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(n);
    let read = 0;
    while (read < n) {
      const got = readSync(fd, buf, read, n - read, read);
      if (got <= 0) break;
      read += got;
    }
    return { ok: true, bytes: buf.subarray(0, read), fileBytes: size };
  } catch {
    return { ok: false, refusal: "unreadable", type: t };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* nothing to close */ } }
  }
}

function listDirectory(path: string, maxEntries: number): ListResult {
  const t = classify(path);
  if (t === "absent") return { ok: false, refusal: "absent" };
  if (t !== "directory") return { ok: false, refusal: "not_a_directory" };
  try {
    const names = readdirSync(path);
    // Sort FIRST, then cap. The previous order sliced in readdir order and sorted
    // afterwards, so which entries survived depended on the filesystem's hash
    // order — on ext4 the same logical content could produce different reports.
    const sorted = [...names].sort();
    const truncated = sorted.length > maxEntries;
    return {
      ok: true,
      names: truncated ? sorted.slice(0, maxEntries) : sorted,
      truncated,
      total: sorted.length,
    };
  } catch {
    return { ok: false, refusal: "unreadable" };
  }
}

function realPath(path: string): RealPathResult {
  try { return { ok: true, path: realpathSync(path) }; }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, refusal: "absent" };
    if (code === "ELOOP") return { ok: false, refusal: "loop" };
    return { ok: false, refusal: "unreadable" };
  }
}

function linkTarget(path: string): string | null {
  try { return readlinkSync(path); } catch { return null; }
}

function isWritable(path: string): boolean {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}

export const nodeReadOnlyFs: ReadOnlyFs = {
  objectType: classify,
  sizeOf,
  readRegularFile,
  readRegularFileBytes,
  readPrefix,
  listDirectory,
  realPath,
  linkTarget,
  isWritable,
};

/**
 * The whole mutation surface of the product: one exclusive, non-recursive
 * directory creation, with the errno mapped to a closed enum so the report can
 * tell an owner which of four different things to do.
 */
export const nodeDirectoryCreator: DirectoryCreator = {
  createExclusive(absolutePath: string, mode: number): CreateOutcome {
    try {
      mkdirSync(absolutePath, { recursive: false, mode });
      return "created";
    } catch (e) {
      switch ((e as NodeJS.ErrnoException).code) {
        case "EEXIST": return "exists";
        case "EACCES": case "EPERM": return "denied";
        case "ENOENT": case "ENOTDIR": return "no_parent";
        case "ENAMETOOLONG": return "name_too_long";
        case "ENOSPC": case "EDQUOT": return "no_space";
        case "EROFS": return "read_only_filesystem";
        default: return "refused";
      }
    }
  },
};

/** Re-exported so consumers need not import the port module for one predicate. */
export { isBlockingOnOpen };

/**
 * Streaming sealed-prefix verification (Closure C, §5.2).
 *
 * Reads exactly `sealedBytes` in fixed-size blocks and hashes as it goes, so peak
 * memory is one block regardless of the prefix length. That is what lets the
 * policy ceiling sit far above every lawful ledger instead of inside the lawful
 * range, where a reviewer found a correct 9,437,206-byte seal reported as a
 * zero-byte anchor whose history had been rewritten.
 *
 * Every exit path releases the descriptor in `finally`, and the result says so, so
 * "was the fd closed on the error path" is an assertion a fixture can make rather
 * than a claim a reader has to trust.
 */
export const nodePrefixHasher: PrefixHasher = {
  hashRegularFilePrefix(path: string, sealedBytes: number, expected: string): PrefixHashResult {
    const base = {
      declaredBytes: sealedBytes,
      policyCeiling: SEALED_PREFIX_POLICY_CEILING,
    };

    // (2) a safe non-negative integer, checked before anything is opened
    if (!Number.isSafeInteger(sealedBytes) || sealedBytes < 0) {
      return { ...base, outcome: "anchor_declared_bytes_invalid", fileBytes: 0, hashedBytes: 0, identity: null, descriptorClosed: true };
    }
    // (3) an explicit documented ceiling, reported as its own outcome. A limit is
    //     never substituted for an observation about the bytes.
    if (sealedBytes > SEALED_PREFIX_POLICY_CEILING) {
      return { ...base, outcome: "anchor_prefix_over_policy_limit", fileBytes: 0, hashedBytes: 0, identity: null, descriptorClosed: true };
    }
    // (1) a no-follow regular file, or nothing is opened at all
    const t = classify(path);
    if (t !== "regular") {
      return { ...base, outcome: "anchor_wrong_object_type", fileBytes: 0, hashedBytes: 0, identity: null, descriptorClosed: true };
    }
    const size = sizeOf(path);
    if (size === null) {
      return { ...base, outcome: "anchor_io_error", fileBytes: 0, hashedBytes: 0, identity: null, descriptorClosed: true };
    }

    let fd: number | null = null;
    let closed = false;
    let hashed = 0;
    let ioFailed = false;
    let identity: string | null = null;
    try {
      fd = openSync(path, "r");
      const h = createHash("sha256");
      const block = Buffer.alloc(Math.min(PREFIX_BLOCK_BYTES, Math.max(sealedBytes, 1)));
      while (hashed < sealedBytes) {
        const want = Math.min(block.length, sealedBytes - hashed);
        const got = readSync(fd, block, 0, want, hashed);
        if (got <= 0) break;                       // EOF before the declared prefix
        h.update(block.subarray(0, got));
        hashed += got;
      }
      // The identity is only meaningful when the whole declared prefix was read.
      if (hashed === sealedBytes) identity = `sha256:${h.digest("hex")}`;
    } catch {
      ioFailed = true;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); closed = true; } catch { closed = false; }
      } else {
        closed = true;
      }
    }

    return {
      ...base,
      outcome: classifyPrefixRead({
        declaredBytes: sealedBytes,
        fileBytes: size,
        hashedBytes: hashed,
        identity,
        expected,
        ioFailed,
      }),
      fileBytes: size,
      hashedBytes: hashed,
      identity,
      descriptorClosed: closed,
    };
  },
};
