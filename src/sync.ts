import { SequenceDocument, type Operation } from "./crdt.ts";
import {
  SqliteOperationStore,
  type CompactionReport,
  type DocumentRevision,
  type StoredOperation,
  validateDocumentId,
} from "./store.ts";

export interface SyncBatch {
  documentId: string;
  cursor: number;
  checkpoint?: {
    sequence: number;
    operations: Operation[];
  };
  operations: StoredOperation[];
}

type Subscriber = (batch: SyncBatch) => void;

interface Room {
  document: SequenceDocument;
  subscribers: Set<Subscriber>;
}

export class CollaborationHub {
  private readonly rooms = new Map<string, Room>();
  readonly store: SqliteOperationStore;

  constructor(store: SqliteOperationStore) {
    this.store = store;
  }

  sync(documentId: string, afterSequence = 0): SyncBatch {
    this.room(documentId);
    const state = this.store.state(documentId, afterSequence);
    return {
      documentId,
      cursor: state.cursor,
      checkpoint: state.checkpoint ? {
        sequence: state.checkpoint.sequence,
        operations: state.checkpoint.snapshot.operations,
      } : undefined,
      operations: state.operations,
    };
  }

  submit(documentId: string, operations: Operation[]): SyncBatch {
    if (!Array.isArray(operations) || operations.length > 1_000) {
      throw new Error("an operation batch must contain at most 1000 operations");
    }
    const room = this.room(documentId);
    const candidate = SequenceDocument.fromSnapshot("server", room.document.snapshot());
    const accepted: Operation[] = [];
    for (const operation of operations) {
      if (candidate.apply(operation)) accepted.push({ ...operation });
    }

    const stored = this.store.append(documentId, accepted);
    room.document = candidate;
    const batch = {
      documentId,
      cursor: stored.at(-1)?.sequence ?? this.latestSequence(room, documentId),
      operations: stored,
    };
    if (stored.length > 0) {
      for (const subscriber of room.subscribers) subscriber(batch);
    }
    return batch;
  }

  subscribe(documentId: string, subscriber: Subscriber): () => void {
    const room = this.room(documentId);
    room.subscribers.add(subscriber);
    return () => room.subscribers.delete(subscriber);
  }

  text(documentId: string): string {
    return this.room(documentId).document.toString();
  }

  history(documentId: string, limit = 50): DocumentRevision[] {
    return this.store.history(documentId, limit);
  }

  revisionAt(documentId: string, sequence: number): DocumentRevision | undefined {
    return this.store.revisionAt(documentId, sequence);
  }

  versionText(documentId: string, throughSequence: number): string {
    const document = new SequenceDocument("history");
    document.merge(this.store.snapshotThrough(documentId, throughSequence).operations);
    return document.toString();
  }

  compact(documentId: string, retainRevisions = 50): CompactionReport {
    this.room(documentId);
    return this.store.compact(documentId, retainRevisions);
  }

  private room(documentId: string): Room {
    validateDocumentId(documentId);
    const existing = this.rooms.get(documentId);
    if (existing) return existing;

    const state = this.store.state(documentId);
    const document = new SequenceDocument("server");
    document.merge(state.checkpoint?.snapshot.operations ?? []);
    document.merge(state.operations.map((entry) => entry.operation));
    const room = { document, subscribers: new Set<Subscriber>() };
    this.rooms.set(documentId, room);
    return room;
  }

  private latestSequence(_room: Room, documentId: string): number {
    return this.store.latestSequence(documentId);
  }
}
