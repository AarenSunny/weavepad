import assert from "node:assert/strict";
import { test } from "node:test";
import { SequenceDocument } from "../src/crdt.ts";
import { startSyncServer } from "../src/server.ts";
import { CollaborationHub } from "../src/sync.ts";
import { SqliteOperationStore } from "../src/store.ts";

test("accepted edit batches create durable document revisions", () => {
  const store = new SqliteOperationStore(":memory:");
  const hub = new CollaborationHub(store);
  const author = new SequenceDocument("alice");
  const first = hub.submit("notes", author.localInsert(0, "one"));
  const second = hub.submit("notes", author.localInsert(3, "!"));

  const history = hub.history("notes");
  assert.deepEqual(history.map((revision) => revision.revision), [2, 1]);
  assert.deepEqual(history.map((revision) => revision.operationCount), [1, 3]);
  assert.deepEqual(history[0].actors, ["alice"]);
  assert.equal(hub.versionText("notes", first.cursor), "one");
  assert.equal(hub.versionText("notes", second.cursor), "one!");
  store.close();
});

test("history API lists revisions and materializes a selected version", async (context) => {
  const server = await startSyncServer({ port: 0, databasePath: ":memory:", staticDirectory: false });
  context.after(() => server.close());
  const author = new SequenceDocument("alice");
  const first = server.hub.submit("api-demo", author.localInsert(0, "draft"));
  server.hub.submit("api-demo", author.localInsert(5, " two"));
  const origin = `http://127.0.0.1:${server.port}`;

  const historyResponse = await fetch(`${origin}/api/documents/api-demo/history`);
  assert.equal(historyResponse.status, 200);
  assert.match(historyResponse.headers.get("cache-control") ?? "", /no-store/);
  const history = await historyResponse.json() as { revisions: Array<{ sequence: number }> };
  assert.equal(history.revisions.length, 2);

  const versionResponse = await fetch(`${origin}/api/documents/api-demo/versions/${first.cursor}`);
  assert.equal(versionResponse.status, 200);
  const version = await versionResponse.json() as { text: string; revision: { revision: number } };
  assert.equal(version.text, "draft");
  assert.equal(version.revision.revision, 1);

  const missing = await fetch(`${origin}/api/documents/api-demo/versions/9999`);
  assert.equal(missing.status, 404);
});
