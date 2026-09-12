/**
 * T05B/T05C ports.
 *
 * Core states WHAT it needs; a platform adapter supplies it. Three of these exist
 * because of the memory-landscape audit's LM-GATE-01 amendments:
 *
 *   A. `SchedulerPort` — scheduling is a contract, not a systemd detail. systemd
 *      is one adapter; a laptop that is asleep at 04:00, a container, or a future
 *      OS is another. Nothing in core may name a timer unit.
 *   B. `EgressGatewayPort` — reaching the network is a logical capability. The
 *      fixed local bridge is a deployment instance of it, and DIRECT is an
 *      explicit policy rather than a fallback that happens when discovery fails.
 *   C. deletion is split: `forget` makes something logically gone and is ordinary;
 *      hard purge is physical, crosses every registry including backups, and is
 *      owner-triggered only. They are different capabilities, so they are
 *      different methods with different authority, not one function with a flag.
 */

import type { ContinuityCensus } from "../domain/backup-manifest.js";

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export type SnapshotFailure =
  | "source_absent"
  | "source_unreadable"
  | "inconsistent_copy"
  | "integrity_check_failed"
  | "destination_exists"
  | "destination_unwritable"
  | "budget_exceeded";

export type SnapshotResult =
  | { readonly ok: true; readonly bytes: number; readonly sha256: string }
  | { readonly ok: false; readonly failure: SnapshotFailure; readonly detail: string };

/**
 * Capturing one source consistently.
 *
 * `sqliteConsistentCopy` must produce a copy that passes its own
 * `PRAGMA integrity_check` WITHOUT blocking the live writer, and must refuse
 * rather than emit a torn file. A plain byte copy of a live WAL database is the
 * exact failure this port exists to make impossible to write by accident.
 */
export interface SnapshotPort {
  sqliteConsistentCopy(sourcePath: string, destinationPath: string): SnapshotResult;
  /** whole-file copy; `expectAppendOnly` refuses if the file SHRANK since observation */
  fileCopy(
    sourcePath: string,
    destinationPath: string,
    options?: { readonly expectAtLeastBytes?: number },
  ): SnapshotResult;
  listDirectoryFiles(dirPath: string): readonly string[];
}

// ---------------------------------------------------------------------------
// Packaging and encryption
// ---------------------------------------------------------------------------

export interface PackedEntry {
  readonly entryPath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type ArchiveFailure =
  | "key_absent"
  | "key_malformed"
  | "key_permissions_too_open"
  | "authentication_failed"
  | "container_malformed"
  | "container_version_unsupported"
  | "entry_path_escapes_package"
  | "destination_exists"
  | "io_failed";

export type ArchiveResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ArchiveFailure; readonly detail: string };

/**
 * The encrypted container.
 *
 * The key never crosses this boundary as a value core can see: the adapter reads
 * it from the owner-controlled key path and reports only a fingerprint. A manifest
 * or a log line can therefore name WHICH key was used without ever carrying it.
 */
export interface ArchivePort {
  /** fingerprint of the configured key, or a typed failure if it cannot be used */
  keyFingerprint(): ArchiveResult<string>;
  pack(
    stagingDir: string,
    entryPaths: readonly string[],
    destinationPath: string,
  ): ArchiveResult<{ readonly entries: readonly PackedEntry[]; readonly plaintextBytes: number; readonly packageBytes: number }>;
  unpack(packagePath: string, destinationDir: string): ArchiveResult<{ readonly entries: readonly PackedEntry[] }>;
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

/**
 * Deriving the continuity facts from a Delos state tree — live or restored. The
 * SAME implementation must be usable on both sides; a proof whose two sides are
 * computed by different code proves that the two pieces of code agree, which is
 * not the property anyone wants.
 */
export interface CensusPort {
  derive(stateTree: CensusInputs): {
    readonly census: ContinuityCensus;
    readonly integrity: Readonly<Record<string, string>>;
    readonly schemaVersions: Readonly<Record<string, number>>;
  };
}

export interface CensusInputs {
  readonly mnemosynePath: string | null;
  readonly backlogPath: string | null;
  readonly currentSituationPath: string | null;
  readonly episodeProjectionPath: string | null;
  readonly transcriptsDir: string | null;
}

// ---------------------------------------------------------------------------
// Scheduling (LM-GATE-01 amendment A)
// ---------------------------------------------------------------------------

export interface ScheduledJob {
  /** stable logical id; the adapter derives any unit/task name from it */
  readonly id: string;
  readonly description: string;
  /** wall-clock recurrence, e.g. `daily@04:15`, `hourly:20`; adapter-interpreted */
  readonly schedule: string;
  /** run a missed occurrence when the machine comes back, rather than skipping it */
  readonly catchUpMissed: boolean;
  /** hard wall-clock bound; the adapter must terminate an overrunning job */
  readonly timeoutSeconds: number;
}

export interface ScheduleStatus {
  readonly id: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly lastRunAt: string | null;
  readonly lastResult: "ok" | "failed" | "unknown";
  readonly nextRunAt: string | null;
}

export interface SchedulerPort {
  install(job: ScheduledJob): { readonly ok: boolean; readonly detail: string };
  remove(id: string): { readonly ok: boolean; readonly detail: string };
  status(id: string): ScheduleStatus;
}

// ---------------------------------------------------------------------------
// Egress (LM-GATE-01 amendment B)
// ---------------------------------------------------------------------------

export type EgressPolicy =
  /** all egress through the declared local gateway instance */
  | { readonly kind: "gateway"; readonly endpoint: string }
  /** direct egress, chosen deliberately and recorded — never a discovery fallback */
  | { readonly kind: "direct"; readonly declaredBy: string }
  /** no egress permitted at all */
  | { readonly kind: "none" };

export interface EgressGatewayPort {
  policy(): EgressPolicy;
  /** typed reachability probe; never throws, never silently downgrades to direct */
  probe(): { readonly reachable: boolean; readonly detail: string };
}
