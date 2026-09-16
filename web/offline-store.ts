import type { Operation } from "../src/crdt.ts";

export interface OfflineDocumentState {
  version: 1;
  documentId: string;
  actor: string;
  cursor: number;
  operations: Operation[];
  pendingOperations: Operation[];
  savedAt: string;
}

interface StoreOptions {
  databaseName?: string;
  factory?: IDBFactory;
}

const STORE_NAME = "documents";

function waitForRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function isOfflineDocumentState(value: unknown, documentId: string): value is OfflineDocumentState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<OfflineDocumentState>;
  return state.version === 1
    && state.documentId === documentId
    && typeof state.actor === "string"
    && Number.isSafeInteger(state.cursor)
    && (state.cursor ?? -1) >= 0
    && Array.isArray(state.operations)
    && Array.isArray(state.pendingOperations)
    && typeof state.savedAt === "string";
}

export class IndexedDbDocumentStore {
  private readonly databaseName: string;
  private readonly factory: IDBFactory | undefined;
  private database: Promise<IDBDatabase> | undefined;

  constructor(options: StoreOptions = {}) {
    this.factory = options.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
    this.databaseName = options.databaseName ?? "weavepad";
  }

  async load(documentId: string): Promise<OfflineDocumentState | undefined> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const completed = waitForTransaction(transaction);
    const value = await waitForRequest(transaction.objectStore(STORE_NAME).get(documentId));
    await completed;
    return isOfflineDocumentState(value, documentId) ? value : undefined;
  }

  async save(state: OfflineDocumentState): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(state);
    await waitForTransaction(transaction);
  }

  async remove(documentId: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(documentId);
    await waitForTransaction(transaction);
  }

  async close(): Promise<void> {
    if (this.database) (await this.database).close();
  }

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error("IndexedDB is unavailable"));
    if (!this.database) {
      const request = this.factory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "documentId" });
        }
      };
      this.database = waitForRequest(request);
    }
    return this.database;
  }
}
