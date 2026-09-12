import { DatabaseSync } from "node:sqlite";
import type { Operation } from "./crdt.ts";

export interface StoredOperation {
  sequence: number;
  operation: Operation;
}

const DOCUMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function validateDocumentId(documentId: string): void {
  if (!DOCUMENT_PATTERN.test(documentId)) {
    throw new Error("document id must contain 1-128 letters, numbers, underscores, or hyphens");
  }
}

export class SqliteOperationStore {
  private readonly database: DatabaseSync;

  constructor(path = "weavepad.db") {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS operations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(document_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS operations_document_sequence
        ON operations(document_id, sequence);
    `);
  }

  load(documentId: string, afterSequence = 0): StoredOperation[] {
    validateDocumentId(documentId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("sync cursor must be a non-negative integer");
    }
    const rows = this.database.prepare(`
      SELECT sequence, payload
      FROM operations
      WHERE document_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(documentId, afterSequence) as Array<{ sequence: number; payload: string }>;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      operation: JSON.parse(row.payload) as Operation,
    }));
  }

  append(documentId: string, operations: Operation[]): StoredOperation[] {
    validateDocumentId(documentId);
    if (operations.length === 0) return [];

    const insert = this.database.prepare(`
      INSERT INTO operations(document_id, operation_id, payload)
      VALUES (?, ?, ?)
      ON CONFLICT(document_id, operation_id) DO NOTHING
    `);
    const find = this.database.prepare(`
      SELECT sequence, payload
      FROM operations
      WHERE document_id = ? AND operation_id = ?
    `);
    const stored: StoredOperation[] = [];

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const operation of operations) {
        const payload = JSON.stringify(operation);
        const result = insert.run(documentId, operation.id, payload);
        const row = find.get(documentId, operation.id) as { sequence: number; payload: string };
        if (row.payload !== payload) {
          throw new Error(`conflicting stored operation payload for ${operation.id}`);
        }
        if (Number(result.changes) === 1) {
          stored.push({ sequence: Number(row.sequence), operation: { ...operation } });
        }
      }
      this.database.exec("COMMIT");
      return stored;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
