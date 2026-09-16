import { DatabaseSync } from "node:sqlite";
import type { Operation } from "./crdt.ts";

export interface StoredOperation {
  sequence: number;
  operation: Operation;
}

export interface DocumentRevision {
  revision: number;
  sequence: number;
  operationCount: number;
  actors: string[];
  createdAt: string;
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
      CREATE TABLE IF NOT EXISTS revisions (
        document_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        operation_count INTEGER NOT NULL,
        actors TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY(document_id, revision),
        UNIQUE(document_id, sequence)
      );
    `);
  }

  loadThrough(documentId: string, throughSequence: number): StoredOperation[] {
    validateDocumentId(documentId);
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new Error("version cursor must be a non-negative integer");
    }
    const rows = this.database.prepare(`
      SELECT sequence, payload
      FROM operations
      WHERE document_id = ? AND sequence <= ?
      ORDER BY sequence ASC
    `).all(documentId, throughSequence) as Array<{ sequence: number; payload: string }>;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      operation: JSON.parse(row.payload) as Operation,
    }));
  }

  history(documentId: string, limit = 50): DocumentRevision[] {
    validateDocumentId(documentId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("history limit must be between 1 and 100");
    }
    const rows = this.database.prepare(`
      SELECT revision, sequence, operation_count, actors, created_at
      FROM revisions
      WHERE document_id = ?
      ORDER BY revision DESC
      LIMIT ?
    `).all(documentId, limit) as Array<{
      revision: number;
      sequence: number;
      operation_count: number;
      actors: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      revision: Number(row.revision),
      sequence: Number(row.sequence),
      operationCount: Number(row.operation_count),
      actors: JSON.parse(row.actors) as string[],
      createdAt: row.created_at,
    }));
  }

  revisionAt(documentId: string, sequence: number): DocumentRevision | undefined {
    validateDocumentId(documentId);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("revision sequence must be a positive integer");
    }
    const row = this.database.prepare(`
      SELECT revision, sequence, operation_count, actors, created_at
      FROM revisions
      WHERE document_id = ? AND sequence = ?
    `).get(documentId, sequence) as {
      revision: number;
      sequence: number;
      operation_count: number;
      actors: string;
      created_at: string;
    } | undefined;
    return row ? {
      revision: Number(row.revision),
      sequence: Number(row.sequence),
      operationCount: Number(row.operation_count),
      actors: JSON.parse(row.actors) as string[],
      createdAt: row.created_at,
    } : undefined;
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
    const nextRevision = this.database.prepare(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS revision
      FROM revisions
      WHERE document_id = ?
    `);
    const insertRevision = this.database.prepare(`
      INSERT INTO revisions(document_id, revision, sequence, operation_count, actors)
      VALUES (?, ?, ?, ?, ?)
    `);

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
      if (stored.length > 0) {
        const row = nextRevision.get(documentId) as { revision: number };
        const actors = Array.from(new Set(stored.map((entry) => entry.operation.actor))).sort();
        insertRevision.run(
          documentId,
          Number(row.revision),
          stored.at(-1)!.sequence,
          stored.length,
          JSON.stringify(actors),
        );
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
