import { SequenceDocument, type Operation } from "./crdt.ts";
import { SqliteOperationStore, type StoredOperation, validateDocumentId } from "./store.ts";

export interface SyncBatch {
  documentId: string;
  cursor: number;
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
    const room = this.room(documentId);
    const operations = this.store.load(documentId, afterSequence);
    return {
      documentId,
      cursor: operations.at(-1)?.sequence ?? this.latestSequence(room, documentId),
      operations,
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

  private room(documentId: string): Room {
    validateDocumentId(documentId);
    const existing = this.rooms.get(documentId);
    if (existing) return existing;

    const document = new SequenceDocument("server");
    document.merge(this.store.load(documentId).map((entry) => entry.operation));
    const room = { document, subscribers: new Set<Subscriber>() };
    this.rooms.set(documentId, room);
    return room;
  }

  private latestSequence(_room: Room, documentId: string): number {
    return this.store.load(documentId).at(-1)?.sequence ?? 0;
  }
}
