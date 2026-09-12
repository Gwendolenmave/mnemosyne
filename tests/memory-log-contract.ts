import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { foldMemoryEvents } from "../core/domain/memory-fold.js";
import type { MemoryEventEnvelope } from "../core/domain/memory.js";
import type { MemoryEventLog } from "../core/ports/memory-event-log.js";

export const uuid = (): string => randomUUID();

export function cloneTestValue<T>(value: T): T {
  return structuredClone(value);
}

function userStatement(): Record<string, unknown> {
  return {
    kind: "user_statement",
    source: {
      kind: "conversation_message",
      conversationId: uuid(),
      turnId: uuid(),
      messageId: uuid(),
      role: "user",
    },
  };
}

export function created(memoryId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "memory_created",
    memoryId,
    content: "Owner likes jasmine tea",
    evidence: userStatement(),
    scope: { kind: "shared" },
    ...overrides,
  };
}

export function revised(memoryId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "memory_revised",
    memoryId,
    revisionId: uuid(),
    revisionKind: "correction",
    content: "Owner prefers oolong tea",
    evidence: userStatement(),
    scope: { kind: "shared" },
    ...overrides,
  };
}

export function superseded(memoryId: string, supersededByMemoryId: string): Record<string, unknown> {
  return { type: "memory_superseded", memoryId, supersededByMemoryId, reason: "duplicate" };
}

export function env(
  event: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): MemoryEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: uuid(),
    occurredAt: "2026-07-04T10:00:00.000Z",
    event,
    ...overrides,
  } as unknown as MemoryEventEnvelope;
}

export function eventObject(envelope: MemoryEventEnvelope): Record<string, unknown> {
  return envelope.event as unknown as Record<string, unknown>;
}

export function uncloneableInvalidEnvelope(): MemoryEventEnvelope {
  return { nonsense: () => "not cloneable" } as unknown as MemoryEventEnvelope;
}

export async function expectAppended(log: MemoryEventLog, envelopes: MemoryEventEnvelope[]): Promise<void> {
  const outcome = await log.append(envelopes);
  assert.equal(
    outcome.status,
    "appended",
    `expected append to succeed, got: ${outcome.status === "rejected" ? JSON.stringify(outcome.issues) : ""}`,
  );
  if (outcome.status === "appended") {
    assert.equal(outcome.count, envelopes.length);
  }
}

/**
 * Port contract suite: every MemoryEventLog implementation must pass
 * these against a factory producing a fresh, empty log.
 */
export function memoryEventLogContract(implementationName: string, makeLog: () => MemoryEventLog): void {
  const t = (name: string, fn: () => Promise<void>): void => {
    test(`${implementationName}: ${name}`, fn);
  };

  t("a fresh log reads back as an empty stream", async () => {
    assert.deepEqual(await makeLog().readAll(), []);
  });

  t("appended envelopes read back complete and in append order", async () => {
    const log = makeLog();
    const first = env(created(uuid()));
    const second = env(created(uuid()));
    await expectAppended(log, [first]);
    await expectAppended(log, [second]);
    assert.deepEqual(await log.readAll(), [first, second]);
  });

  t("a batch preserves its internal order", async () => {
    const log = makeLog();
    const m = uuid();
    const batch = [env(created(m)), env(revised(m)), env(created(uuid()))];
    await expectAppended(log, batch);
    assert.deepEqual(await log.readAll(), batch);
  });

  t("appendToEmpty imports a complete stream only when the log is empty", async () => {
    const log = makeLog();
    const m = uuid();
    const batch = [env(created(m)), env(revised(m)), env(created(uuid()))];
    const outcome = await log.appendToEmpty(batch);
    assert.equal(outcome.status, "appended");
    if (outcome.status === "appended") {
      assert.equal(outcome.count, batch.length);
    }
    assert.deepEqual(await log.readAll(), batch);
  });

  t("appendToEmpty rejects invalid streams without changing the log", async () => {
    const log = makeLog();
    const outcome = await log.appendToEmpty([env(revised(uuid()))]);
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") {
      assert.ok(outcome.issues.length > 0);
    }
    assert.deepEqual(await log.readAll(), []);

    const uncloneable = await log.appendToEmpty([uncloneableInvalidEnvelope()]);
    assert.equal(uncloneable.status, "rejected");
    assert.deepEqual(await log.readAll(), []);
  });

  t("appendToEmpty reports not-empty without changing existing state", async () => {
    const log = makeLog();
    const existing = [env(created(uuid()))];
    await expectAppended(log, existing);
    const before = await log.readAll();
    const outcome = await log.appendToEmpty([env(created(uuid()))]);
    assert.equal(outcome.status, "not-empty");
    if (outcome.status === "not-empty") {
      assert.equal(outcome.existingCount, existing.length);
    }
    assert.deepEqual(await log.readAll(), before);
  });

  t("two concurrent appendToEmpty calls on one instance cannot both succeed", async () => {
    const log = makeLog();
    const first = [env(created(uuid(), { content: "first import" }))];
    const second = [env(created(uuid(), { content: "second import" }))];
    const [firstOutcome, secondOutcome] = await Promise.all([
      log.appendToEmpty(first),
      log.appendToEmpty(second),
    ]);
    assert.deepEqual(
      [firstOutcome.status, secondOutcome.status].sort(),
      ["appended", "not-empty"],
    );
    const stored = await log.readAll();
    assert.equal(stored.length, 1);
    assert.ok(
      eventObject(stored[0]!)["content"] === "first import" ||
        eventObject(stored[0]!)["content"] === "second import",
    );
  });

  t("ordinary append racing ahead of appendToEmpty prevents a mixed import", async () => {
    const log = makeLog();
    const ordinary = [env(created(uuid(), { content: "ordinary append" }))];
    const imported = [env(created(uuid(), { content: "atomic import" }))];
    const appendPromise = log.append(ordinary);
    const importPromise = log.appendToEmpty(imported);
    const [appendOutcome, importOutcome] = await Promise.all([appendPromise, importPromise]);
    assert.equal(appendOutcome.status, "appended");
    assert.equal(importOutcome.status, "not-empty");
    assert.deepEqual(await log.readAll(), ordinary);
  });

  t("mutating appendToEmpty input after import does not affect the log", async () => {
    const log = makeLog();
    const batch = [env(created(uuid()))];
    const outcome = await log.appendToEmpty(batch);
    assert.equal(outcome.status, "appended");
    eventObject(batch[0]!)["content"] = "mutated after appendToEmpty";
    assert.equal(eventObject((await log.readAll())[0]!)["content"], "Owner likes jasmine tea");
  });

  t("a schema-invalid envelope is rejected with issues and the log is unchanged", async () => {
    const log = makeLog();
    const outcome = await log.append([{ nonsense: true } as unknown as MemoryEventEnvelope]);
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") {
      assert.ok(outcome.issues.length > 0);
    }
    assert.deepEqual(await log.readAll(), []);
  });

  t("an uncloneable schema-invalid envelope is rejected with issues and the log is unchanged", async () => {
    const log = makeLog();
    const outcome = await log.append([uncloneableInvalidEnvelope()]);
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") {
      assert.ok(outcome.issues.some((issue) => issue.path === "$[0].nonsense"));
    }
    assert.deepEqual(await log.readAll(), []);
  });

  t("appends are validated against the EXISTING stream, not just the batch", async () => {
    const log = makeLog();
    const m1 = uuid();
    const m2 = uuid();
    await expectAppended(log, [env(created(m1))]);
    await expectAppended(log, [env(created(m2))]);
    await expectAppended(log, [env(superseded(m2, m1))]);
    const outcome = await log.append([env(revised(m2))]);
    assert.equal(outcome.status, "rejected");
    assert.equal((await log.readAll()).length, 3);
  });

  t("a duplicate eventId across appends is rejected", async () => {
    const log = makeLog();
    const sharedEventId = uuid();
    await expectAppended(log, [env(created(uuid()), { eventId: sharedEventId })]);
    const outcome = await log.append([env(created(uuid()), { eventId: sharedEventId })]);
    assert.equal(outcome.status, "rejected");
    assert.equal((await log.readAll()).length, 1);
  });

  t("append is all-or-nothing: one invalid envelope rejects the whole batch", async () => {
    const log = makeLog();
    const outcome = await log.append([env(created(uuid())), env(revised(uuid()))]);
    assert.equal(outcome.status, "rejected");
    assert.deepEqual(await log.readAll(), []);
  });

  t("readAll returns a defensive copy of the stream", async () => {
    const log = makeLog();
    await expectAppended(log, [env(created(uuid()))]);
    const first = await log.readAll();
    first.length = 0;
    assert.equal((await log.readAll()).length, 1);
  });

  t("readAll returns defensive copies of nested envelopes", async () => {
    const log = makeLog();
    await expectAppended(log, [env(created(uuid()))]);
    const first = await log.readAll();
    eventObject(first[0]!)["content"] = "mutated through readAll";
    assert.equal(eventObject((await log.readAll())[0]!)["content"], "Owner likes jasmine tea");
  });

  t("mutating appended input after append does not affect the log", async () => {
    const log = makeLog();
    const envelope = env(created(uuid()));
    await expectAppended(log, [envelope]);
    eventObject(envelope)["content"] = "mutated after append";
    assert.equal(eventObject((await log.readAll())[0]!)["content"], "Owner likes jasmine tea");
  });

  t("rejected append performs zero writes and leaves prior nested state unchanged", async () => {
    const log = makeLog();
    const m = uuid();
    const committed = env(created(m));
    await expectAppended(log, [committed]);
    const before = await log.readAll();
    const outcome = await log.append([env(revised(uuid()))]);
    assert.equal(outcome.status, "rejected");
    assert.deepEqual(await log.readAll(), before);
  });

  t("folding readAll yields the expected current view and full history", async () => {
    const log = makeLog();
    const m1 = uuid();
    const m2 = uuid();
    await expectAppended(log, [env(created(m1, { content: "duplicate" })), env(created(m2))]);
    await expectAppended(log, [
      env(superseded(m1, m2)),
      env(revised(m2, { content: "Owner prefers oolong tea" })),
    ]);
    const state = foldMemoryEvents(await log.readAll());
    assert.deepEqual(
      state.current.map((r) => r.memoryId),
      [m2],
    );
    assert.equal(state.current[0]!.content, "Owner prefers oolong tea");
    const replaced = state.records.find((r) => r.memoryId === m1)!;
    assert.equal(replaced.lifecycle, "superseded");
    assert.equal(replaced.supersededByMemoryId, m2);
    assert.equal(replaced.history.length, 2);
  });
}
