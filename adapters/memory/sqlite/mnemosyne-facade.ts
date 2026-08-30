/**
 * Mnemosyne runtime surface: a compatibility facade that serves the existing
 * MemoryStore port, plus explicit open/create and read-only preflight paths.
 * Opening Mnemosyne may deterministically rebuild disposable projections from
 * append-only event truth; the preflight path never opens that mutable facade.
 *
 * The facade renders the structured Memory Read Packet for the legacy opaque-
 * text channel. It supplies an ordinary scene because this legacy interface has
 * no scene input; realm/AU/sensitivity remain model-visible context and are not
 * implicit access-control gates. Explicit retrieval governance still applies.
 */

import type { MemoryProbe, MemoryRetrieval, MemoryStore } from "../../../core/ports/memory-store.js";
import {
  buildMemoryReadPacket,
  DEFAULT_BUDGETS,
  renderMemoryPacket,
  type MemorySceneScope,
} from "../../../core/services/anamnesis.js";
import { sha256Hex } from "../../../core/services/prompt-loader.js";
import { MnemosyneStore } from "./mnemosyne-store.js";
import { inspectMnemosyneReadOnly } from "./read-only-mnemosyne-inspector.js";
import { SqliteMemoryEventLog } from "./sqlite-memory-event-log.js";

export { inspectMnemosyneReadOnly };

const CONSERVATIVE_SCENE: MemorySceneScope = { mode: "ordinary", intimacyActive: false };

function boundedFacadeMemoryItems(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(DEFAULT_BUDGETS.memoriesItems, Math.floor(limit));
}

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
    if (db.isTransaction) return read();

    db.exec("BEGIN IMMEDIATE");
    try {
      const result = read();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
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
        budgets: {
          ...DEFAULT_BUDGETS,
          // MemoryStore.search promises a bounded search. The packet's normal
          // safety budget remains the hard ceiling, while a smaller caller
          // limit is now actually honored instead of being silently ignored.
          memoriesItems: boundedFacadeMemoryItems(limit),
        },
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
 * Read-only preflight for an existing database. It never creates a database,
 * runs migrations, rebuilds projections, or writes WAL/SHM/journal state.
 * Use openMnemosyne() explicitly when creation/recovery is intended.
 */
export function mnemosynePreflight(dbPath: string): { ok: boolean; detail: string } {
  const result = inspectMnemosyneReadOnly(dbPath);
  return {
    ok: result.ok,
    detail: result.ok
      ? result.detail
      : `${result.detail} — memory stays off this run, chat is unaffected`,
  };
}
