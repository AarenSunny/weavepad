import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { SequenceDocument } from "../src/crdt.ts";
import { startSyncServer, type SyncServer } from "../src/server.ts";
import type { StoredOperation } from "../src/store.ts";

interface Client {
  socket: WebSocket;
  next(): Promise<Record<string, unknown>>;
}

export interface CollaborationDemoReport {
  clients: 2;
  reconnects: 1;
  catchUpOperations: number;
  flushedOfflineOperations: number;
  durableSequence: number;
  converged: true;
  survivedServerRestart: true;
  finalTextSha256: string;
  limitations: string[];
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function inbox(socket: WebSocket): () => Promise<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  return () => {
    const queued = messages.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => waiters.push(resolve));
  };
}

async function connect(server: SyncServer): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/documents/portfolio-demo`);
  const nextMessage = inbox(socket);
  await withTimeout(once(socket, "open").then(() => undefined), "WebSocket connection");
  const ready = await withTimeout(nextMessage(), "ready message");
  if (ready.type !== "ready") throw new Error(`expected ready message, received ${String(ready.type)}`);
  return { socket, next: () => withTimeout(nextMessage(), "collaboration message") };
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  if (socket.readyState === WebSocket.CLOSING) {
    await withTimeout(once(socket, "close").then(() => undefined), "WebSocket close");
    return;
  }
  socket.close();
  await withTimeout(once(socket, "close").then(() => undefined), "WebSocket close");
}

function operations(message: Record<string, unknown>): StoredOperation[] {
  if (message.type !== "operations" && message.type !== "sync") {
    throw new Error(`expected operation message, received ${String(message.type)}`);
  }
  if (!Array.isArray(message.operations)) throw new Error("operation message is missing operations");
  return message.operations as StoredOperation[];
}

export async function runCollaborationDemo(): Promise<CollaborationDemoReport> {
  const directory = await mkdtemp(join(tmpdir(), "weavepad-collaboration-"));
  const databasePath = join(directory, "documents.db");
  let server: SyncServer | null = null;
  const openSockets = new Set<WebSocket>();

  try {
    server = await startSyncServer({ port: 0, databasePath, staticDirectory: false });
    const alice = await connect(server);
    let bob = await connect(server);
    openSockets.add(alice.socket);
    openSockets.add(bob.socket);
    const aliceDocument = new SequenceDocument("alice");
    const bobDocument = new SequenceDocument("bob");

    const seed = aliceDocument.localInsert(0, "Shared plan");
    alice.socket.send(JSON.stringify({ type: "operations", operations: seed }));
    const [aliceSeed, bobSeed] = await Promise.all([alice.next(), bob.next()]);
    aliceDocument.merge(operations(aliceSeed).map((entry) => entry.operation));
    bobDocument.merge(operations(bobSeed).map((entry) => entry.operation));
    const bobCursor = Number(bobSeed.cursor);

    await closeSocket(bob.socket);
    openSockets.delete(bob.socket);
    const offlineOperations = bobDocument.localInsert(bobDocument.length, " · Bob offline");
    const onlineOperations = aliceDocument.localInsert(aliceDocument.length, " · Alice online");
    alice.socket.send(JSON.stringify({ type: "operations", operations: onlineOperations }));
    aliceDocument.merge(operations(await alice.next()).map((entry) => entry.operation));

    bob = await connect(server);
    openSockets.add(bob.socket);
    bob.socket.send(JSON.stringify({ type: "sync", after: bobCursor }));
    const catchUp = await bob.next();
    const catchUpEntries = operations(catchUp);
    bobDocument.merge(catchUpEntries.map((entry) => entry.operation));

    bob.socket.send(JSON.stringify({ type: "operations", operations: offlineOperations }));
    const [aliceRemote, bobRemote] = await Promise.all([alice.next(), bob.next()]);
    const aliceEntries = operations(aliceRemote);
    const bobEntries = operations(bobRemote);
    aliceDocument.merge(aliceEntries.map((entry) => entry.operation));
    bobDocument.merge(bobEntries.map((entry) => entry.operation));

    const finalText = server.hub.text("portfolio-demo");
    if (aliceDocument.toString() !== finalText || bobDocument.toString() !== finalText) {
      throw new Error("client replicas did not converge with the server");
    }
    const durableSequence = Number(bobRemote.cursor);

    await Promise.all(Array.from(openSockets, closeSocket));
    openSockets.clear();
    await server.close();
    server = null;

    server = await startSyncServer({ port: 0, databasePath, staticDirectory: false });
    const persistedText = server.hub.text("portfolio-demo");
    if (persistedText !== finalText) throw new Error("document did not survive a complete server restart");

    return {
      clients: 2,
      reconnects: 1,
      catchUpOperations: catchUpEntries.length,
      flushedOfflineOperations: offlineOperations.length,
      durableSequence,
      converged: true,
      survivedServerRestart: true,
      finalTextSha256: createHash("sha256").update(finalText).digest("hex"),
      limitations: [
        "Both clients and the server run on one host over loopback networking.",
        "The disconnect and reconnect sequence is deterministic, not a randomized soak test.",
        "The demo validates convergence and durability, not concurrent-user capacity or wide-area latency.",
      ],
    };
  } finally {
    await Promise.all(Array.from(openSockets, (socket) => closeSocket(socket).catch(() => undefined)));
    if (server) await server.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runCollaborationDemo(), null, 2));
}
