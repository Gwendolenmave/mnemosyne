import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isRecord } from "./types.js";

/**
 * Single-instance runtime lock so two pollers cannot run concurrently.
 * Stale handling is conservative: a lock is only taken over when its
 * recorded pid is demonstrably dead, and the stale file is renamed
 * aside (never deleted) for inspection. A lock belonging to a live
 * process is never touched.
 */

export class LockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockHeldError";
  }
}

export type IsProcessAlive = (pid: number) => boolean;

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not ours: treat as alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function inspectLock(
  lockPath: string,
  isAlive: IsProcessAlive = defaultIsProcessAlive,
): { state: "free" } | { state: "live"; pid: number } | { state: "stale"; pid: number | null } {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return { state: "free" };
  }
  let pid: number | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.pid === "number") {
      pid = parsed.pid;
    }
  } catch {
    pid = null;
  }
  if (pid !== null && isAlive(pid)) {
    return { state: "live", pid };
  }
  return { state: "stale", pid };
}

export class RuntimeLock {
  private released = false;

  private constructor(
    private readonly lockPath: string,
    private readonly ownerPid: number,
  ) {}

  static acquire(
    lockPath: string,
    ownerPid: number = process.pid,
    isAlive: IsProcessAlive = defaultIsProcessAlive,
    now: () => Date = () => new Date(),
  ): RuntimeLock {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath, "wx");
        try {
          writeSync(
            fd,
            JSON.stringify({ pid: ownerPid, acquired_at: now().toISOString() }),
            null,
            "utf8",
          );
        } finally {
          closeSync(fd);
        }
        return new RuntimeLock(lockPath, ownerPid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const inspection = inspectLock(lockPath, isAlive);
        if (inspection.state === "live") {
          throw new LockHeldError(
            `runtime lock is held by live process ${inspection.pid}; refusing to start a second poller`,
          );
        }
        if (inspection.state === "stale") {
          // Conservative takeover: move the stale lock aside, never delete it.
          const asidePath = `${lockPath}.stale-${now().getTime()}`;
          try {
            renameSync(lockPath, asidePath);
          } catch {
            // Lost a race with another starter; loop and re-inspect.
          }
        }
      }
    }
    throw new LockHeldError("could not acquire runtime lock after stale takeover attempt");
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    const inspection = inspectLock(this.lockPath, () => true);
    // Only remove a lock we own; never delete someone else's file.
    if (inspection.state !== "free" && "pid" in inspection && inspection.pid === this.ownerPid) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        // Already gone.
      }
    }
  }
}
