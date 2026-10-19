import type { Operation } from "../src/crdt.ts";
import { MAX_OPERATIONS_PER_MESSAGE } from "../src/protocol.ts";

export function operationBatches(operations: readonly Operation[]): Operation[][] {
  const batches: Operation[][] = [];
  for (let start = 0; start < operations.length; start += MAX_OPERATIONS_PER_MESSAGE) {
    batches.push(operations.slice(start, start + MAX_OPERATIONS_PER_MESSAGE));
  }
  return batches;
}

export function removeAcknowledgedOperations(
  operations: readonly Operation[],
  acknowledgedIds: Iterable<string>,
): Operation[] {
  const acknowledged = new Set(acknowledgedIds);
  return operations.filter((operation) => !acknowledged.has(operation.id));
}
