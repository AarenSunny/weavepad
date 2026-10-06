import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { SequenceDocument } from "../src/crdt.ts";
import { CollaborationHub, type SyncBatch } from "../src/sync.ts";
import { SqliteOperationStore } from "../src/store.ts";

export interface CompactionExperimentOptions {
  batches: number;
  retainedRevisions: number;
  samples: number;
}

export interface CompactionExperimentReport {
  batches: number;
  retainedRevisions: number;
  checkpointSequence: number;
  checkpointOperations: number;
  operationRowsBefore: number;
  operationRowsAfter: number;
  operationRowReductionPercent: number;
  payloadBytesBefore: number;
  payloadBytesAfter: number;
  logicalOperationsBefore: number;
  logicalOperationsAfter: number;
  catchUpMedianMsBefore: number;
  catchUpMedianMsAfter: number;
  exactTextMatch: true;
  finalTextSha256: string;
  limitations: string[];
}

export const DEFAULT_COMPACTION_OPTIONS: CompactionExperimentOptions = {
  batches: 500,
  retainedRevisions: 25,
  samples: 25,
};

function validateOptions(options: CompactionExperimentOptions): void {
  if (!Number.isInteger(options.batches) || options.batches < 2 || options.batches > 2_000) {
    throw new Error("batches must be an integer between 2 and 2000");
  }
  if (!Number.isInteger(options.retainedRevisions)
      || options.retainedRevisions < 1
      || options.retainedRevisions > Math.min(options.batches, 100)) {
    throw new Error("retainedRevisions must be between 1 and min(batches, 100)");
  }
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 100) {
    throw new Error("samples must be an integer between 1 and 100");
  }
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function materialize(batch: SyncBatch): SequenceDocument {
  const document = new SequenceDocument("experiment-reader");
  document.merge(batch.checkpoint?.operations ?? []);
  document.merge(batch.operations.map((entry) => entry.operation));
  return document;
}

function timeCatchUp(hub: CollaborationHub, samples: number): { medianMs: number; batch: SyncBatch } {
  const timings: number[] = [];
  let batch = hub.sync("scale-document", 0);
  for (let sample = 0; sample < samples; sample += 1) {
    const started = performance.now();
    batch = hub.sync("scale-document", 0);
    materialize(batch);
    timings.push(performance.now() - started);
  }
  return { medianMs: median(timings), batch };
}

export async function runCompactionExperiment(
  options: CompactionExperimentOptions = DEFAULT_COMPACTION_OPTIONS,
): Promise<CompactionExperimentReport> {
  validateOptions(options);
  const directory = await mkdtemp(join(tmpdir(), "weavepad-compaction-"));
  const store = new SqliteOperationStore(join(directory, "documents.db"));
  const hub = new CollaborationHub(store);
  try {
    const author = new SequenceDocument("experiment-author");
    for (let batch = 0; batch < options.batches; batch += 1) {
      hub.submit("scale-document", author.localInsert(author.length, String(batch % 10)));
    }
    const expectedText = hub.text("scale-document");
    const before = timeCatchUp(hub, options.samples);
    const compaction = hub.compact("scale-document", options.retainedRevisions);
    const after = timeCatchUp(hub, options.samples);
    const restoredText = materialize(after.batch).toString();
    if (restoredText !== expectedText) throw new Error("compacted catch-up changed the materialized document");
    const logicalOperationsBefore = (before.batch.checkpoint?.operations.length ?? 0) + before.batch.operations.length;
    const logicalOperationsAfter = (after.batch.checkpoint?.operations.length ?? 0) + after.batch.operations.length;
    if (logicalOperationsBefore !== logicalOperationsAfter) {
      throw new Error("compaction changed the logical CRDT operation count");
    }

    return {
      batches: options.batches,
      retainedRevisions: options.retainedRevisions,
      checkpointSequence: compaction.checkpointSequence,
      checkpointOperations: compaction.checkpointOperations,
      operationRowsBefore: compaction.operationRowsBefore,
      operationRowsAfter: compaction.operationRowsAfter,
      operationRowReductionPercent: Number((
        100 * (compaction.operationRowsBefore - compaction.operationRowsAfter) / compaction.operationRowsBefore
      ).toFixed(1)),
      payloadBytesBefore: compaction.payloadBytesBefore,
      payloadBytesAfter: compaction.payloadBytesAfter,
      logicalOperationsBefore,
      logicalOperationsAfter,
      catchUpMedianMsBefore: Number(before.medianMs.toFixed(3)),
      catchUpMedianMsAfter: Number(after.medianMs.toFixed(3)),
      exactTextMatch: true,
      finalTextSha256: createHash("sha256").update(expectedText).digest("hex"),
      limitations: [
        "The checkpoint retains every CRDT operation and tombstone, so logical state size does not shrink.",
        "Timings are a single-process local SQLite diagnostic, not a multi-user capacity benchmark.",
        "Compaction is explicit; automatic scheduling and multi-node coordination are not implemented.",
      ],
    };
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function integerArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runCompactionExperiment({
    batches: integerArg("--batches", DEFAULT_COMPACTION_OPTIONS.batches),
    retainedRevisions: integerArg("--retain", DEFAULT_COMPACTION_OPTIONS.retainedRevisions),
    samples: integerArg("--samples", DEFAULT_COMPACTION_OPTIONS.samples),
  });
  console.log(JSON.stringify(report, null, 2));
}
