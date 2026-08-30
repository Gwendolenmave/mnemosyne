import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { MemoryEventEnvelope } from "../core/domain/memory.js";
import type { MnemosyneEnvelope, OwnerPolicyCurrent } from "../core/domain/mnemosyne.js";
import { encodeDurableSemanticCenterMergeReason } from "../core/policies/durable-semantic-center.js";
import {
  MnemosyneGovernanceService,
  type GovernanceItemView,
  type GovernanceStore,
} from "../core/services/mnemosyne-governance.js";

interface AppendBatch {
  kernel: readonly MemoryEventEnvelope[];
  governance: readonly MnemosyneEnvelope[];
}

class SyntheticGovernanceStore implements GovernanceStore {
  readonly items = new Map<string, GovernanceItemView>();
  readonly batches: AppendBatch[] = [];
  rebuildCount = 0;

  appendJoint(
    kernel: readonly MemoryEventEnvelope[],
    governance: readonly MnemosyneEnvelope[],
  ): { status: "appended"; kernel: number; governance: number } {
    this.batches.push({ kernel: [...kernel], governance: [...governance] });
    for (const envelope of kernel) {
      if (envelope.event.type !== "memory_superseded") continue;
      const item = this.items.get(envelope.event.memoryId);
      if (item !== undefined) {
        item.lifecycle_state = "superseded";
        item.supersedes = envelope.event.supersededByMemoryId;
      }
    }
    return { status: "appended", kernel: kernel.length, governance: governance.length };
  }

  async rebuildProjections(): Promise<{ items: number; priors: number }> {
    this.rebuildCount += 1;
    return { items: this.items.size, priors: 0 };
  }

  getItem(id: string): GovernanceItemView | undefined {
    return this.items.get(id);
  }

  listItems(): GovernanceItemView[] {
    return [...this.items.values()];
  }

  ftsSearch(): Array<{ itemId: string; rank: number }> {
    return [];
  }

  listSources(): Array<{ kind: string; pointer: string }> {
    return [];
  }

  currentPolicies(): Map<string, OwnerPolicyCurrent> {
    return new Map();
  }
}

function card(
  id: string = randomUUID(),
  overrides: Partial<GovernanceItemView> = {},
): GovernanceItemView {
  return {
    id,
    title: `Synthetic card ${id.slice(0, 6)}`,
    body: "Synthetic governed memory body.",
    scope: "global",
    au_id: null,
    sensitivity: "normal",
    importance: 2,
    approval_state: "policy_activated",
    lifecycle_state: "active",
    confirmed_by: null,
    retrieval: "enabled",
    supersedes: null,
    source_basis: "explicit",
    tags_text: "synthetic governed",
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    provenance: JSON.stringify({ source_basis: "explicit" }),
    ...overrides,
  };
}

function service(store: SyntheticGovernanceStore, backupCalls: string[], audit: Record<string, unknown>[]) {
  return new MnemosyneGovernanceService({
    store,
    backup: (label) => {
      backupCalls.push(label);
      return { path: `synthetic/${label}.backup` };
    },
    audit: (event) => audit.push(event),
    now: () => new Date("2026-08-26T00:00:00.000Z"),
  });
}

test("policy-activated cards cannot use the pending-card edit bypass", async () => {
  const store = new SyntheticGovernanceStore();
  const item = card();
  store.items.set(item.id, item);
  const backups: string[] = [];
  const audit: Record<string, unknown>[] = [];
  const governance = service(store, backups, audit);

  const outcome = await governance.editPending(
    item.id,
    "Replacement that must not use the pending path.",
    "owner",
  );

  assert.equal(outcome.status, "refused");
  if (outcome.status === "refused") {
    assert.match(outcome.issues[0]?.message ?? "", /policy-activated/i);
  }
  assert.equal(store.batches.length, 0);
  assert.equal(store.rebuildCount, 0);
  assert.equal(backups.length, 0);
  assert.equal(audit.length, 0);
});

test("supersede consolidation commits planner events through the single governance writer", async () => {
  const store = new SyntheticGovernanceStore();
  const source = card();
  const survivor = card();
  store.items.set(source.id, source);
  store.items.set(survivor.id, survivor);
  const backups: string[] = [];
  const audit: Record<string, unknown>[] = [];
  const governance = service(store, backups, audit);

  const first = await governance.supersedePolicyActivated(
    source.id,
    survivor.id,
    "owner",
    "Synthetic duplicate consolidated after reviewed evidence.",
  );
  assert.equal(first.status, "ok");
  assert.equal(store.batches.length, 1);
  assert.equal(store.batches[0]?.kernel.length, 1);
  assert.equal(store.batches[0]?.governance.length, 1);
  assert.equal(store.batches[0]?.kernel[0]?.event.type, "memory_superseded");
  assert.equal(store.batches[0]?.governance[0]?.event.type, "provenance_set");
  assert.equal(store.batches[0]?.governance[0]?.actor, "owner");
  assert.equal(store.rebuildCount, 1);
  assert.deepEqual(backups, ["supersede_policy_activated"]);
  assert.equal(store.items.get(source.id)?.lifecycle_state, "superseded");
  assert.equal(store.items.get(source.id)?.supersedes, survivor.id);

  const replay = await governance.supersedePolicyActivated(
    source.id,
    survivor.id,
    "owner",
    "Same exact consolidation replay.",
  );
  assert.equal(replay.status, "already");
  assert.equal(store.batches.length, 1);
  assert.equal(store.rebuildCount, 1);
  assert.deepEqual(backups, ["supersede_policy_activated"]);
});

test("merge consolidation requires semantic-center proof, then commits once with exact replay zero-write", async () => {
  const store = new SyntheticGovernanceStore();
  const sourceA = card();
  const sourceB = card(randomUUID(), { source_basis: "observed", provenance: JSON.stringify({ source_basis: "observed" }) });
  const survivor = card(randomUUID(), {
    approval_state: "confirmed",
    confirmed_by: "owner",
  });
  for (const item of [sourceA, sourceB, survivor]) store.items.set(item.id, item);
  const backups: string[] = [];
  const audit: Record<string, unknown>[] = [];
  const governance = service(store, backups, audit);

  const refused = await governance.mergePolicyActivated(
    [sourceA.id, sourceB.id],
    survivor.id,
    "companion",
    "Synthetic records share a broad preference category.",
  );
  assert.equal(refused.status, "refused");
  if (refused.status === "refused") {
    assert.equal(refused.issues.some((issue) => issue.path === "mergeSemanticRelation"), true);
  }
  assert.equal(store.batches.length, 0);
  assert.equal(store.rebuildCount, 0);
  assert.equal(backups.length, 0);
  assert.equal(audit.length, 0);

  const reason = encodeDurableSemanticCenterMergeReason(
    "duplicate",
    "synthetic records are duplicate statements of one durable memory",
  );
  const first = await governance.mergePolicyActivated(
    [sourceA.id, sourceB.id],
    survivor.id,
    "companion",
    reason,
  );
  assert.equal(first.status, "ok");
  assert.equal(store.batches.length, 1);
  assert.equal(store.batches[0]?.kernel.length, 2);
  assert.equal(store.batches[0]?.governance.length, 2);
  assert.equal(store.batches[0]?.kernel.every((event) => event.event.type === "memory_superseded"), true);
  assert.equal(store.batches[0]?.governance.every((event) => event.event.type === "provenance_set"), true);
  assert.equal(store.batches[0]?.governance.every((event) => event.actor === "companion"), true);
  assert.equal(store.rebuildCount, 1);
  assert.deepEqual(backups, ["merge_policy_activated"]);

  const replay = await governance.mergePolicyActivated(
    [sourceA.id, sourceB.id],
    survivor.id,
    "companion",
    reason,
  );
  assert.equal(replay.status, "already");
  assert.equal(store.batches.length, 1);
  assert.equal(store.rebuildCount, 1);
  assert.deepEqual(backups, ["merge_policy_activated"]);
});
