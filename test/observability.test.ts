import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { SequenceDocument } from "../src/crdt.ts";
import { startSyncServer } from "../src/server.ts";

interface RuntimeMetrics {
  status: string;
  uptimeSeconds: number;
  activeConnections: number;
  totalConnections: number;
  transportErrors: number;
  messagesReceived: number;
  rejectedMessages: number;
  operationsPersisted: number;
}

test("readiness distinguishes SQLite availability from process liveness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weavepad-readiness-"));
  const databasePath = join(directory, "documents.db");
  const server = await startSyncServer({ port: 0, databasePath, staticDirectory: false });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const ready = await fetch(`${origin}/ready`);
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get("cache-control"), "no-store");
    assert.deepEqual(await ready.json(), { status: "ready" });

    const sabotage = new DatabaseSync(databasePath);
    sabotage.exec("DROP TABLE operations");
    sabotage.close();

    const unavailable = await fetch(`${origin}/ready`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { status: "unavailable" });

    const live = await fetch(`${origin}/health`);
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("cache-control"), "no-store");
    assert.deepEqual(await live.json(), { status: "ok" });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime metrics expose aggregate connection and protocol health", async (context) => {
  const server = await startSyncServer({ port: 0, databasePath: ":memory:", staticDirectory: false });
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;

  const initialResponse = await fetch(`${origin}/metrics`);
  assert.equal(initialResponse.headers.get("cache-control"), "no-store");
  const initial = await initialResponse.json() as RuntimeMetrics;
  assert.equal(initial.status, "ok");
  assert.ok(initial.uptimeSeconds >= 0);
  assert.equal(initial.activeConnections, 0);
  assert.equal(initial.totalConnections, 0);
  assert.equal(initial.transportErrors, 0);
  assert.equal(initial.messagesReceived, 0);
  assert.equal(initial.rejectedMessages, 0);
  assert.equal(initial.operationsPersisted, 0);

  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/documents/metrics-test`);
  const readyMessage = once(socket, "message");
  await once(socket, "open");
  await readyMessage;

  const errorMessage = once(socket, "message");
  socket.send(JSON.stringify({ type: "unsupported" }));
  await errorMessage;

  const document = new SequenceDocument("metrics-author");
  const operationMessage = once(socket, "message");
  socket.send(JSON.stringify({
    type: "operations",
    operations: document.localInsert(0, "A"),
  }));
  await operationMessage;

  const active = await fetch(`${origin}/metrics`).then((response) => response.json()) as RuntimeMetrics;
  assert.equal(active.activeConnections, 1);
  assert.equal(active.totalConnections, 1);
  assert.equal(active.messagesReceived, 2);
  assert.equal(active.rejectedMessages, 1);
  assert.equal(active.operationsPersisted, 1);

  socket.close();
  await once(socket, "close");
  let closed = active;
  for (let attempt = 0; attempt < 20 && closed.activeConnections !== 0; attempt += 1) {
    await delay(5);
    closed = await fetch(`${origin}/metrics`).then((response) => response.json()) as RuntimeMetrics;
  }
  assert.equal(closed.activeConnections, 0);
  assert.equal(closed.totalConnections, 1);
});

test("oversized WebSocket frames are isolated and counted", async (context) => {
  const server = await startSyncServer({ port: 0, databasePath: ":memory:", staticDirectory: false });
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/documents/payload-limit`);
  const readyMessage = once(socket, "message");
  await once(socket, "open");
  await readyMessage;

  const closedEvent = once(socket, "close");
  socket.send("x".repeat(1_048_577));
  await closedEvent;

  let metrics = await fetch(`${origin}/metrics`).then((response) => response.json()) as RuntimeMetrics;
  for (let attempt = 0; attempt < 20 && metrics.transportErrors !== 1; attempt += 1) {
    await delay(5);
    metrics = await fetch(`${origin}/metrics`).then((response) => response.json()) as RuntimeMetrics;
  }
  assert.equal(metrics.activeConnections, 0);
  assert.equal(metrics.totalConnections, 1);
  assert.equal(metrics.transportErrors, 1);
  assert.equal(metrics.messagesReceived, 0);

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
});
