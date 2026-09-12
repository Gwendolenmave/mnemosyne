/**
 * T05B — what a Delos backup IS, stated as data.
 *
 * This module is pure. It never touches the filesystem, never encrypts anything
 * and never decides when to run. It defines the manifest that travels inside every
 * package, the canonical identity of a package, and the closed refusal set for a
 * manifest that cannot be trusted. The capability-holding adapter is
 * `adapters/platform/node-backup-io.ts`; the scheduler is a port.
 *
 * The design rule, inherited from T05A and from the memory-landscape audit: a
 * backup that cannot be PROVEN restorable is not a backup, it is a file. So the
 * manifest carries everything a restore proof needs to be checked by a reader who
 * has only the package — per-source content identity, the event-chain head, the
 * stable-identifier census, and the source-pointer census — and the proof is a
 * separate, typed verdict rather than "the command exited 0".
 *
 * The other rule the audit made non-negotiable (26 open-source memory systems, 0
 * with a restore check): a failed backup, or a backup whose restore proof fails,
 * MUST NOT replace the last known good package. Retention selects over PROVEN
 * packages only. An unproven package is retained as evidence and never counted.
 */

/** Every logical thing a Delos backup captures. Adding one is a schema change. */
export type BackupSourceKind =
  /** append-only conversation truth: `data/transcripts/*.jsonl` */
  | "transcript"
  /** the memory house: cards, governance events, priors, FTS projections */
  | "mnemosyne"
  /** D0's durable decision queue and its receipts */
  | "decision_backlog"
  /** the inputs Episode projection is derived FROM (never the derived cache) */
  | "episode_inputs"
  /** current-situation store */
  | "current_situation"
  /** Telegram durable runtime state: offsets, pass state, audit log */
  | "telegram_state";

export const BACKUP_SOURCE_KINDS: readonly BackupSourceKind[] = [
  "transcript", "mnemosyne", "decision_backlog", "episode_inputs",
  "current_situation", "telegram_state",
] as const;

/**
 * How a source is captured. This is load-bearing, not descriptive: a live SQLite
 * database copied with a plain file read while a writer holds the WAL is a torn
 * file that passes a byte comparison and fails `PRAGMA integrity_check`. The
 * plan declares the method and the proof checks the method's own guarantee.
 */
export type CaptureMethod =
  /** `VACUUM INTO` — a consistent page-level snapshot taken without blocking writers */
  | "sqlite_consistent_copy"
  /** whole-file copy of an append-only artifact, with the observed length recorded */
  | "append_only_copy"
  /** whole-file copy of a small state document */
  | "document_copy";

export const CAPTURE_METHODS: readonly CaptureMethod[] = [
  "sqlite_consistent_copy", "append_only_copy", "document_copy",
] as const;

/** One captured artifact inside the package. */
export interface BackupEntry {
  /** path INSIDE the package, always forward-slashed and contained */
  readonly entryPath: string;
  readonly kind: BackupSourceKind;
  readonly method: CaptureMethod;
  readonly bytes: number;
  readonly sha256: string;
  /**
   * Where it came from, as a LOGICAL name (`mnemosyne`, `transcripts/<file>`),
   * never an operator-home absolute path. T05A's rule: no operator home directory
   * appears in source, config, fixture or report — and a backup manifest that
   * travels to cloud storage is the most exposed report of all.
   */
  readonly logicalSource: string;
}

/**
 * The continuity facts a restore must reproduce. Captured at snapshot time from
 * the LIVE system and re-derived from the RESTORED copy; the proof is that the
 * two agree. Counting rows is not enough — a restore that silently renumbered
 * every id, or dropped the tail of the event chain, would still count correctly.
 */
export interface ContinuityCensus {
  /** rows per logical table, keyed `<source>:<table>` */
  readonly rowCounts: Readonly<Record<string, number>>;
  /**
   * The head of each append-only event chain, keyed by chain name. For the memory
   * event log this is the last event id and its ordinal; for the decision backlog
   * it is the max receipt seq. A restore that loses the tail changes this.
   */
  readonly chainHeads: Readonly<Record<string, string>>;
  /**
   * A digest over the STABLE IDENTIFIERS the system must keep across a restore —
   * memory ids, conversation ids, turn ids, backlog identities. Sorted, joined,
   * hashed, so the manifest carries a fixed-size witness instead of the ids
   * themselves. Private content never travels in a manifest.
   */
  readonly stableIdDigest: string;
  readonly stableIdCount: number;
  /**
   * A digest over SOURCE POINTERS — the (kind, pointer) pairs that tie a memory
   * card back to the transcript turn it came from. This is the continuity that
   * matters most and the one a naive restore breaks: the cards survive, the
   * pointers dangle, and nothing notices until provenance is questioned.
   */
  readonly sourcePointerDigest: string;
  readonly sourcePointerCount: number;
  /** transcript files and their total bytes, so a truncated append-only set shows */
  readonly transcriptFiles: number;
  readonly transcriptBytes: number;
}

export const BACKUP_MANIFEST_SCHEMA = "delos-backup-manifest-v1";
export const SUPPORTED_BACKUP_MANIFEST_VERSIONS: readonly number[] = [1] as const;

export interface BackupManifest {
  readonly schema: typeof BACKUP_MANIFEST_SCHEMA;
  readonly manifestVersion: number;
  /** package id: `delos-backup-<UTC compact timestamp>-<first 12 of packageIdentity>` */
  readonly packageId: string;
  readonly createdAt: string;
  /** which Delos produced it, so a package from another installation is visible */
  readonly installationId: string;
  readonly sourceSurfaceId: string | null;
  readonly entries: readonly BackupEntry[];
  /** digest over the entry inventory; see `inventoryDigest` */
  readonly inventoryId: string;
  readonly census: ContinuityCensus;
  /** algorithm label, e.g. `aes-256-gcm`; the KEY never appears in a manifest */
  readonly encryption: string;
  /** fingerprint of the key that encrypted the payload, so a wrong key is named */
  readonly keyFingerprint: string;
  /** total plaintext bytes, for the operator-facing size report */
  readonly plaintextBytes: number;
}

export type BackupManifestRefusal =
  | "manifest_absent"
  | "manifest_unparseable"
  | "manifest_schema_unknown"
  | "manifest_version_unsupported"
  | "manifest_field_missing"
  | "manifest_field_malformed"
  | "manifest_empty_inventory"
  | "manifest_duplicate_entry"
  | "manifest_entry_path_escapes_package"
  | "manifest_unknown_source_kind"
  | "manifest_unknown_capture_method"
  | "manifest_inventory_identity_mismatch"
  | "manifest_missing_required_source"
  | "manifest_absolute_path_leak";

export type BackupManifestCheck =
  | { readonly ok: true; readonly manifest: BackupManifest }
  | { readonly ok: false; readonly refusal: BackupManifestRefusal; readonly detail: string };

const IDENTITY = /^(?:sha256:)?[0-9a-f]{64}$/;

/**
 * Sources a package MUST contain to be a Delos backup at all. `episode_inputs`
 * and `current_situation` are optional because an installation may legitimately
 * have neither yet; losing the first three is losing the system.
 */
export const REQUIRED_SOURCE_KINDS: readonly BackupSourceKind[] = [
  "transcript", "mnemosyne", "decision_backlog",
] as const;

function containedEntryPath(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel === "") return false;
  const s = rel.replace(/\\/g, "/");
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s)) return false;
  return !s.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/**
 * An absolute-looking path in a field that is supposed to be logical. Checked
 * explicitly because the manifest is the part of a backup most likely to be read
 * by someone other than Owner — an operator home directory in it is a privacy leak
 * that survives every later redaction.
 */
export function looksAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * Canonical inventory digest. One line per entry, sorted by entryPath in byte
 * order: `"<entryPath> <sha256> <bytes> <kind> <method>\n"`, concatenated, UTF-8,
 * sha256. Same shape as T05A's, and recomputable by hand from the manifest.
 */
export function inventoryDigest(
  entries: readonly BackupEntry[],
  hash: (input: string) => string,
): string {
  const lines = [...entries]
    .sort((a, b) => (a.entryPath < b.entryPath ? -1 : a.entryPath > b.entryPath ? 1 : 0))
    .map((e) => `${e.entryPath} ${e.sha256} ${e.bytes} ${e.kind} ${e.method}\n`);
  return hash(lines.join(""));
}

/**
 * The package identity: the inventory digest bound to the continuity census, so
 * two packages with identical files but different continuity facts are different
 * packages. Deliberately does NOT include `createdAt` — an identical system backed
 * up twice yields the same identity, which is how a no-op backup is recognisable.
 */
export function packageIdentity(
  entries: readonly BackupEntry[],
  census: ContinuityCensus,
  hash: (input: string) => string,
): string {
  return hash([
    inventoryDigest(entries, hash),
    censusDigest(census, hash),
  ].join("\n") + "\n");
}

/** Canonical digest of a census; key order is normalised so JSON order cannot matter. */
export function censusDigest(
  census: ContinuityCensus,
  hash: (input: string) => string,
): string {
  const kv = (o: Readonly<Record<string, string | number>>): string =>
    Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((k) => `${k}=${String(o[k])}\n`).join("");
  return hash([
    "rowCounts\n", kv(census.rowCounts),
    "chainHeads\n", kv(census.chainHeads),
    `stableIdDigest=${census.stableIdDigest}\n`,
    `stableIdCount=${census.stableIdCount}\n`,
    `sourcePointerDigest=${census.sourcePointerDigest}\n`,
    `sourcePointerCount=${census.sourcePointerCount}\n`,
    `transcriptFiles=${census.transcriptFiles}\n`,
    `transcriptBytes=${census.transcriptBytes}\n`,
  ].join(""));
}

function validateCensus(raw: unknown): ContinuityCensus | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "census";
  const c = raw as Record<string, unknown>;
  for (const k of ["stableIdDigest", "sourcePointerDigest"]) {
    if (typeof c[k] !== "string" || !IDENTITY.test(c[k] as string)) return `census.${k}`;
  }
  for (const k of ["stableIdCount", "sourcePointerCount", "transcriptFiles", "transcriptBytes"]) {
    const v = c[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return `census.${k}`;
  }
  for (const k of ["rowCounts", "chainHeads"]) {
    const v = c[k];
    if (typeof v !== "object" || v === null || Array.isArray(v)) return `census.${k}`;
  }
  const rowCounts = c["rowCounts"] as Record<string, unknown>;
  for (const [k, v] of Object.entries(rowCounts)) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return `census.rowCounts.${k}`;
  }
  const chainHeads = c["chainHeads"] as Record<string, unknown>;
  for (const [k, v] of Object.entries(chainHeads)) {
    if (typeof v !== "string") return `census.chainHeads.${k}`;
  }
  return {
    rowCounts: rowCounts as Record<string, number>,
    chainHeads: chainHeads as Record<string, string>,
    stableIdDigest: c["stableIdDigest"] as string,
    stableIdCount: c["stableIdCount"] as number,
    sourcePointerDigest: c["sourcePointerDigest"] as string,
    sourcePointerCount: c["sourcePointerCount"] as number,
    transcriptFiles: c["transcriptFiles"] as number,
    transcriptBytes: c["transcriptBytes"] as number,
  };
}

/**
 * Validate a parsed manifest. Pure: the entry hashes are compared against real
 * bytes by the caller that holds the read capability, exactly as T05A does.
 */
export function validateBackupManifest(
  raw: unknown,
  hash: (input: string) => string,
): BackupManifestCheck {
  const no = (refusal: BackupManifestRefusal, detail: string): BackupManifestCheck =>
    ({ ok: false, refusal, detail });

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return no("manifest_unparseable", "not_an_object");
  }
  const o = raw as Record<string, unknown>;
  if (o["schema"] !== BACKUP_MANIFEST_SCHEMA) {
    return no("manifest_schema_unknown", String(o["schema"]));
  }
  const version = o["manifestVersion"];
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    return no("manifest_field_malformed", "manifestVersion");
  }
  if (!SUPPORTED_BACKUP_MANIFEST_VERSIONS.includes(version)) {
    return no("manifest_version_unsupported", String(version));
  }
  for (const k of ["packageId", "createdAt", "installationId", "inventoryId",
    "encryption", "keyFingerprint"]) {
    if (typeof o[k] !== "string" || (o[k] as string) === "") {
      return no("manifest_field_missing", k);
    }
  }
  if (!IDENTITY.test(o["inventoryId"] as string)) {
    return no("manifest_field_malformed", "inventoryId");
  }
  if (o["sourceSurfaceId"] !== null
    && (typeof o["sourceSurfaceId"] !== "string" || !IDENTITY.test(o["sourceSurfaceId"] as string))) {
    return no("manifest_field_malformed", "sourceSurfaceId");
  }
  const plaintextBytes = o["plaintextBytes"];
  if (typeof plaintextBytes !== "number" || !Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0) {
    return no("manifest_field_malformed", "plaintextBytes");
  }

  const rawEntries = o["entries"];
  if (!Array.isArray(rawEntries)) return no("manifest_field_missing", "entries");
  if (rawEntries.length === 0) return no("manifest_empty_inventory", "0_entries");

  const entries: BackupEntry[] = [];
  const seen = new Set<string>();
  for (const a of rawEntries as readonly unknown[]) {
    if (typeof a !== "object" || a === null) return no("manifest_field_malformed", "entry");
    const e = a as Record<string, unknown>;
    if (!containedEntryPath(e["entryPath"])) {
      return no("manifest_entry_path_escapes_package", String(e["entryPath"]));
    }
    if (typeof e["sha256"] !== "string" || !IDENTITY.test(e["sha256"] as string)) {
      return no("manifest_field_malformed", "entry.sha256");
    }
    const bytes = e["bytes"];
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      return no("manifest_field_malformed", "entry.bytes");
    }
    if (!(BACKUP_SOURCE_KINDS as readonly unknown[]).includes(e["kind"])) {
      return no("manifest_unknown_source_kind", String(e["kind"]));
    }
    if (!(CAPTURE_METHODS as readonly unknown[]).includes(e["method"])) {
      return no("manifest_unknown_capture_method", String(e["method"]));
    }
    if (typeof e["logicalSource"] !== "string" || e["logicalSource"] === "") {
      return no("manifest_field_missing", "entry.logicalSource");
    }
    if (looksAbsolute(e["logicalSource"] as string)) {
      return no("manifest_absolute_path_leak", e["logicalSource"] as string);
    }
    const path = e["entryPath"] as string;
    if (seen.has(path)) return no("manifest_duplicate_entry", path);
    seen.add(path);
    entries.push({
      entryPath: path,
      kind: e["kind"] as BackupSourceKind,
      method: e["method"] as CaptureMethod,
      bytes,
      sha256: e["sha256"] as string,
      logicalSource: e["logicalSource"] as string,
    });
  }

  for (const required of REQUIRED_SOURCE_KINDS) {
    if (!entries.some((e) => e.kind === required)) {
      return no("manifest_missing_required_source", required);
    }
  }

  const censusOrError = validateCensus(o["census"]);
  if (typeof censusOrError === "string") {
    return no("manifest_field_malformed", censusOrError);
  }

  const recomputed = inventoryDigest(entries, hash);
  if (recomputed !== o["inventoryId"]) {
    return no("manifest_inventory_identity_mismatch", recomputed);
  }

  return {
    ok: true,
    manifest: {
      schema: BACKUP_MANIFEST_SCHEMA,
      manifestVersion: version,
      packageId: o["packageId"] as string,
      createdAt: o["createdAt"] as string,
      installationId: o["installationId"] as string,
      sourceSurfaceId: (o["sourceSurfaceId"] as string | null),
      entries,
      inventoryId: o["inventoryId"] as string,
      census: censusOrError,
      encryption: o["encryption"] as string,
      keyFingerprint: o["keyFingerprint"] as string,
      plaintextBytes,
    },
  };
}
