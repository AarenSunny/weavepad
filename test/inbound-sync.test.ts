import assert from "node:assert/strict";
import { test } from "node:test";
import { SequenceDocument } from "../src/crdt.ts";
import { applyInboundBatch } from "../web/inbound-sync.ts";

test("inbound sync atomically applies checkpoints and later operations", () => {
  const author = new SequenceDocument("author");
  const checkpointOperations = author.localInsert(0, "A");
  const laterOperations = author.localInsert(1, "B");
  const replica = new SequenceDocument("replica");

  const applied = applyInboundBatch(replica, 0, laterOperations, {
    cursor: 2,
    checkpoint: { sequence: 1, operations: checkpointOperations },
    operations: [{ sequence: 2, operation: laterOperations[0] }],
  });

  assert.equal(replica.toString(), "");
  assert.equal(applied.document.toString(), "AB");
  assert.equal(applied.cursor, 2);
  assert.deepEqual(applied.pendingOperations, []);
});

test("an invalid later operation cannot partially mutate the live replica", () => {
  const replica = new SequenceDocument("replica");
  replica.localInsert(0, "local");
  const before = replica.snapshot();
  const remote = new SequenceDocument("remote");
  const [valid] = remote.localInsert(0, "A");
  const invalid = { ...remote.localInsert(1, "B")[0], value: 7 };

  assert.throws(() => applyInboundBatch(replica, 4, [], {
    cursor: 6,
    operations: [
      { sequence: 5, operation: valid },
      { sequence: 6, operation: invalid },
    ],
  }), /one grapheme/);
  assert.deepEqual(replica.snapshot(), before);
  assert.equal(replica.toString(), "local");
});
