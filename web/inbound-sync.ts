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

  let cursor = advanceSyncCursor(currentCursor, message.cursor);
  if (checkpoint) cursor = advanceSyncCursor(cursor, checkpoint.sequence);
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("The sync service sent an invalid stored operation.");
    }
    cursor = advanceSyncCursor(cursor, entry.sequence);
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
