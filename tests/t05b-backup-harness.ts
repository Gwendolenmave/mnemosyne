/**
 * T05B test harness: build a SYNTHETIC Delos state tree.
 *
 * Everything the T05B tests touch is created here, in a temporary directory, from
 * fabricated content. No test in this tranche reads Owner's real transcripts,
 * memory database, backlog or backups — the master programme forbids exercising
 * the deletion path on owner data, and the same discipline applies to the backup
 * path, because a "test" that snapshots the live system is a live action.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupPaths } from "../adapters/runtime/backup-runtime.js";

const CREATED: string[] = [];
process.on("exit", () => {
  for (const d of CREATED) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

export interface SyntheticTree {
  readonly root: string;
  readonly paths: BackupPaths;
}

/** The synthetic memory house: the same tables the real one has, with fake rows. */
function buildMnemosyne(path: string, cards: number): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE migration_ledger (version INTEGER PRIMARY KEY, description TEXT NOT NULL,
      applied_at TEXT NOT NULL, checksum TEXT NOT NULL);
    CREATE TABLE memory_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      scope TEXT NOT NULL, au_id TEXT, sensitivity TEXT NOT NULL, importance INTEGER NOT NULL,
      approval_state TEXT NOT NULL, lifecycle_state TEXT NOT NULL, seal_state TEXT NOT NULL,
      confirmed_by TEXT, retrieval TEXT NOT NULL, supersedes TEXT, source_basis TEXT,
      tags_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      expires_at TEXT, provenance TEXT);
    CREATE TABLE memory_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, type TEXT NOT NULL,
      payload TEXT NOT NULL, occurred_at TEXT NOT NULL, actor TEXT NOT NULL);
    CREATE TABLE memory_tags (memory_id TEXT NOT NULL, tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag));
    CREATE TABLE sources (id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
      kind TEXT NOT NULL, pointer TEXT NOT NULL, note TEXT);
    CREATE TABLE priors_current (key TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL,
      token_est INTEGER NOT NULL, approved_by TEXT NOT NULL, changelog TEXT NOT NULL, expires_at TEXT);
    CREATE TABLE fragments (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, source_id TEXT);
  `);
  db.prepare("INSERT INTO migration_ledger VALUES (?,?,?,?)")
    .run(7, "synthetic", "2026-01-01T00:00:00.000Z", "synthetic-checksum");
  const item = db.prepare(`INSERT INTO memory_items
    (id,title,body,scope,au_id,sensitivity,importance,approval_state,lifecycle_state,seal_state,
     confirmed_by,retrieval,supersedes,source_basis,tags_text,created_at,updated_at,expires_at,provenance)
    VALUES (?,?,?,'relationship',NULL,'normal',2,'policy_activated','active','unsealed',
     NULL,'true',NULL,'explicit','',?,?,NULL,NULL)`);
  const ev = db.prepare(`INSERT INTO memory_events
    (event_id,subject_kind,subject_id,type,payload,occurred_at,actor) VALUES (?,?,?,?,?,?,?)`);
  const src = db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,NULL)");
  for (let i = 0; i < cards; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const at = `2026-01-0${(i % 9) + 1}T00:00:00.000Z`;
    item.run(id, `synthetic card ${i}`, `synthetic body ${i}`, at, at);
    ev.run(`ev-${i}`, "memory", id, "memory_created", "{}", at, "system");
    src.run(`src-${i}`, "memory", id, "transcript",
      `11111111-0000-4000-8000-000000000001:22222222-0000-4000-8000-${String(i).padStart(12, "0")}`);
  }
  db.close();
}

function buildBacklog(path: string, items: number): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE migration_ledger (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE backlog_items (identity TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, user_message_id TEXT, content_sha256 TEXT NOT NULL,
      variant_sha256 TEXT, scene_mode TEXT NOT NULL, scene_au_id TEXT, origin TEXT NOT NULL,
      policy_version TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL,
      queued_at TEXT NOT NULL, source_time TEXT, next_attempt_at TEXT, decided_at TEXT,
      memory_id TEXT, detail TEXT, selected_refs TEXT, prior_versions TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE backlog_receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, identity TEXT NOT NULL,
      at TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, detail TEXT);
    CREATE TABLE backlog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE provider_ledger (call_id TEXT PRIMARY KEY, identity TEXT NOT NULL,
      reserved_at TEXT NOT NULL, settled_at TEXT, outcome TEXT, served_model TEXT);
  `);
  db.prepare("INSERT INTO migration_ledger VALUES (?,?)").run(3, "2026-01-01T00:00:00.000Z");
  const ins = db.prepare(`INSERT INTO backlog_items
    (identity,conversation_id,turn_id,user_message_id,content_sha256,variant_sha256,scene_mode,
     scene_au_id,origin,policy_version,state,attempts,queued_at,source_time,next_attempt_at,
     decided_at,memory_id,detail,selected_refs,prior_versions,updated_at)
    VALUES (?,?,?,NULL,?,NULL,'ordinary',NULL,'live','synthetic-v1','deferred',0,?,NULL,NULL,
     NULL,NULL,NULL,'[]','{}',?)`);
  const rec = db.prepare("INSERT INTO backlog_receipts (identity,at,from_state,to_state,detail) VALUES (?,?,?,?,?)");
  for (let i = 0; i < items; i += 1) {
    const identity = `aa${String(i).padStart(62, "0")}`;
    const at = `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`;
    ins.run(identity, "11111111-0000-4000-8000-000000000001",
      `33333333-0000-4000-8000-${String(i).padStart(12, "0")}`, `cc${String(i).padStart(62, "0")}`, at, at);
    rec.run(identity, at, null, "deferred", "enqueued:live");
  }
  db.prepare("INSERT INTO backlog_meta VALUES ('worker_consecutive_failures','0')").run();
  db.close();
}

function buildCurrentSituation(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE current_situation (id TEXT PRIMARY KEY, value TEXT NOT NULL,
    source_message_id TEXT, source_turn_id TEXT, valid_from TEXT NOT NULL, valid_until TEXT,
    supersedes TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);`);
  db.prepare("INSERT INTO current_situation VALUES (?,?,NULL,NULL,?,NULL,NULL,'active',?)")
    .run("sit-1", "synthetic situation", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.close();
}

export function syntheticTree(options?: {
  readonly cards?: number;
  readonly backlogItems?: number;
  readonly transcripts?: number;
}): SyntheticTree {
  const root = mkdtempSync(join(tmpdir(), "t05b-tree-"));
  CREATED.push(root);
  const data = join(root, "data");
  mkdirSync(join(data, "memory"), { recursive: true });
  mkdirSync(join(data, "transcripts"), { recursive: true });
  mkdirSync(join(data, "telegram"), { recursive: true });

  buildMnemosyne(join(data, "memory", "delos-memory.db"), options?.cards ?? 6);
  buildBacklog(join(data, "memory", "decision-backlog.db"), options?.backlogItems ?? 11);
  buildCurrentSituation(join(data, "memory", "current-situation.db"));

  for (let i = 0; i < (options?.transcripts ?? 3); i += 1) {
    writeFileSync(
      join(data, "transcripts", `2026-01-0${i + 1}T00-00-00-000Z-synthetic-${i}.jsonl`),
      Array.from({ length: 4 }, (_v, j) =>
        JSON.stringify({ role: j % 2 === 0 ? "user" : "assistant", text: `synthetic line ${i}.${j}` }))
        .join("\n") + "\n");
  }
  writeFileSync(join(data, "telegram", "state.json"), JSON.stringify({ offset: 42 }) + "\n");
  writeFileSync(join(data, "telegram", "audit.jsonl"), `{"synthetic":true}\n`);
  // Noise that must NOT be captured: a rotated log is derived, not durable state.
  writeFileSync(join(data, "telegram", "runtime.log"), "synthetic log noise\n");

  return {
    root,
    paths: {
      mnemosynePath: join(data, "memory", "delos-memory.db"),
      backlogPath: join(data, "memory", "decision-backlog.db"),
      currentSituationPath: join(data, "memory", "current-situation.db"),
      episodeProjectionPath: null,
      transcriptsDir: join(data, "transcripts"),
      telegramStateDir: join(data, "telegram"),
      backupRoot: join(root, "state", "backups"),
      workRoot: join(root, "state", "work"),
      keyPath: join(root, "state", "keys", "backup.key"),
      installationId: "synthetic-installation",
    },
  };
}

export function disposableDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  CREATED.push(d);
  return d;
}
