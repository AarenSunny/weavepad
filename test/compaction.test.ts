import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("checkpoint loading rejects corrupt persisted metadata", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "weavepad-checkpoint-corruption-"));
  const databasePath = join(directory, "documents.db");
  context.after(() => rm(directory, { recursive: true, force: true }));

  const store = new SqliteOperationStore(databasePath);
  const hub = new CollaborationHub(store);
  const author = new SequenceDocument("author");
  for (const value of ["A", "B", "C"]) {
    hub.submit("notes", author.localInsert(author.length, value));
  }
  hub.compact("notes", 1);
  store.close();

  const database = new DatabaseSync(databasePath);
  const valid = database.prepare(`
    SELECT snapshot, operation_count AS operationCount
    FROM document_checkpoints WHERE document_id = ?
  `).get("notes") as { snapshot: string; operationCount: number };
  database.prepare(`
    UPDATE document_checkpoints SET operation_count = operation_count + 1
    WHERE document_id = ?
  `).run("notes");
  database.close();
  const mismatched = new SqliteOperationStore(databasePath);
  assert.throws(() => mismatched.checkpoint("notes"), /corrupt checkpoint operation count/);
  mismatched.close();

  const malformedDatabase = new DatabaseSync(databasePath);
  malformedDatabase.prepare(`
    UPDATE document_checkpoints SET snapshot = ?, operation_count = 0
    WHERE document_id = ?
  `).run("{}", "notes");
  malformedDatabase.close();
  const malformed = new SqliteOperationStore(databasePath);
  assert.throws(() => malformed.checkpoint("notes"), /corrupt checkpoint snapshot envelope/);
  malformed.close();

  const invalidJsonDatabase = new DatabaseSync(databasePath);
  invalidJsonDatabase.prepare(`
    UPDATE document_checkpoints SET snapshot = ?, operation_count = ?
    WHERE document_id = ?
  `).run("{", valid.operationCount, "notes");
  invalidJsonDatabase.close();
  const invalidJson = new SqliteOperationStore(databasePath);
  assert.throws(() => invalidJson.checkpoint("notes"), /corrupt checkpoint snapshot JSON/);
  invalidJson.close();

  const invalidSequenceDatabase = new DatabaseSync(databasePath);
  invalidSequenceDatabase.prepare(`
    UPDATE document_checkpoints SET sequence = 0, snapshot = ?, operation_count = ?
    WHERE document_id = ?
  `).run(valid.snapshot, valid.operationCount, "notes");
  invalidSequenceDatabase.close();
  const invalidSequence = new SqliteOperationStore(databasePath);
  assert.throws(() => invalidSequence.checkpoint("notes"), /corrupt checkpoint sequence/);
  invalidSequence.close();
});
