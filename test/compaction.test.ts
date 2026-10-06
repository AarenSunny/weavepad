import assert from "node:assert/strict";
import { test } from "node:test";
import { SequenceDocument, type Operation } from "../src/crdt.ts";
import { CollaborationHub } from "../src/sync.ts";
import { SqliteOperationStore } from "../src/store.ts";

test("checkpoint compaction preserves stale-client convergence, restart recovery, and retained history", () => {
  const store = new SqliteOperationStore(":memory:");
  const hub = new CollaborationHub(store);
  const author = new SequenceDocument("author");
  const staleClient = new SequenceDocument("stale");
  const firstOperations: Operation[] = [];
  let staleCursor = 0;
  let firstCursor = 0;

  for (let index = 0; index < 30; index += 1) {
    const operations = author.localInsert(author.length, String(index % 10));
    const batch = hub.submit("scale-notes", operations);
    if (index === 0) {
      firstCursor = batch.cursor;
      firstOperations.push(...operations);
    }
    if (index < 10) {
      staleClient.merge(operations);
      staleCursor = batch.cursor;
    }
  }
  const offlineOperations = staleClient.localInsert(staleClient.length, " offline");
  const textBefore = hub.text("scale-notes");

  const report = hub.compact("scale-notes", 5);
  assert.equal(report.operationRowsBefore, 30);
  assert.equal(report.operationRowsAfter, 4);
  assert.equal(report.deletedOperationRows, 26);
  assert.equal(report.checkpointOperations, 26);
  assert.equal(report.revisionsBefore, 30);
  assert.equal(report.revisionsAfter, 5);
  assert.equal(report.prunedRevisions, 25);
  assert.equal(hub.text("scale-notes"), textBefore);

  const catchUp = hub.sync("scale-notes", staleCursor);
  assert.equal(catchUp.checkpoint?.sequence, report.checkpointSequence);
  assert.equal(catchUp.operations.length, 4);
  staleClient.merge(catchUp.checkpoint!.operations);
  staleClient.merge(catchUp.operations.map((entry) => entry.operation));
  const acceptedOffline = hub.submit("scale-notes", offlineOperations);
  staleClient.merge(acceptedOffline.operations.map((entry) => entry.operation));
  assert.equal(staleClient.toString(), hub.text("scale-notes"));

  const replay = hub.submit("scale-notes", firstOperations);
  assert.deepEqual(replay.operations, []);
  assert.equal(hub.revisionAt("scale-notes", firstCursor), undefined);
  const retainedHistory = hub.history("scale-notes");
  assert.equal(retainedHistory.length, 6);
  const oldestRetained = retainedHistory.at(-1)!;
  assert.doesNotThrow(() => hub.versionText("scale-notes", oldestRetained.sequence));

  const advanced = hub.compact("scale-notes", 5);
  assert.ok(advanced.checkpointSequence > report.checkpointSequence);
  assert.equal(advanced.deletedOperationRows, 1);
  assert.equal(hub.history("scale-notes").length, 5);
  const noOp = hub.compact("scale-notes", 5);
  assert.equal(noOp.checkpointSequence, advanced.checkpointSequence);
  assert.equal(noOp.deletedOperationRows, 0);

  const restarted = new CollaborationHub(store);
  assert.equal(restarted.text("scale-notes"), hub.text("scale-notes"));
  const freshSync = restarted.sync("scale-notes", 0);
  assert.equal(freshSync.checkpoint?.sequence, advanced.checkpointSequence);
  const freshClient = new SequenceDocument("fresh");
  freshClient.merge(freshSync.checkpoint!.operations);
  freshClient.merge(freshSync.operations.map((entry) => entry.operation));
  assert.equal(freshClient.toString(), restarted.text("scale-notes"));
  store.close();
});

test("compaction validates its history window and requires a persisted revision", () => {
  const store = new SqliteOperationStore(":memory:");
  const hub = new CollaborationHub(store);
  assert.throws(() => hub.compact("empty"), /no revisions/);
  const author = new SequenceDocument("author");
  hub.submit("notes", author.localInsert(0, "A"));
  assert.throws(() => hub.compact("notes", 0), /between 1 and 100/);
  assert.throws(() => hub.compact("notes", 101), /between 1 and 100/);
  store.close();
});
