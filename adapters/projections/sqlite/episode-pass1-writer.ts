/**
 * L1-T02 offline Pass1 SQLite writer (§9). Writes a validated Pass1Result
 * into a FRESH T01 episodes.db (six-object schema, EpisodesProjectionDb) in
 * a SINGLE transaction. No rename/swap, no live default path: the caller
 * injects an EpisodesProjectionDb opened at a temp/output path. Refuses to
 * write if the container already holds episodes (only an empty schema is
 * accepted). generated/published payloads stay NULL (Pass2 not run); FTS
 * indexes the fallback title + lexical entities (summary is empty) — except
 * intimate rows, whose title is already redacted and whose lexical entities are
 * NOT indexed into FTS (§3.6 / Erratum 5: no raw entity words on a leak surface).
 *
 * The output DB is created through `createPass1OutputDb` (§9.1 / §11.7 micro-
 * erratum): a T02-only safe entry that ENFORCES a runtime output-path boundary
 * — bare relative filename inside an injected workDir, exclusive creation — so
 * a caller can never write into an absolute/traversing/pre-existing path. The
 * raw `writePass1Result(db, ...)` handle entry remains for explicit unit tests.
 *
 * The Pass1Result is already self-validated by the engine; this writer adds
 * the "empty target" guard and the all-or-nothing transaction.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { EpisodesProjectionDb, type EpisodesMigration } from "./episodes-projection-db.js";
import { canonicalJson, type Pass1Result } from "../../../core/domain/episode-pass1.js";
import { validatePass1ResultInternal } from "../../../core/services/episode-pass1.js";

export class Pass1WriteRefusedError extends Error {
  constructor(detail: string) {
    super(`Pass1 write refused: ${detail}`);
    this.name = "Pass1WriteRefusedError";
  }
}

/** Thrown when an output path fails the §9.1 / §11.7 runtime boundary. */
export class Pass1OutputPathError extends Error {
  constructor(detail: string) {
    super(`Pass1 output path rejected: ${detail}`);
    this.name = "Pass1OutputPathError";
  }
}

/**
 * Reject anything that is not a safe BARE relative filename. The name must be
 * a single path component — no separators, no drive, no traversal — so it can
 * only ever land directly inside the injected workDir. Both POSIX and Windows
 * absolute/drive/UNC forms are rejected regardless of the host platform, so
 * the boundary holds identically on Linux CI and Windows dev.
 */
function assertSafeOutputName(name: string): void {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Pass1OutputPathError("output name must be a non-empty string");
  }
  if (name === "." || name === "..") {
    throw new Pass1OutputPathError(`output name must not be "${name}"`);
  }
  if (name.includes("\0")) {
    throw new Pass1OutputPathError("output name must not contain NUL");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Pass1OutputPathError("output name must be a bare filename (no path separators)");
  }
  if (name.includes(":")) {
    throw new Pass1OutputPathError("output name must not contain a drive/stream separator");
  }
  if (posix.isAbsolute(name) || win32.isAbsolute(name)) {
    throw new Pass1OutputPathError("output name must not be an absolute path");
  }
}

/**
 * T02-only safe output entry (§9.1 / §11.7): create a FRESH episodes.db for a
 * Pass1 build under an explicitly-injected `workDir`, named by a safe bare
 * relative filename. Enforces the runtime path boundary (no absolute /
 * traversal / drive / UNC / workDir-escape), refuses an already-existing
 * target, and creates the file EXCLUSIVELY (O_EXCL) so there is no
 * check-then-replace race. The synthetic checks/harness create their DB
 * through here; the raw `EpisodesProjectionDb` handle stays available for
 * explicit unit tests. Does NOT touch the T01 container and adds no real
 * live-path blacklist — safety is structural (containment), not a denylist.
 */
export function createPass1OutputDb(
  workDir: string,
  relativeOutputName: string,
  options?: { migrations?: readonly EpisodesMigration[] },
): EpisodesProjectionDb {
  if (typeof workDir !== "string" || workDir.trim().length === 0) {
    throw new Pass1OutputPathError("workDir must be a non-empty path");
  }
  assertSafeOutputName(relativeOutputName);

  // Resolve inside workDir and re-check containment (defense in depth: even if
  // the name check above were ever loosened, the target must stay inside root).
  const root = resolve(workDir);
  const target = resolve(root, relativeOutputName);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${posix.sep}`) || rel.startsWith(`..${win32.sep}`) || isAbsolute(rel)) {
    throw new Pass1OutputPathError("resolved output path escapes the work directory");
  }

  // Exclusive create: fails atomically if the target already exists (rejects a
  // pre-existing file — including an empty-episodes DB — with no TOCTOU window).
  mkdirSync(root, { recursive: true });
  let fd: number;
  try {
    fd = openSync(target, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Pass1OutputPathError("output target already exists");
    }
    throw error;
  }
  closeSync(fd);

  return new EpisodesProjectionDb(target, options);
}

export function writePass1Result(db: EpisodesProjectionDb, result: Pass1Result): void {
  // Defense in depth (C3): re-run the result-internal invariants at the write
  // boundary — a corrupted result is refused BEFORE the transaction begins, so
  // a validation failure can never leave partial rows.
  const invalid = validatePass1ResultInternal(result);
  if (invalid !== null) {
    throw new Pass1WriteRefusedError(`${invalid.category}: ${invalid.detail}`);
  }
  const existing = db.db.prepare("SELECT count(*) AS c FROM episodes").get() as { c: number };
  if (existing.c > 0) {
    throw new Pass1WriteRefusedError("target episodes.db is not empty");
  }

  const insertEpisode = db.db.prepare(
    "INSERT INTO episodes (" +
      "episode_id, channel, thread, realm, realm_basis, au_id, domain, " +
      "start_message_id, end_message_id, started_at_utc, ended_at_utc, started_at_local, ended_at_local, " +
      "participants, initiator, title, entities_lexical, status, continuation_links, has_continuation, " +
      "source_hash, index_version, summary_version, confidence, sensitivity, " +
      "generated_payload, generated_pending_reason, generated_pending_detail, published_payload, " +
      "overrides_applied_ids, message_count, proactive_count" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'not_run', 'pass2_not_run', NULL, ?, ?, ?)",
  );
  const insertMembership = db.db.prepare(
    "INSERT INTO episode_messages (conversation_id, message_id, episode_id, seq) VALUES (?, ?, ?, ?)",
  );
  const insertFts = db.db.prepare("INSERT INTO episodes_fts (title, entities, summary, episode_id) VALUES (?, ?, ?, ?)");
  const insertOverride = db.db.prepare(
    "INSERT INTO overrides_applied (override_id, kind, op, target, state, detail) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const upsertMeta = db.db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  db.db.exec("BEGIN");
  try {
    for (const e of result.episodes) {
      insertEpisode.run(
        e.episode_id,
        e.channel,
        e.thread,
        e.realm,
        e.realm_basis,
        e.au_id,
        e.domain,
        e.start_message_id,
        e.end_message_id,
        e.started_at_utc,
        e.ended_at_utc,
        e.started_at_local,
        e.ended_at_local,
        canonicalJson(e.participants),
        e.initiator,
        e.title,
        canonicalJson(e.entities_lexical),
        e.status,
        canonicalJson(e.continuation_links),
        e.has_continuation ? 1 : 0,
        e.source_hash,
        e.index_version,
        e.summary_version,
        e.confidence,
        e.sensitivity,
        canonicalJson(e.overrides_applied_ids),
        e.message_count,
        e.proactive_count,
      );
      const ftsEntities = e.sensitivity === "intimate" ? "" : e.entities_lexical.join(" ");
      insertFts.run(e.title, ftsEntities, "", e.episode_id);
    }
    for (const m of result.memberships) {
      insertMembership.run(m.conversation_id, m.message_id, m.episode_id, m.seq);
    }
    for (const o of result.overrides) {
      insertOverride.run(o.override_id, o.kind, o.op, o.target, o.state, o.detail);
    }
    upsertMeta.run("index_version", result.report.index_version);
    upsertMeta.run("summary_version", result.report.summary_version);
    upsertMeta.run("pass1_config_hash", result.report.pass1_config_hash);
    upsertMeta.run("pass1_mode", "synthetic_offline");
    db.db.exec("COMMIT");
  } catch (error) {
    db.db.exec("ROLLBACK");
    throw error;
  }
}
