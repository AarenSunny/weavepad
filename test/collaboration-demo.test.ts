import assert from "node:assert/strict";
import { test } from "node:test";
import { runCollaborationDemo } from "../tools/collaboration-demo.ts";

test("two clients converge after offline edits, reconnect catch-up, and a server restart", async () => {
  const report = await runCollaborationDemo();

  assert.equal(report.clients, 2);
  assert.equal(report.reconnects, 1);
  assert.ok(report.catchUpOperations > 0);
  assert.ok(report.flushedOfflineOperations > 0);
  assert.ok(report.durableSequence > report.catchUpOperations);
  assert.equal(report.converged, true);
  assert.equal(report.survivedServerRestart, true);
  assert.match(report.finalTextSha256, /^[a-f0-9]{64}$/);
});
