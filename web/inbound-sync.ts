import { SequenceDocument, type Operation } from "../src/crdt.ts";
import { removeAcknowledgedOperations } from "./operation-batches.ts";
import { advanceSyncCursor } from "./sync-cursor.ts";

interface StoredWireOperation {
  sequence: unknown;
  operation: Operation;
}

interface WireCheckpoint {
  sequence: unknown;
  operations: Operation[];
}

export interface AppliedInboundBatch {
  document: SequenceDocument;
  cursor: number;
  pendingOperations: Operation[];
}

export function applyInboundBatch(
  document: SequenceDocument,
  currentCursor: number,
  pendingOperations: readonly Operation[],
  message: Record<string, unknown>,
): AppliedInboundBatch {
  if (!Array.isArray(message.operations)) {
    throw new Error("The sync service sent an invalid operation batch.");
  }
  const entries = message.operations as StoredWireOperation[];
  let checkpoint: WireCheckpoint | undefined;
  if (message.checkpoint !== undefined) {
    if (!message.checkpoint || typeof message.checkpoint !== "object" ||
        Array.isArray(message.checkpoint) ||
        !Array.isArray((message.checkpoint as { operations?: unknown }).operations)) {
      throw new Error("The sync service sent an invalid checkpoint.");
    }
    checkpoint = message.checkpoint as unknown as WireCheckpoint;
  }

  const batchCursor = advanceSyncCursor(0, message.cursor);
  let cursor = advanceSyncCursor(currentCursor, batchCursor);
  let checkpointSequence: number | undefined;
  if (checkpoint) {
    checkpointSequence = advanceSyncCursor(0, checkpoint.sequence);
    if (checkpointSequence > batchCursor) {
      throw new Error("The sync service sent a checkpoint beyond the batch cursor.");
    }
    cursor = advanceSyncCursor(cursor, checkpointSequence);
  }

  let previousSequence: number | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("The sync service sent an invalid stored operation.");
    }
    const sequence = advanceSyncCursor(0, entry.sequence);
    if (checkpointSequence !== undefined && sequence <= checkpointSequence) {
      throw new Error("The sync service sent an operation at or before its checkpoint.");
    }
    if (previousSequence !== undefined && sequence <= previousSequence) {
      throw new Error("The sync service sent operations outside strict sequence order.");
    }
    previousSequence = sequence;
    cursor = advanceSyncCursor(cursor, sequence);
  }
  const finalSequence = previousSequence ?? checkpointSequence;
  if (finalSequence !== undefined && finalSequence !== batchCursor) {
    throw new Error("The sync service cursor does not match its final stored sequence.");
  }

  const candidate = SequenceDocument.fromSnapshot(document.actor, document.snapshot());
  if (checkpoint) candidate.merge(checkpoint.operations);
  for (const entry of entries) candidate.apply(entry.operation);

  const acknowledged = [
    ...(checkpoint?.operations.map((operation) => operation.id) ?? []),
    ...entries.map((entry) => entry.operation.id),
  ];
  return {
    document: candidate,
    cursor,
    pendingOperations: removeAcknowledgedOperations(pendingOperations, acknowledged),
  };
}
