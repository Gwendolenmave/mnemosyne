import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MnemosyneReadFacade,
  mnemosynePreflight,
  openMnemosyne,
} from "../adapters/memory/sqlite/mnemosyne-facade.js";
import type { MnemosyneStore } from "../adapters/memory/sqlite/mnemosyne-store.js";
import type { MemoryItemView } from "../core/services/anamnesis.js";

function card(id: string, rankText: string): MemoryItemView {
  return {
    id,
    title: "lumbar pillow support",
    body: `synthetic memory ${rankText}: lumbar pillow support for back discomfort`,
    scope: "project",
    au_id: null,
    sensitivity: "normal",
    importance: 1,
    approval_state: "confirmed",
    lifecycle_state: "active",
    seal_state: "open",
    confirmed_by: "owner",
    retrieval: "enabled",
    retrieval_explicit: 1,
    supersedes: null,
    source_basis: "explicit",
    tags_text: "lumbar pillow support",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    expires_at: null,
  };
}

function fakeFacade(items: MemoryItemView[]): MnemosyneReadFacade {
  const byId = new Map(items.map((item) => [item.id, item]));
  const fake = {
    ftsSearch: (_query: string, limit: number) =>
      items.slice(0, limit).map((item, index) => ({ itemId: item.id, rank: index + 1 })),
    getItem: (id: string) => byId.get(id),
    listItems: () => items,
    listPriors: () => [],
    listFragments: () => [],
    listSources: () => [],
  } as unknown as MnemosyneStore;
  return new MnemosyneReadFacade(fake, "synthetic.db");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("MemoryStore facade enforces the caller's smaller search limit", async () => {
  const ids = [
    "11111111-0000-4000-8000-000000000001",
    "22222222-0000-4000-8000-000000000002",
    "33333333-0000-4000-8000-000000000003",
  ];
  const facade = fakeFacade(ids.map((id, index) => card(id, `rank-${index + 1}`)));

  const one = await facade.search("lumbar pillow support", 1);
  assert.equal(one.status, "ok");
  assert.equal(
    ids.filter((id) => one.resultText.includes(`[${id.slice(0, 8)}|`)).length,
    1,
  );

  const zero = await facade.search("lumbar pillow support", 0);
  assert.equal(zero.status, "ok");
  assert.equal(
    ids.filter((id) => zero.resultText.includes(`[${id.slice(0, 8)}|`)).length,
    0,
  );
});

test("mnemosynePreflight never creates a missing database", () => {
  const root = mkdtempSync(join(tmpdir(), "mnemo-preflight-missing-"));
  const databasePath = join(root, "missing.db");
  try {
    assert.equal(existsSync(databasePath), false);
    const result = mnemosynePreflight(databasePath);
    assert.equal(result.ok, false);
    assert.match(result.detail, /preflight never creates it/u);
    assert.equal(existsSync(databasePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mnemosynePreflight validates an existing quiescent database without changing its bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "mnemo-preflight-existing-"));
  const databasePath = join(root, "mnemosyne.db");
  try {
    const handle = openMnemosyne(databasePath);
    handle.log.close();

    const before = sha256File(databasePath);
    const result = mnemosynePreflight(databasePath);
    const after = sha256File(databasePath);

    assert.equal(result.ok, true, result.detail);
    assert.match(result.detail, /ready read-only/u);
    assert.equal(after, before);
    assert.equal(existsSync(`${databasePath}-wal`), false);
    assert.equal(existsSync(`${databasePath}-shm`), false);
    assert.equal(existsSync(`${databasePath}-journal`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
