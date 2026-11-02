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
    cursor: 3,
    checkpoint: { sequence: 1, operations: checkpointOperations },
    operations: [{ sequence: 3, operation: laterOperations[0] }],
  });

  assert.equal(replica.toString(), "");
  assert.equal(applied.document.toString(), "AB");
  assert.equal(applied.cursor, 3);
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

test("inbound sync rejects inconsistent sequence envelopes atomically", () => {
  const replica = new SequenceDocument("replica");
  replica.localInsert(0, "local");
  const before = replica.snapshot();
  const remote = new SequenceDocument("remote");
  const [first] = remote.localInsert(0, "A");
  const [second] = remote.localInsert(1, "B");

  const invalidBatches = [
    {
      message: { cursor: 1, checkpoint: { sequence: 2, operations: [first] }, operations: [] },
      error: /checkpoint beyond the batch cursor/,
    },
    {
      message: {
        cursor: 2,
        checkpoint: { sequence: 1, operations: [first] },
        operations: [{ sequence: 1, operation: second }],
      },
      error: /operation at or before its checkpoint/,
    },
    {
      message: {
        cursor: 2,
        operations: [
          { sequence: 2, operation: first },
          { sequence: 2, operation: second },
        ],
      },
      error: /outside strict sequence order/,
    },
    {
      message: { cursor: 3, operations: [{ sequence: 2, operation: first }] },
      error: /cursor does not match its final stored sequence/,
    },
  ];

  for (const { message, error } of invalidBatches) {
    assert.throws(() => applyInboundBatch(replica, 0, [], message), error);
    assert.deepEqual(replica.snapshot(), before);
  }
});
