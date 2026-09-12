/**
 * T05B platform adapter: consistent snapshots, the encrypted container, and the
 * continuity census. This is where the capability lives; `core/` stays pure.
 *
 * Three decisions worth stating, because each one is a failure mode somewhere
 * else in the landscape audit:
 *
 *  1. SQLite is captured with `VACUUM INTO`, never with a byte copy. A live WAL
 *     database copied file-by-file is torn: it compares equal to itself, restores
 *     without error, and fails `PRAGMA integrity_check` — which nobody runs. Here
 *     the copy is re-opened and integrity-checked before it is allowed to count.
 *
 *  2. The container is written by this process, in this process. No `tar`, no
 *     `gpg`, no `child_process`: a backup that depends on which binaries happen to
 *     be installed is a backup that stops working on the machine you restore onto,
 *     which is by definition not the machine you tested on.
 *
 *  3. The key is a local file with 0600, and its FINGERPRINT — never the key — is
 *     what travels in the manifest and the logs. The threat this actually defends
 *     against is the package leaving the machine: a copy in cloud storage is
 *     useless without the local key. It does NOT defend against someone who
 *     already has the disk, and the receipt says so rather than implying more.
 */

import {
  chmodSync, closeSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  ArchivePort, ArchiveResult, CensusInputs, CensusPort, PackedEntry,
  SnapshotPort, SnapshotResult,
} from "../../core/ports/backup-ports.js";
import type { ContinuityCensus } from "../../core/domain/backup-manifest.js";

const sha256Hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function attemptPath(destinationPath: string): string {
  return `${destinationPath}.partial-${process.pid}-${randomBytes(6).toString("hex")}`;
}

function removeAttempt(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* preserve the primary failure */ }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function hashFile(path: string): { bytes: number; sha256: string } {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      total += n;
    }
    return { bytes: total, sha256: h.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

export const nodeSnapshotPort: SnapshotPort = {
  sqliteConsistentCopy(sourcePath: string, destinationPath: string): SnapshotResult {
    if (!existsSync(sourcePath)) {
      return { ok: false, failure: "source_absent", detail: basename(sourcePath) };
    }
    if (existsSync(destinationPath)) {
      return { ok: false, failure: "destination_exists", detail: basename(destinationPath) };
    }

    mkdirSync(dirname(destinationPath), { recursive: true });
    const tmp = attemptPath(destinationPath);
    let db: DatabaseSync | undefined;
    let sourceError: unknown = null;
    try {
      // Read-only on the SOURCE: a backup must never be able to modify what it
      // is copying, not even by triggering a WAL checkpoint on close.
      db = new DatabaseSync(sourcePath, { readOnly: true });
      db.prepare("VACUUM INTO ?").run(tmp);
    } catch (e) {
      sourceError = e;
    } finally {
      try { db?.close(); } catch { /* the source is read-only; nothing to salvage */ }
    }
    if (sourceError !== null) {
      removeAttempt(tmp);
      return {
        ok: false,
        failure: "source_unreadable",
        detail: String((sourceError as Error).message ?? sourceError),
      };
    }

    // The candidate copy must pass its OWN integrity check before the public
    // destination exists. A failed/crashed attempt therefore cannot wedge a
    // later retry or leave a corrupt file looking like a completed snapshot.
    let copy: DatabaseSync | undefined;
    let verdict = "missing";
    let copyError: unknown = null;
    try {
      copy = new DatabaseSync(tmp, { readOnly: true });
      const row = copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      verdict = row?.integrity_check ?? "missing";
    } catch (e) {
      copyError = e;
    } finally {
      try { copy?.close(); } catch { /* ignore */ }
    }
    if (copyError !== null) {
      removeAttempt(tmp);
      return {
        ok: false,
        failure: "inconsistent_copy",
        detail: String((copyError as Error).message ?? copyError),
      };
    }
    if (verdict !== "ok") {
      removeAttempt(tmp);
      return { ok: false, failure: "integrity_check_failed", detail: verdict };
    }

    try {
      const result = hashFile(tmp);
      // Recheck just before publication so an already completed backup is never
      // deliberately clobbered by a retry.
      if (existsSync(destinationPath)) {
        removeAttempt(tmp);
        return { ok: false, failure: "destination_exists", detail: basename(destinationPath) };
      }
      renameSync(tmp, destinationPath);
      return { ok: true, ...result };
    } catch (e) {
      removeAttempt(tmp);
      return { ok: false, failure: "destination_unwritable", detail: String((e as Error).message ?? e) };
    }
  },

  fileCopy(sourcePath, destinationPath, options): SnapshotResult {
    if (!existsSync(sourcePath)) {
      return { ok: false, failure: "source_absent", detail: basename(sourcePath) };
    }
    if (existsSync(destinationPath)) {
      return { ok: false, failure: "destination_exists", detail: basename(destinationPath) };
    }
    try {
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    } catch (e) {
      return { ok: false, failure: "destination_unwritable", detail: String((e as Error).message ?? e) };
    }
    const { bytes, sha256 } = hashFile(destinationPath);
    const floor = options?.expectAtLeastBytes;
    if (floor !== undefined && bytes < floor) {
      // An append-only artifact that SHRANK is either truncation or the wrong
      // file. Either way the copy is not what was observed, so it does not count.
      rmSync(destinationPath, { force: true });
      return {
        ok: false,
        failure: "inconsistent_copy",
        detail: `append-only source shrank: observed ${floor} B, copied ${bytes} B`,
      };
    }
    return { ok: true, bytes, sha256 };
  },

  listDirectoryFiles(dirPath: string): readonly string[] {
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1));
  },
};

// ---------------------------------------------------------------------------
// Container + encryption
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from("DLSBK1\n", "utf8");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
export const ENCRYPTION_LABEL = "aes-256-gcm";
const FINGERPRINT_DOMAIN = "delos-backup-key-fingerprint-v1\n";

function containedEntryPath(rel: string): boolean {
  if (rel === "") return false;
  const s = rel.replace(/\\/g, "/");
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s)) return false;
  return !s.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

type RestoreDestination =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly failure: "entry_path_escapes_package" | "destination_exists" | "io_failed";
      readonly detail: string;
    };

/**
 * Prepare one extraction destination without following pre-existing symlinks.
 *
 * Archive entry syntax alone is not enough: a lexical `sub/file` escapes if the
 * restore tree already contains `sub -> /somewhere/else`. Missing directories
 * are created one segment at a time only after their parent has been checked.
 * Existing final paths are refused rather than followed/clobbered, which also
 * prevents writes through a pre-existing hard link.
 */
function prepareRestoreDestination(destinationDir: string, rel: string): RestoreDestination {
  const root = resolve(destinationDir);
  try {
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, failure: "entry_path_escapes_package", detail: "restore_root_not_plain_directory" };
    }

    const parts = rel.replace(/\\/g, "/").split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      const next = join(parent, part);
      if (existsSync(next)) {
        const st = lstatSync(next);
        if (st.isSymbolicLink()) {
          return { ok: false, failure: "entry_path_escapes_package", detail: rel };
        }
        if (!st.isDirectory()) {
          return { ok: false, failure: "io_failed", detail: `restore parent is not a directory: ${part}` };
        }
      } else {
        // Parent was just verified. Non-recursive creation avoids traversing an
        // attacker-controlled child path if another object appears concurrently.
        mkdirSync(next, { mode: 0o700 });
      }
      parent = next;
    }

    const dst = join(parent, parts[parts.length - 1]!);
    const lexical = resolve(dst);
    if (lexical !== root && !lexical.startsWith(root + sep)) {
      return { ok: false, failure: "entry_path_escapes_package", detail: rel };
    }
    if (existsSync(dst)) {
      return { ok: false, failure: "destination_exists", detail: rel };
    }
    return { ok: true, path: dst };
  } catch (e) {
    return { ok: false, failure: "io_failed", detail: String((e as Error).message ?? e) };
  }
}

/**
 * Read (or create) the local backup key.
 *
 * Created once, at 0600, under the owner's state root. The alternative — a
 * passphrase only Owner knows — fails the operator covenant the first time she
 * needs a restore and cannot remember it, and a backup nobody can restore is the
 * thing this whole tranche exists to prevent.
 */
export function loadOrCreateKey(keyPath: string): ArchiveResult<Buffer> {
  try {
    if (!existsSync(keyPath)) {
      mkdirSync(dirname(keyPath), { recursive: true });
      const key = randomBytes(KEY_BYTES);
      // Write 0600 from the start: a key that is briefly world-readable was
      // world-readable.
      writeFileSync(keyPath, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
      chmodSync(keyPath, 0o600);
      return { ok: true, value: key };
    }
    const st = statSync(keyPath);
    if ((st.mode & 0o077) !== 0) {
      return {
        ok: false,
        failure: "key_permissions_too_open",
        detail: `mode ${(st.mode & 0o777).toString(8)}; expected 600`,
      };
    }
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== KEY_BYTES) {
      return { ok: false, failure: "key_malformed", detail: `${key.length} bytes, expected ${KEY_BYTES}` };
    }
    return { ok: true, value: key };
  } catch (e) {
    return { ok: false, failure: "key_absent", detail: String((e as Error).message ?? e) };
  }
}

export function keyFingerprintOf(key: Buffer): string {
  return sha256Hex(Buffer.concat([Buffer.from(FINGERPRINT_DOMAIN, "utf8"), key]));
}

/**
 * Entry stream: for each entry, `u32 pathLen | path | u64 dataLen | data`, with
 * entries in byte order of their path so the plaintext is deterministic. Lengths
 * are fixed-width big-endian rather than varint for exactly one reason: a reader
 * written six years from now should be able to parse it from this comment.
 */
function encodeEntries(stagingDir: string, entryPaths: readonly string[]): {
  plaintext: Buffer; entries: PackedEntry[];
} {
  const sorted = [...entryPaths].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1));
  const chunks: Buffer[] = [];
  const entries: PackedEntry[] = [];
  for (const rel of sorted) {
    const data = readFileSync(join(stagingDir, rel));
    const path = Buffer.from(rel, "utf8");
    const head = Buffer.alloc(4 + 8);
    head.writeUInt32BE(path.length, 0);
    head.writeBigUInt64BE(BigInt(data.length), 4);
    chunks.push(head.subarray(0, 4), path, head.subarray(4), data);
    entries.push({ entryPath: rel, bytes: data.length, sha256: sha256Hex(data) });
  }
  return { plaintext: Buffer.concat(chunks), entries };
}

function decodeEntries(plain: Buffer): PackedEntry[] | string {
  const out: PackedEntry[] = [];
  let off = 0;
  while (off < plain.length) {
    if (off + 4 > plain.length) return "truncated_path_length";
    const pathLen = plain.readUInt32BE(off); off += 4;
    if (off + pathLen > plain.length) return "truncated_path";
    const rel = plain.subarray(off, off + pathLen).toString("utf8"); off += pathLen;
    if (off + 8 > plain.length) return "truncated_data_length";
    const dataLen = Number(plain.readBigUInt64BE(off)); off += 8;
    if (off + dataLen > plain.length) return "truncated_data";
    const data = plain.subarray(off, off + dataLen); off += dataLen;
    if (!containedEntryPath(rel)) return `escaping_entry_path:${rel}`;
    out.push({ entryPath: rel, bytes: dataLen, sha256: sha256Hex(data) });
  }
  return out;
}

export function createNodeArchivePort(keyPath: string): ArchivePort {
  return {
    keyFingerprint(): ArchiveResult<string> {
      const k = loadOrCreateKey(keyPath);
      if (!k.ok) return k;
      return { ok: true, value: keyFingerprintOf(k.value) };
    },

    pack(stagingDir, entryPaths, destinationPath) {
      if (existsSync(destinationPath)) {
        return { ok: false, failure: "destination_exists", detail: basename(destinationPath) };
      }
      for (const rel of entryPaths) {
        if (!containedEntryPath(rel)) {
          return { ok: false, failure: "entry_path_escapes_package", detail: rel };
        }
        const abs = resolve(stagingDir, rel);
        if (abs !== resolve(stagingDir) && !abs.startsWith(resolve(stagingDir) + sep)) {
          return { ok: false, failure: "entry_path_escapes_package", detail: rel };
        }
      }
      const k = loadOrCreateKey(keyPath);
      if (!k.ok) return k;
      // Each attempt owns a unique staging name. A crash may leave an orphaned
      // partial, but that orphan can never wedge the next retry by colliding with
      // a fixed `.partial` pathname. The current attempt cleans up its own file on
      // any caught failure, while the final rename keeps the published package
      // atomic for readers.
      const tmp = attemptPath(destinationPath);
      try {
        const { plaintext, entries } = encodeEntries(stagingDir, entryPaths);
        const compressed = deflateRawSync(plaintext, { level: 6 });
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", k.value, iv);
        // The magic is authenticated but not encrypted, so a truncated or
        // substituted header is an authentication failure rather than garbage.
        cipher.setAAD(MAGIC);
        const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
        const tag = cipher.getAuthTag();
        writeFileSync(tmp, Buffer.concat([MAGIC, iv, tag, body]), { mode: 0o600, flag: "wx" });
        // Rename last: a reader never sees a half-written package under its real
        // name, so "the file exists" and "the file is complete" are the same fact.
        renameSync(tmp, destinationPath);
        return {
          ok: true,
          value: {
            entries,
            plaintextBytes: plaintext.length,
            packageBytes: statSync(destinationPath).size,
          },
        };
      } catch (e) {
        removeAttempt(tmp);
        return { ok: false, failure: "io_failed", detail: String((e as Error).message ?? e) };
      }
    },

    unpack(packagePath, destinationDir) {
      const k = loadOrCreateKey(keyPath);
      if (!k.ok) return k;
      let raw: Buffer;
      try {
        raw = readFileSync(packagePath);
      } catch (e) {
        return { ok: false, failure: "io_failed", detail: String((e as Error).message ?? e) };
      }
      const minimum = MAGIC.length + IV_BYTES + TAG_BYTES;
      if (raw.length < minimum) {
        return { ok: false, failure: "container_malformed", detail: `${raw.length} bytes` };
      }
      const magic = raw.subarray(0, MAGIC.length);
      if (magic.length !== MAGIC.length || !timingSafeEqual(magic, MAGIC)) {
        return { ok: false, failure: "container_version_unsupported", detail: magic.toString("hex") };
      }
      const iv = raw.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
      const tag = raw.subarray(MAGIC.length + IV_BYTES, minimum);
      const body = raw.subarray(minimum);
      let plain: Buffer;
      try {
        const d = createDecipheriv("aes-256-gcm", k.value, iv);
        d.setAAD(MAGIC);
        d.setAuthTag(tag);
        plain = inflateRawSync(Buffer.concat([d.update(body), d.final()]));
      } catch (e) {
        // GCM failure means the wrong key OR a modified package, and the two are
        // not distinguishable — which is the property that makes it useful.
        return { ok: false, failure: "authentication_failed", detail: String((e as Error).message ?? e) };
      }
      const decoded = decodeEntries(plain);
      if (typeof decoded === "string") {
        return {
          ok: false,
          failure: decoded.startsWith("escaping_") ? "entry_path_escapes_package" : "container_malformed",
          detail: decoded,
        };
      }

      // Resolve all destinations before writing any payload byte. This prevents
      // a pre-existing symlink/hard-link target from turning an otherwise valid
      // archive pathname into an out-of-root or destructive write.
      const destinations: string[] = [];
      for (const e of decoded) {
        const prepared = prepareRestoreDestination(destinationDir, e.entryPath);
        if (!prepared.ok) return prepared;
        destinations.push(prepared.path);
      }

      try {
        let off = 0;
        for (let index = 0; index < decoded.length; index += 1) {
          const e = decoded[index]!;
          // Re-walk the plaintext in the same order to recover the bytes.
          off += 4;
          const pathLen = Buffer.byteLength(e.entryPath, "utf8");
          off += pathLen + 8;
          const data = plain.subarray(off, off + e.bytes);
          off += e.bytes;
          // Exclusive creation preserves the preflight's no-clobber contract if
          // a path appears between validation and the actual write.
          writeFileSync(destinations[index]!, data, { mode: 0o600, flag: "wx" });
        }
      } catch (err) {
        return { ok: false, failure: "io_failed", detail: String((err as Error).message ?? err) };
      }
      return { ok: true, value: { entries: decoded } };
    },
  };
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

function openRo(path: string | null): DatabaseSync | null {
  if (path === null || !existsSync(path)) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

function count(db: DatabaseSync, table: string): number {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    return r.n;
  } catch {
    return -1;
  }
}

function scalar(db: DatabaseSync, sql: string): string {
  try {
    const r = db.prepare(sql).get() as Record<string, unknown> | undefined;
    if (r === undefined) return "";
    const v = Object.values(r)[0];
    return v === null || v === undefined ? "" : String(v);
  } catch {
    return "<unavailable>";
  }
}

function digestOfRows(rows: readonly string[]): { digest: string; count: number } {
  const sorted = [...rows].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1));
  return { digest: sha256Hex(sorted.map((r) => r + "\n").join("")), count: sorted.length };
}

/**
 * Derive the continuity census from a Delos state tree — live or restored, with
 * the SAME code on both sides. Anything absent is recorded as absent rather than
 * skipped: a restore that lost a whole database must not produce a census that
 * simply has fewer keys and compares equal to nothing.
 */
export const nodeCensusPort: CensusPort = {
  derive(inputs: CensusInputs) {
    const rowCounts: Record<string, number> = {};
    const chainHeads: Record<string, string> = {};
    const integrity: Record<string, string> = {};
    const schemaVersions: Record<string, number> = {};
    const stableIds: string[] = [];
    const sourcePointers: string[] = [];

    const checkDb = (logical: string, db: DatabaseSync): void => {
      const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      integrity[logical] = row?.integrity_check ?? "missing";
      const v = db.prepare("SELECT max(version) AS v FROM migration_ledger").get() as { v: number | null };
      schemaVersions[logical] = v.v ?? 0;
    };

    const mn = openRo(inputs.mnemosynePath);
    if (mn !== null) {
      try {
        checkDb("mnemosyne", mn);
        for (const t of ["memory_items", "memory_events", "memory_tags", "sources",
          "priors_current", "fragments"]) {
          rowCounts[`mnemosyne:${t}`] = count(mn, t);
        }
        chainHeads["mnemosyne:memory_events"] =
          scalar(mn, "SELECT max(seq) FROM memory_events") + "/"
          + scalar(mn, "SELECT event_id FROM memory_events ORDER BY seq DESC LIMIT 1");
        for (const r of mn.prepare("SELECT id FROM memory_items").all() as { id: string }[]) {
          stableIds.push(`memory:${r.id}`);
        }
        for (const r of mn.prepare("SELECT subject_kind, subject_id, kind, pointer FROM sources").all() as
          { subject_kind: string; subject_id: string; kind: string; pointer: string }[]) {
          // The pointer is a Delos-internal locator (conversation/turn/message id),
          // never message text, so this digest carries no private content.
          sourcePointers.push(`${r.subject_kind}/${r.subject_id}/${r.kind}/${r.pointer}`);
        }
      } finally {
        mn.close();
      }
    }

    const bl = openRo(inputs.backlogPath);
    if (bl !== null) {
      try {
        checkDb("decision_backlog", bl);
        for (const t of ["backlog_items", "backlog_receipts", "provider_ledger", "backlog_meta"]) {
          rowCounts[`backlog:${t}`] = count(bl, t);
        }
        chainHeads["backlog:receipts"] = scalar(bl, "SELECT max(seq) FROM backlog_receipts");
        for (const r of bl.prepare("SELECT identity FROM backlog_items").all() as { identity: string }[]) {
          stableIds.push(`backlog:${r.identity}`);
        }
        for (const r of bl.prepare(
          "SELECT identity, conversation_id, turn_id FROM backlog_items").all() as
          { identity: string; conversation_id: string; turn_id: string }[]) {
          sourcePointers.push(`backlog/${r.identity}/turn/${r.conversation_id}:${r.turn_id}`);
        }
      } finally {
        bl.close();
      }
    }

    const cs = openRo(inputs.currentSituationPath);
    if (cs !== null) {
      try {
        const row = cs.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
        integrity["current_situation"] = row?.integrity_check ?? "missing";
        rowCounts["current_situation:current_situation"] = count(cs, "current_situation");
      } finally {
        cs.close();
      }
    }

    const ep = openRo(inputs.episodeProjectionPath);
    if (ep !== null) {
      try {
        const row = ep.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
        integrity["episode_projection"] = row?.integrity_check ?? "missing";
        for (const t of (ep.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as { name: string }[])) {
          rowCounts[`episode:${t.name}`] = count(ep, t.name);
        }
      } finally {
        ep.close();
      }
    }

    let transcriptFiles = 0;
    let transcriptBytes = 0;
    if (inputs.transcriptsDir !== null && existsSync(inputs.transcriptsDir)) {
      for (const name of nodeSnapshotPort.listDirectoryFiles(inputs.transcriptsDir)) {
        if (!name.endsWith(".jsonl")) continue;
        transcriptFiles += 1;
        transcriptBytes += statSync(join(inputs.transcriptsDir, name)).size;
        stableIds.push(`transcript:${name}`);
      }
    }

    const ids = digestOfRows(stableIds);
    const ptrs = digestOfRows(sourcePointers);
    const census: ContinuityCensus = {
      rowCounts,
      chainHeads,
      stableIdDigest: ids.digest,
      stableIdCount: ids.count,
      sourcePointerDigest: ptrs.digest,
      sourcePointerCount: ptrs.count,
      transcriptFiles,
      transcriptBytes,
    };
    return { census, integrity, schemaVersions };
  },
};

/** Exported for the CLI's operator-facing size report; not part of any proof. */
export function directoryBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    total += d.isDirectory() ? directoryBytes(p) : statSync(p).size;
  }
  return total;
}

/** Kept for symmetry with the read path; `relative` is used by the CLI's reporting. */
export const _pathHelpers = { relative, createReadStream };
