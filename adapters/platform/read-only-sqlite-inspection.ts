import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export type ImmutableSqliteFailureCode =
  | "database_missing"
  | "database_not_regular"
  | "unsafe_sidecar"
  | "database_changed_during_probe"
  | "database_unreadable";

export type ImmutableSqliteReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: ImmutableSqliteFailureCode;
      readonly detail: string;
    };

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly sha256: string;
}

const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function identityOf(path: string): FileIdentity {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new Error("database path is not a regular file");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("database changed while its identity was being captured");
    }
    return {
      dev: after.dev,
      ino: after.ino,
      mode: after.mode,
      size: after.size,
      mtimeNs: after.mtimeNs,
      ctimeNs: after.ctimeNs,
      sha256: hash.digest("hex"),
    };
  } finally {
    closeSync(descriptor);
  }
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.sha256 === right.sha256
  );
}

function existingSidecars(path: string): string[] {
  return SQLITE_SIDECAR_SUFFIXES.filter((suffix) => {
    try {
      lstatSync(`${path}${suffix}`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
  });
}

/**
 * Execute a bounded synchronous reader against a quiescent SQLite file.
 *
 * This helper never creates a database, never coordinates with WAL, and never
 * migrates. WAL/journal companions are rejected before SQLite is opened because
 * even a normal read-only connection may create shared-memory sidecars.
 * `immutable=1` is used only after the file is proven quiescent, and byte
 * identity is verified again after close.
 */
export function readImmutableSqlite<T>(
  path: string,
  reader: (database: DatabaseSync) => T,
): ImmutableSqliteReadResult<T> {
  if (!existsSync(path)) {
    return {
      ok: false,
      code: "database_missing",
      detail: "database missing (preflight never creates it)",
    };
  }

  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile()) {
      return {
        ok: false,
        code: "database_not_regular",
        detail: "database path is not a regular file",
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: "database_unreadable",
      detail: `database metadata is unreadable (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const sidecarsBefore = existingSidecars(path);
  if (sidecarsBefore.length > 0) {
    return {
      ok: false,
      code: "unsafe_sidecar",
      detail:
        `database has active journal state (${sidecarsBefore.join(", ")}); ` +
        "read-only preflight fails closed and does not open it",
    };
  }

  let before: FileIdentity;
  try {
    before = identityOf(path);
  } catch (error) {
    return {
      ok: false,
      code: "database_unreadable",
      detail: `database is unreadable (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  if (existingSidecars(path).length > 0) {
    return {
      ok: false,
      code: "database_changed_during_probe",
      detail: "database journal state appeared during preflight; result discarded",
    };
  }

  let database: DatabaseSync | undefined;
  let value: T | undefined;
  let readError: unknown;
  try {
    const uri = pathToFileURL(path);
    uri.searchParams.set("mode", "ro");
    uri.searchParams.set("immutable", "1");
    database = new DatabaseSync(uri, {
      readOnly: true,
      allowExtension: false,
      enableForeignKeyConstraints: false,
      timeout: 0,
    });
    database.exec("PRAGMA query_only=ON");
    const queryOnly = database.prepare("PRAGMA query_only").get() as
      | { query_only?: number }
      | undefined;
    if (queryOnly?.query_only !== 1) {
      throw new Error("SQLite query_only guard did not engage");
    }
    value = reader(database);
  } catch (error) {
    readError = error;
  } finally {
    try {
      database?.close();
    } catch (error) {
      readError ??= error;
    }
  }

  let after: FileIdentity | undefined;
  let verificationError: unknown;
  try {
    after = identityOf(path);
  } catch (error) {
    verificationError = error;
  }
  const sidecarsAfter = existingSidecars(path);
  if (
    verificationError !== undefined ||
    after === undefined ||
    !identitiesEqual(before, after) ||
    sidecarsAfter.length > 0
  ) {
    return {
      ok: false,
      code: "database_changed_during_probe",
      detail: "database bytes or journal state changed during read-only preflight; result discarded",
    };
  }

  if (readError !== undefined) {
    return {
      ok: false,
      code: "database_unreadable",
      detail: `database is unreadable (${readError instanceof Error ? readError.message : String(readError)})`,
    };
  }

  return { ok: true, value: value as T };
}
