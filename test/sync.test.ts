import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { SequenceDocument } from "../src/crdt.ts";
import { startSyncServer, type SyncServer } from "../src/server.ts";

interface Inbox {
  next(): Promise<Record<string, any>>;
}

function createInbox(socket: WebSocket): Inbox {
  const messages: Array<Record<string, any>> = [];
  const waiters: Array<(message: Record<string, any>) => void> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, any>;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  return {
    next() {
      const message = messages.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function connect(server: SyncServer, documentId = "demo"): Promise<{ socket: WebSocket; inbox: Inbox }> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/documents/${documentId}`);
  const inbox = createInbox(socket);
  await once(socket, "open");
  assert.deepEqual(await inbox.next(), { type: "ready", documentId });
  return { socket, inbox };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.close();
  await once(socket, "close");
}

test("two WebSocket clients receive the same accepted operation batch", async (context) => {
  const server = await startSyncServer({ port: 0, databasePath: ":memory:" });
  context.after(() => server.close());
  const alice = await connect(server);
  const bob = await connect(server);
  context.after(() => Promise.all([closeSocket(alice.socket), closeSocket(bob.socket)]));

  const document = new SequenceDocument("alice");
  const operations = document.localInsert(0, "Hello 👋");
  alice.socket.send(JSON.stringify({ type: "operations", operations }));

  const fromAlice = await alice.inbox.next();
  const fromBob = await bob.inbox.next();
  assert.equal(fromAlice.type, "operations");
  assert.deepEqual(fromAlice, fromBob);
  assert.equal(fromAlice.operations.length, 7);
  assert.equal(server.hub.text("demo"), "Hello 👋");
});

test("a reconnecting client catches up from its last durable cursor", async (context) => {
  const server = await startSyncServer({ port: 0, databasePath: ":memory:" });
  context.after(() => server.close());
  const alice = await connect(server);
  let bob = await connect(server);
  context.after(async () => {
    await closeSocket(alice.socket);
    await closeSocket(bob.socket);
  });

  const document = new SequenceDocument("alice");
  alice.socket.send(JSON.stringify({ type: "operations", operations: document.localInsert(0, "A") }));
  const first = await alice.inbox.next();
  await bob.inbox.next();
  await closeSocket(bob.socket);

  alice.socket.send(JSON.stringify({ type: "operations", operations: document.localInsert(1, "B") }));
  await alice.inbox.next();

  bob = await connect(server);
  bob.socket.send(JSON.stringify({ type: "sync", after: first.cursor }));
  const catchUp = await bob.inbox.next();
  assert.equal(catchUp.type, "sync");
  assert.equal(catchUp.operations.length, 1);
  assert.equal(catchUp.operations[0].operation.value, "B");
  assert.ok(catchUp.cursor > first.cursor);
});

test("SQLite persistence survives a complete server restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "weavepad-"));
  const databasePath = join(directory, "documents.db");
  context.after(() => rm(directory, { recursive: true, force: true }));

  let server = await startSyncServer({ port: 0, databasePath });
  let client = await connect(server, "persistent-doc");
  const document = new SequenceDocument("author");
  client.socket.send(JSON.stringify({ type: "operations", operations: document.localInsert(0, "Durable") }));
  const written = await client.inbox.next();
  await closeSocket(client.socket);
  await server.close();

  server = await startSyncServer({ port: 0, databasePath });
  context.after(() => server.close());
  client = await connect(server, "persistent-doc");
  context.after(() => closeSocket(client.socket));
  client.socket.send(JSON.stringify({ type: "sync", after: 0 }));
  const restored = await client.inbox.next();
  assert.equal(restored.operations.length, written.operations.length);
  assert.equal(server.hub.text("persistent-doc"), "Durable");
});

test("protocol errors are isolated to the offending message", async (context) => {
  const server = await startSyncServer({ port: 0, databasePath: ":memory:" });
  context.after(() => server.close());
  const client = await connect(server);
  context.after(() => closeSocket(client.socket));

  client.socket.send(JSON.stringify({ type: "mystery" }));
  assert.match((await client.inbox.next()).message, /unsupported/);
  client.socket.send(JSON.stringify({ type: "sync", after: 0 }));
  assert.equal((await client.inbox.next()).type, "sync");
});
