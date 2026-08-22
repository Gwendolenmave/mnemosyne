/**
 * Mnemosyne runtime surface for M2-4: a compatibility facade that serves
 * the EXISTING MemoryStore port (read-only authority surface), plus the
 * preflight probe. Opening Mnemosyne may deterministically rebuild disposable
 * projections from the append-only event truth; it never creates memory
 * authority by doing so.
 *
 * The facade renders the structured Memory Read Packet for the legacy
 * opaque-text channel; the structured injection itself (ContextInput
 * extension) is M3 and is deliberately NOT wired here. The facade always
 * runs with a conservative scene (no AU, no intimacy), so AU-scoped and
 * intimate memories can never leak through the legacy channel.
 */

import type { MemoryProbe, MemoryRetrieval, MemoryStore } from "../../../core/ports/memory-store.js";
import {
  buildMemoryReadPacket,
  renderMemoryPacket,
  type MemorySceneScope,
} from "../../../core/services/anamnesis.js";
import { sha256Hex } from "../../../core/services/prompt-loader.js";
import { MnemosyneStore } from "./mnemosyne-store.js";
import { SqliteMemoryEventLog } from "./sqlite-memory-event-log.js";

const CONSERVATIVE_SCENE: MemorySceneScope = { mode: "ordinary", intimacyActive: false };

/**
 * Runtime projection reads must not allow another connection to commit newer
 * event truth between the freshness proof and the derived-table statement.
 *
 * BEGIN IMMEDIATE is deliberately stronger than a plain read snapshot: it
 * reserves the writer slot for the tiny duration of each derived read. A
 * competing governed writer therefore either runs before this read begins or
 * after it commits, never inside the freshness/read critical window.
 */
class ProjectionLockedMnemosyneStore extends MnemosyneStore {
  constructor(private readonly eventLog: SqliteMemoryEventLog) {
    super(eventLog);
  }

  private withProjectionReadLock<T>(read: () => T): T {
    const db = this.eventLog.db;
    if (db.isTransaction) {
      return read();
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const result = read();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  override ftsSearch(query: string, limit: number): ReturnType<MnemosyneStore["ftsSearch"]> {
    return this.withProjectionReadLock(() => super.ftsSearch(query, limit));
  }

  override getItem(id: string): ReturnType<MnemosyneStore["getItem"]> {
    return this.withProjectionReadLock(() => super.getItem(id));
  }

  override listItems(): ReturnType<MnemosyneStore["listItems"]> {
    return this.withProjectionReadLock(() => super.listItems());
  }

  override listPriors(): ReturnType<MnemosyneStore["listPriors"]> {
    return this.withProjectionReadLock(() => super.listPriors());
  }

  override listFragments(nowIso: string): ReturnType<MnemosyneStore["listFragments"]> {
    return this.withProjectionReadLock(() => super.listFragments(nowIso));
  }

  override listSources(
    subjectKind: string,
    subjectId: string,
  ): ReturnType<MnemosyneStore["listSources"]> {
    return this.withProjectionReadLock(() => super.listSources(subjectKind, subjectId));
  }
}

export interface MnemosyneHandle {
  log: SqliteMemoryEventLog;
  store: MnemosyneStore;
  facade: MnemosyneReadFacade;
}

/**
 * Open (or create) the canonical container and recover disposable projections
 * to the exact authoritative event prefix before exposing any read surface.
 */
export function openMnemosyne(dbPath: string): MnemosyneHandle {
  const log = new SqliteMemoryEventLog(dbPath);
  const store = new ProjectionLockedMnemosyneStore(log);
  try {
    store.recoverProjectionIfNeeded();
  } catch (error) {
    log.close();
    throw error;
  }
  return { log, store, facade: new MnemosyneReadFacade(store, dbPath) };
}

export class MnemosyneReadFacade implements MemoryStore {
  readonly transport: string;

  constructor(
    private readonly store: MnemosyneStore,
    dbPath: string,
  ) {
    this.transport = `mnemosyne ${dbPath}`;
  }

  async search(query: string, limit: number): Promise<MemoryRetrieval> {
    try {
      const packet = buildMemoryReadPacket({
        source: this.store,
        query,
        scene: CONSERVATIVE_SCENE,
        nowIso: new Date().toISOString(),
      });
      const resultText = renderMemoryPacket(packet);
      return {
        status: "ok",
        transport: this.transport,
        query,
        limit,
        resultText,
        resultSha256: resultText.length > 0 ? sha256Hex(resultText) : null,
      };
    } catch (error) {
      return {
        status: "degraded",
        transport: this.transport,
        query,
        limit,
        resultText: "",
        resultSha256: null,
        detail: `memory paused this turn (${error instanceof Error ? error.message : String(error)}); chat is unaffected`,
      };
    }
  }

  async probe(): Promise<MemoryProbe> {
    try {
      const items = this.store.listItems().length;
      const priors = this.store.listPriors().length;
      return { available: true, detail: `mnemosyne ready (${items} items, ${priors} priors)` };
    } catch (error) {
      return {
        available: false,
        detail: `mnemosyne unavailable (${error instanceof Error ? error.message : String(error)}); chat is unaffected`,
      };
    }
  }
}

/**
 * Preflight probe (acceptance #9): node:sqlite loadable, migrations/schema
 * compatible, FTS5 answering, database writable — reported in one human
 * line. Never throws.
 */
export function mnemosynePreflight(dbPath: string): { ok: boolean; detail: string } {
  try {
    const handle = openMnemosyne(dbPath);
    try {
      handle.store.ftsSearch("preflight probe 探针", 1);
      const version = handle.log.schemaVersion;
      const items = handle.store.listItems().length;
      return {
        ok: true,
        detail: `mnemosyne ready (packet path; schema v${version}, ${items} items, fts answering, file writable)`,
      };
    } finally {
      handle.log.close();
    }
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error
          ? `${error.message} — memory stays off this run, chat is unaffected`
          : "memory unavailable — chat is unaffected",
    };
  }
}
