import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { SequenceDocument } from "../src/crdt.ts";
import { IndexedDbDocumentStore, type OfflineDocumentState } from "../web/offline-store.ts";

test("IndexedDB restores a CRDT snapshot, cursor, actor, and offline queue", async () => {
  const store = new IndexedDbDocumentStore({ factory: new IDBFactory(), databaseName: "restore-test" });
  const document = new SequenceDocument("alice");
  const pendingOperations = document.localInsert(0, "offline ✨");
  const state: OfflineDocumentState = {
    version: 1,
    documentId: "notes",
    actor: document.actor,
    cursor: 42,
    operations: document.snapshot().operations,
    pendingOperations,
    savedAt: new Date().toISOString(),
  };

  await store.save(state);
  const restored = await store.load("notes");
  assert.deepEqual(restored, state);
  const materialized = SequenceDocument.fromSnapshot(restored!.actor, { operations: restored!.operations });
  assert.equal(materialized.toString(), "offline ✨");
  await store.close();
});

test("IndexedDB replaces checkpoints atomically and isolates documents", async () => {
  const store = new IndexedDbDocumentStore({ factory: new IDBFactory(), databaseName: "replace-test" });
  const base = {
    version: 1 as const,
    actor: "alice",
    cursor: 0,
    operations: [],
    pendingOperations: [],
    savedAt: new Date().toISOString(),
  };
  await store.save({ ...base, documentId: "one" });
  await store.save({ ...base, documentId: "two" });
  await store.save({ ...base, documentId: "one", cursor: 9 });

  assert.equal((await store.load("one"))?.cursor, 9);
  assert.equal((await store.load("two"))?.cursor, 0);
  await store.remove("one");
  assert.equal(await store.load("one"), undefined);
  await store.close();
});
