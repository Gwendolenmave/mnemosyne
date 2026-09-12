/**
 * L1-T03 Pass2 bundle identity + cache identities (§3.5 / §5.2 / §9). Pure and
 * deterministic. Computes the versioned summary-bundle hash and its drift
 * check, the six-component episode/assembly cache key, the three-component
 * chunk cache key, and the assembly-input fingerprint over validated chunk
 * summaries. Reuses the T02 canonical serializer (single source); adds NO
 * persistent cache — T03 builds identities only, it does not store anything.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../domain/episode-pass1.js";
import type {
  ChunkCacheKey,
  ChunkModelOutput,
  EpisodeCacheKey,
  SummaryBundle,
  SummaryBundleManifest,
} from "../domain/episode-pass2.js";

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Bundle hash + drift (§5.2)
// ---------------------------------------------------------------------------

/**
 * Canonical bundle bytes: object keys are recursively sorted (T02 canonicalize)
 * so the hash is independent of key insertion order; array order is preserved
 * (the authored order IS the bundle's semantic order). Any one-byte change in
 * any component changes these bytes.
 */
export function canonicalBundleBytes(bundle: SummaryBundle): string {
  return canonicalJson(bundle);
}

/** `sha256:` + 64 hex over the canonical bundle bytes (§5.2). */
export function summaryBundleHash(bundle: SummaryBundle): string {
  return `sha256:${sha256Hex(canonicalBundleBytes(bundle))}`;
}

export type BundleManifestCheck =
  | { ok: true }
  | { ok: false; code: "summary_version_mismatch" | "summary_bundle_drift"; expected: string; actual: string };

/**
 * Drift gate (§5.2): the bundle's summaryVersion must match the manifest's, and
 * the recomputed bundle hash must byte-equal the registered hash. A version
 * that stayed the same while a component changed fails as `summary_bundle_drift`;
 * a mismatched version fails as `summary_version_mismatch`. Fail closed — the
 * caller must not proceed on a false verdict.
 */
export function checkSummaryBundleManifest(bundle: SummaryBundle, manifest: SummaryBundleManifest): BundleManifestCheck {
  if (bundle.summaryVersion !== manifest.summaryVersion) {
    return { ok: false, code: "summary_version_mismatch", expected: manifest.summaryVersion, actual: bundle.summaryVersion };
  }
  const actual = summaryBundleHash(bundle);
  if (actual !== manifest.summaryBundleHash) {
    return { ok: false, code: "summary_bundle_drift", expected: manifest.summaryBundleHash, actual };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Cache identities (§3.5 / §9) — structured, unambiguous (null ≠ ""), NEVER
// string concatenation. The canonical JSON of the key object distinguishes
// null from empty string and is independent of property insertion order.
// ---------------------------------------------------------------------------

/** Episode/assembly six-component cache key (§9.1) → stable identity string. */
export function episodeCacheKey(key: EpisodeCacheKey): string {
  return canonicalJson({
    v: "episode",
    source_hash: key.source_hash,
    summary_version: key.summary_version,
    model: key.model,
    effective_realm: key.effective_realm,
    effective_au_id: key.effective_au_id,
    effective_domain: key.effective_domain,
  });
}

/** Chunk three-component cache key (§9.2) → stable identity string. Realm/au/domain-independent. */
export function chunkCacheKey(key: ChunkCacheKey): string {
  return canonicalJson({
    v: "chunk",
    chunk_hash: key.chunk_hash,
    summary_version: key.summary_version,
    model: key.model,
  });
}

// ---------------------------------------------------------------------------
// Assembly input fingerprint (§9.3) — hash each chunk summary JSON canonically,
// concatenate in ordinal order, hash the whole. Ordinals must be 1..N unique
// and contiguous, else the assembly must not run.
// ---------------------------------------------------------------------------

export interface OrderedChunkSummary {
  ordinal: number;
  summary: ChunkModelOutput;
}

export type AssemblyFingerprintResult =
  | { ok: true; fingerprint: string }
  | { ok: false; code: "ordinal_gap" | "ordinal_duplicate" | "ordinal_empty" };

export function assemblyInputFingerprint(chunks: readonly OrderedChunkSummary[]): AssemblyFingerprintResult {
  if (chunks.length === 0) return { ok: false, code: "ordinal_empty" };
  const seen = new Set<number>();
  for (const c of chunks) {
    if (seen.has(c.ordinal)) return { ok: false, code: "ordinal_duplicate" };
    seen.add(c.ordinal);
  }
  for (let i = 1; i <= chunks.length; i += 1) if (!seen.has(i)) return { ok: false, code: "ordinal_gap" };
  const ordered = [...chunks].sort((a, b) => a.ordinal - b.ordinal);
  const perBlock = ordered.map((c) => sha256Hex(canonicalJson(c.summary)));
  const fingerprint = `sha256:${sha256Hex(perBlock.join("\n"))}`;
  return { ok: true, fingerprint };
}
