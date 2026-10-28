import assert from "node:assert/strict";
import { test } from "node:test";
import { runCompactionExperiment } from "../tools/compaction-experiment.ts";

test("compaction experiment reports reproducible runtime context and invariants", async () => {
  const report = await runCompactionExperiment({
    batches: 20,
    retainedRevisions: 5,
    samples: 3,
  });

  assert.match(report.environment.nodeVersion, /^v\d+/);
  assert.ok(report.environment.platform.length > 0);
  assert.ok(report.environment.operatingSystemRelease.length > 0);
  assert.ok(report.environment.architecture.length > 0);
  assert.ok(report.environment.availableParallelism >= 1);
  assert.ok(report.environment.cpuModel.length > 0);
  assert.equal(report.operationRowsBefore, 20);
  assert.equal(report.operationRowsAfter, 4);
  assert.equal(report.logicalOperationsBefore, 20);
  assert.equal(report.logicalOperationsAfter, 20);
  assert.equal(report.exactTextMatch, true);
  assert.match(report.finalTextSha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(report.catchUpMedianMsBefore) && report.catchUpMedianMsBefore >= 0);
  assert.ok(Number.isFinite(report.catchUpMedianMsAfter) && report.catchUpMedianMsAfter >= 0);
  assert.ok(report.limitations.some((limitation) => limitation.includes("single-process")));
});
