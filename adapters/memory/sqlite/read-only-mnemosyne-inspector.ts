import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  readImmutableSqlite,
  type ImmutableSqliteFailureCode,
} from "../../platform/read-only-sqlite-inspection.js";
import { MNEMOSYNE_MIGRATIONS } from "./sqlite-memory-event-log.js";

export type MnemosyneInspectionState =
  | "ready"
  | ImmutableSqliteFailureCode
  | "migration_required"
  | "schema_too_new"
  | "schema_invalid"
  | "integrity_failed";

export interface MnemosyneReadOnlyInspection {
  readonly ok: boolean;
  readonly state: MnemosyneInspectionState;
  readonly detail: string;
  readonly schemaVersion: number | null;
  readonly userVersion: number | null;
  readonly integrity: string | null;
  readonly itemCount: number | null;
  readonly priorCount: number | null;
  readonly ftsRowCount: number | null;
}

const REQUIRED_TABLES = [
  "migration_ledger",
  "meta",
  "memory_events",
  "memory_items",
  "memory_tags",
  "priors_current",
  "sources",
  "fragments",
  "fts_items",
] as const;

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  migration_ledger: ["version", "description", "applied_at", "checksum"],
  meta: ["key", "value"],
  memory_events: [
    "seq",
    "event_id",
    "subject_kind",
    "subject_id",
    "type",
    "payload",
    "occurred_at",
    "actor",
  ],
  memory_items: [
    "id",
    "title",
    "body",
    "scope",
    "au_id",
    "sensitivity",
    "importance",
    "approval_state",
    "lifecycle_state",
    "seal_state",
    "confirmed_by",
    "retrieval",
    "supersedes",
    "source_basis",
    "tags_text",
    "created_at",
    "updated_at",
    "expires_at",
    "provenance",
  ],
  memory_tags: ["memory_id", "tag"],
  priors_current: [
    "key",
    "version",
    "body",
    "token_est",
    "approved_by",
    "changelog",
    "expires_at",
  ],
  sources: ["id", "subject_kind", "subject_id", "kind", "pointer", "note"],
  fragments: ["id", "body", "created_at", "expires_at", "source_id"],
  fts_items: ["item_id", "title_seg", "body_seg", "tags_seg"],
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function base(
  state: Exclude<MnemosyneInspectionState, "ready">,
  detail: string,
  schemaVersion: number | null = null,
  userVersion: number | null = null,
  integrity: string | null = null,
): MnemosyneReadOnlyInspection {
  return {
    ok: false,
    state,
    detail,
    schemaVersion,
    userVersion,
    integrity,
    itemCount: null,
    priorCount: null,
    ftsRowCount: null,
  };
}

function userVersionOf(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function tableNames(database: DatabaseSync): Set<string> {
  return new Set(
    (
      database
        .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view')")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
}

function inspectSchema(database: DatabaseSync): MnemosyneReadOnlyInspection {
  const userVersion = userVersionOf(database);
  const tables = tableNames(database);
  const expected = [...MNEMOSYNE_MIGRATIONS].sort((left, right) => left.version - right.version);
  const supported = expected.at(-1)?.version ?? 0;

  if (!tables.has("migration_ledger")) {
    return base(
      "migration_required",
      `mnemosyne migration required (schema v0 -> v${supported}); preflight never migrates`,
      0,
      userVersion,
    );
  }

  const rows = database
    .prepare("SELECT version, checksum FROM migration_ledger ORDER BY version")
    .all() as Array<{ version: number; checksum: string }>;
  const newest = rows.at(-1)?.version ?? 0;
  if (newest > supported) {
    return base(
      "schema_too_new",
      `mnemosyne schema v${newest} is newer than supported v${supported}`,
      newest,
      userVersion,
    );
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const migration = expected[index];
    if (
      row === undefined ||
      migration === undefined ||
      row.version !== migration.version ||
      row.checksum !== sha256(migration.sql)
    ) {
      return base(
        "schema_invalid",
        "mnemosyne migration ledger is non-contiguous or has a checksum mismatch",
        newest,
        userVersion,
      );
    }
  }

  if (rows.length < expected.length) {
    return base(
      "migration_required",
      `mnemosyne migration required (schema v${newest} -> v${supported}); preflight never migrates`,
      newest,
      userVersion,
    );
  }

  const missing = REQUIRED_TABLES.filter((name) => !tables.has(name));
  if (missing.length > 0) {
    return base(
      "schema_invalid",
      `mnemosyne schema is missing required objects: ${missing.join(", ")}`,
      newest,
      userVersion,
    );
  }

  for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const actualColumns = new Set(
      (
        database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
    const missingColumns = requiredColumns.filter((column) => !actualColumns.has(column));
    if (missingColumns.length > 0) {
      return base(
        "schema_invalid",
        `mnemosyne schema is missing ${table} columns: ${missingColumns.join(", ")}`,
        newest,
        userVersion,
      );
    }
  }

  const integrity = (
    database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
  ).integrity_check;
  if (integrity !== "ok") {
    return base(
      "integrity_failed",
      `mnemosyne integrity check failed (${integrity})`,
      newest,
      userVersion,
      integrity,
    );
  }

  const itemCount = (
    database.prepare("SELECT count(*) AS count FROM memory_items").get() as { count: number }
  ).count;
  const priorCount = (
    database.prepare("SELECT count(*) AS count FROM priors_current").get() as { count: number }
  ).count;
  const ftsRowCount = (
    database.prepare("SELECT count(*) AS count FROM fts_items").get() as { count: number }
  ).count;
  database.prepare("SELECT item_id FROM fts_items WHERE fts_items MATCH ? LIMIT 1").get("preflight");

  return {
    ok: true,
    state: "ready",
    detail:
      `mnemosyne ready read-only (schema v${newest}, user_version ${userVersion}, ` +
      `${itemCount} items, ${priorCount} priors, ${ftsRowCount} fts rows)`,
    schemaVersion: newest,
    userVersion,
    integrity,
    itemCount,
    priorCount,
    ftsRowCount,
  };
}

/**
 * Inspect an existing Mnemosyne database without creating it, migrating it,
 * recovering projections, or writing journal sidecars.
 */
export function inspectMnemosyneReadOnly(path: string): MnemosyneReadOnlyInspection {
  const result = readImmutableSqlite(path, inspectSchema);
  if (!result.ok) return base(result.code, result.detail);
  return result.value;
}
