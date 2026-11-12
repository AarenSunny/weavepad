import { DatabaseSync } from "node:sqlite";
import { SequenceDocument, type DocumentSnapshot, type Operation } from "./crdt.ts";

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

export interface StoredCheckpoint {
  sequence: number;
  snapshot: DocumentSnapshot;
  operationCount: number;
  createdAt: string;
}

export interface StoredDocumentState {
  checkpoint?: StoredCheckpoint;
  operations: StoredOperation[];
  cursor: number;
}

export interface CompactionReport {
  documentId: string;
  checkpointSequence: number;
  checkpointOperations: number;
  operationRowsBefore: number;
  operationRowsAfter: number;
  revisionsBefore: number;
  revisionsAfter: number;
  payloadBytesBefore: number;
  payloadBytesAfter: number;
  deletedOperationRows: number;
  prunedRevisions: number;
}

const DOCUMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ACTOR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface RevisionRow {
  revision: number;
  sequence: number;
  operation_count: number;
  actors: string;
  created_at: string;
  source_exists: number;
}

interface OperationRow {
  sequence: number;
  operation_id: string;
  payload: string;
}

function decodeStoredOperation(row: OperationRow): StoredOperation {
  const sequence = Number(row.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("corrupt stored operation sequence");
  }
  let operation: unknown;
  try {
    operation = JSON.parse(row.payload);
  } catch {
    throw new Error("corrupt stored operation JSON");
  }
  try {
    SequenceDocument.fromSnapshot("stored-operation", {
      operations: [operation as Operation],
    });
  } catch {
    throw new Error("corrupt stored operation set");
  }
  if ((operation as Operation).id !== row.operation_id) {
    throw new Error("corrupt stored operation identity");
  }
  return { sequence, operation: operation as Operation };
}

function decodeRevision(row: RevisionRow): DocumentRevision {
  const revision = Number(row.revision);
  const sequence = Number(row.sequence);
  const operationCount = Number(row.operation_count);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("corrupt revision number");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1 || Number(row.source_exists) !== 1) {
    throw new Error("corrupt revision sequence");
  }
  if (!Number.isSafeInteger(operationCount) || operationCount < 1) {
    throw new Error("corrupt revision operation count");
  }
  let actors: unknown;
  try {
    actors = JSON.parse(row.actors);
  } catch {
    throw new Error("corrupt revision actors JSON");
  }
  if (!Array.isArray(actors) || actors.length === 0 ||
      actors.some((actor) => typeof actor !== "string" || !ACTOR_PATTERN.test(actor))) {
    throw new Error("corrupt revision actor set");
  }
  const canonicalActors = Array.from(new Set(actors)).sort();
  if (canonicalActors.length !== actors.length ||
      canonicalActors.some((actor, index) => actor !== actors[index])) {
    throw new Error("corrupt revision actor set");
  }
  if (typeof row.created_at !== "string" || row.created_at.length === 0) {
    throw new Error("corrupt revision timestamp");
  }
  return { revision, sequence, operationCount, actors: canonicalActors, createdAt: row.created_at };
}

function checkpointSnapshot(payload: string, operationCount: number): DocumentSnapshot {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(payload);
  } catch {
    throw new Error("corrupt checkpoint snapshot JSON");
  }
  if (!snapshot || typeof snapshot !== "object" ||
      !Array.isArray((snapshot as { operations?: unknown }).operations)) {
    throw new Error("corrupt checkpoint snapshot envelope");
  }
  const operations = (snapshot as DocumentSnapshot).operations;
  if (operations.length !== operationCount) {
    throw new Error("corrupt checkpoint operation count");
  }
  try {
    const document = SequenceDocument.fromSnapshot("checkpoint", { operations });
    if (document.exportOperations().length !== operations.length) {
      throw new Error("duplicate checkpoint operation");
    }
  } catch {
    throw new Error("corrupt checkpoint operation set");
  }
  return { operations };
}

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
      CREATE TABLE IF NOT EXISTS document_checkpoints (
        document_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        operation_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
  }

  snapshotThrough(documentId: string, throughSequence: number): DocumentSnapshot {
    validateDocumentId(documentId);
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new Error("version cursor must be a non-negative integer");
    }
    this.operationSequenceMaximum(documentId);
    const checkpoint = this.checkpoint(documentId);
    if (checkpoint && throughSequence < checkpoint.sequence) {
      throw new Error("version predates the retained checkpoint");
    }
    const rows = this.database.prepare(`
      SELECT sequence, operation_id, payload
      FROM operations
      WHERE document_id = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence ASC
    `).all(documentId, checkpoint?.sequence ?? 0, throughSequence) as unknown as OperationRow[];
    const snapshot = {
      operations: [
        ...(checkpoint?.snapshot.operations ?? []),
        ...rows.map((row) => decodeStoredOperation(row).operation),
      ],
    };
    try {
      SequenceDocument.fromSnapshot("stored-operations", snapshot);
    } catch {
      throw new Error("corrupt stored operation set");
    }
    return snapshot;
  }

  history(documentId: string, limit = 50): DocumentRevision[] {
    validateDocumentId(documentId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("history limit must be between 1 and 100");
    }
    const rows = this.database.prepare(`
      SELECT revision, sequence, operation_count, actors, created_at,
        (EXISTS(
          SELECT 1 FROM operations
          WHERE document_id = revisions.document_id AND sequence = revisions.sequence
        ) OR EXISTS(
          SELECT 1 FROM document_checkpoints
          WHERE document_id = revisions.document_id AND sequence = revisions.sequence
        )) AS source_exists
      FROM revisions WHERE document_id = ?
      ORDER BY revision DESC
      LIMIT ?
    `).all(documentId, limit) as unknown as RevisionRow[];
    return rows.map(decodeRevision);
  }

  revisionAt(documentId: string, sequence: number): DocumentRevision | undefined {
    validateDocumentId(documentId);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("revision sequence must be a positive integer");
    }
    const row = this.database.prepare(`
      SELECT revision, sequence, operation_count, actors, created_at,
        (EXISTS(
          SELECT 1 FROM operations
          WHERE document_id = revisions.document_id AND sequence = revisions.sequence
        ) OR EXISTS(
          SELECT 1 FROM document_checkpoints
          WHERE document_id = revisions.document_id AND sequence = revisions.sequence
        )) AS source_exists
      FROM revisions WHERE document_id = ? AND sequence = ?
    `).get(documentId, sequence) as unknown as RevisionRow | undefined;
    return row ? decodeRevision(row) : undefined;
  }

  load(documentId: string, afterSequence = 0): StoredOperation[] {
    validateDocumentId(documentId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("sync cursor must be a non-negative integer");
    }
    this.operationSequenceMaximum(documentId);
    const rows = this.database.prepare(`
      SELECT sequence, operation_id, payload
      FROM operations
      WHERE document_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(documentId, afterSequence) as unknown as OperationRow[];
    return rows.map(decodeStoredOperation);
  }

  state(documentId: string, afterSequence = 0): StoredDocumentState {
    validateDocumentId(documentId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("sync cursor must be a non-negative integer");
    }
    const storedCheckpoint = this.checkpoint(documentId);
    const checkpoint = storedCheckpoint && afterSequence < storedCheckpoint.sequence
      ? storedCheckpoint
      : undefined;
    const operations = this.load(documentId, checkpoint?.sequence ?? afterSequence);
    return {
      checkpoint,
      operations,
      cursor: operations.at(-1)?.sequence ?? this.latestSequence(documentId),
    };
  }

  checkpoint(documentId: string): StoredCheckpoint | undefined {
    validateDocumentId(documentId);
    const row = this.database.prepare(`
      SELECT sequence, snapshot, operation_count, created_at
      FROM document_checkpoints
      WHERE document_id = ?
    `).get(documentId) as {
      sequence: number;
      snapshot: string;
      operation_count: number;
      created_at: string;
    } | undefined;
    if (!row) return undefined;
    const sequence = Number(row.sequence);
    const operationCount = Number(row.operation_count);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("corrupt checkpoint sequence");
    }
    if (!Number.isSafeInteger(operationCount) || operationCount < 0) {
      throw new Error("corrupt checkpoint operation count");
    }
    return {
      sequence,
      snapshot: checkpointSnapshot(row.snapshot, operationCount),
      operationCount,
      createdAt: row.created_at,
    };
  }

  latestSequence(documentId: string): number {
    validateDocumentId(documentId);
    return Math.max(
      this.operationSequenceMaximum(documentId),
      this.checkpoint(documentId)?.sequence ?? 0,
    );
  }

  compact(documentId: string, retainRevisions = 50): CompactionReport {
    validateDocumentId(documentId);
    if (!Number.isSafeInteger(retainRevisions) || retainRevisions < 1 || retainRevisions > 100) {
      throw new Error("retained revision count must be between 1 and 100");
    }
    const retained = this.history(documentId, retainRevisions);
    if (retained.length === 0) throw new Error("document has no revisions to compact");
    const checkpointSequence = retained.at(-1)!.sequence;
    const previousCheckpoint = this.checkpoint(documentId);
    if (previousCheckpoint && checkpointSequence <= previousCheckpoint.sequence) {
      return this.compactionReport(documentId, previousCheckpoint, 0, 0);
    }

    const snapshot = this.snapshotThrough(documentId, checkpointSequence);
    const operationRowsBefore = this.countRows("operations", documentId);
    const revisionsBefore = this.countRows("revisions", documentId);
    const payloadBytesBefore = this.payloadBytes(documentId);
    let deletedOperationRows = 0;
    let prunedRevisions = 0;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO document_checkpoints (
          document_id, sequence, snapshot, operation_count, created_at
        ) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(document_id) DO UPDATE SET
          sequence = excluded.sequence,
          snapshot = excluded.snapshot,
          operation_count = excluded.operation_count,
          created_at = excluded.created_at
      `).run(documentId, checkpointSequence, JSON.stringify(snapshot), snapshot.operations.length);
      deletedOperationRows = Number(this.database.prepare(`
        DELETE FROM operations WHERE document_id = ? AND sequence <= ?
      `).run(documentId, checkpointSequence).changes);
      prunedRevisions = Number(this.database.prepare(`
        DELETE FROM revisions WHERE document_id = ? AND sequence < ?
      `).run(documentId, checkpointSequence).changes);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return {
      documentId,
      checkpointSequence,
      checkpointOperations: snapshot.operations.length,
      operationRowsBefore,
      operationRowsAfter: this.countRows("operations", documentId),
      revisionsBefore,
      revisionsAfter: this.countRows("revisions", documentId),
      payloadBytesBefore,
      payloadBytesAfter: this.payloadBytes(documentId),
      deletedOperationRows,
      prunedRevisions,
    };
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

  isReady(): boolean {
    try {
      this.database.prepare("SELECT 1 FROM operations LIMIT 1").get();
      this.database.prepare("SELECT 1 FROM revisions LIMIT 1").get();
      this.database.prepare("SELECT 1 FROM document_checkpoints LIMIT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  private compactionReport(
    documentId: string,
    checkpoint: StoredCheckpoint,
    deletedOperationRows: number,
    prunedRevisions: number,
  ): CompactionReport {
    const operationRows = this.countRows("operations", documentId);
    const revisions = this.countRows("revisions", documentId);
    const payloadBytes = this.payloadBytes(documentId);
    return {
      documentId,
      checkpointSequence: checkpoint.sequence,
      checkpointOperations: checkpoint.operationCount,
      operationRowsBefore: operationRows,
      operationRowsAfter: operationRows,
      revisionsBefore: revisions,
      revisionsAfter: revisions,
      payloadBytesBefore: payloadBytes,
      payloadBytesAfter: payloadBytes,
      deletedOperationRows,
      prunedRevisions,
    };
  }

  private countRows(table: "operations" | "revisions", documentId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM ${table} WHERE document_id = ?
    `).get(documentId) as { count: number };
    return Number(row.count);
  }

  private operationSequenceMaximum(documentId: string): number {
    const row = this.database.prepare(`
      SELECT MIN(sequence) AS minimum, MAX(sequence) AS maximum
      FROM operations
      WHERE document_id = ?
    `).get(documentId) as { minimum: number | null; maximum: number | null };
    if (row.minimum === null || row.maximum === null) return 0;
    const minimum = Number(row.minimum);
    const maximum = Number(row.maximum);
    if (!Number.isSafeInteger(minimum) || minimum < 1 ||
        !Number.isSafeInteger(maximum) || maximum < minimum) {
      throw new Error("corrupt stored operation sequence");
    }
    return maximum;
  }

  private payloadBytes(documentId: string): number {
    const operationRow = this.database.prepare(`
      SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes
      FROM operations WHERE document_id = ?
    `).get(documentId) as { bytes: number };
    const checkpointRow = this.database.prepare(`
      SELECT COALESCE(length(CAST(snapshot AS BLOB)), 0) AS bytes
      FROM document_checkpoints WHERE document_id = ?
    `).get(documentId) as { bytes: number } | undefined;
    return Number(operationRow.bytes) + Number(checkpointRow?.bytes ?? 0);
  }
}
