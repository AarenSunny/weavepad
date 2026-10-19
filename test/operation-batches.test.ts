import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_ID, type Operation } from "../src/crdt.ts";
import { MAX_OPERATIONS_PER_MESSAGE } from "../src/protocol.ts";
import { operationBatches, removeAcknowledgedOperations } from "../web/operation-batches.ts";

function operations(count: number): Operation[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "insert",
    id: `batcher:${index + 1}`,
    actor: "batcher",
    counter: index + 1,
    after: index === 0 ? ROOT_ID : `batcher:${index}`,
    value: "x",
  }));
}

test("operation batches honor the wire limit without reordering operations", () => {
  const pending = operations((MAX_OPERATIONS_PER_MESSAGE * 2) + 1);
  const batches = operationBatches(pending);

  assert.deepEqual(batches.map((batch) => batch.length), [1_000, 1_000, 1]);
  assert.deepEqual(batches.flat().map((operation) => operation.id), pending.map((operation) => operation.id));
});

test("operation batches are snapshots and do not mutate the pending queue", () => {
  const pending = operations(MAX_OPERATIONS_PER_MESSAGE + 1);
  const batches = operationBatches(pending);

  batches[0].pop();
  assert.equal(pending.length, MAX_OPERATIONS_PER_MESSAGE + 1);
  assert.equal(operationBatches([]).length, 0);
});

test("acknowledgements remove only matching pending operation IDs", () => {
  const pending = operations(4);
  const remaining = removeAcknowledgedOperations(pending, [pending[1].id, pending[3].id]);

  assert.deepEqual(remaining.map((operation) => operation.id), [pending[0].id, pending[2].id]);
  assert.equal(pending.length, 4);
});
