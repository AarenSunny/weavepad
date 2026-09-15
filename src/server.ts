import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { Operation } from "./crdt.ts";
import { PresenceManager, type PresenceProfile, type PresenceSelection } from "./presence.ts";
import { CollaborationHub, type SyncBatch } from "./sync.ts";
import { SqliteOperationStore, validateDocumentId } from "./store.ts";
import { serveStatic } from "./static.ts";

interface ClientSyncMessage {
  type: "sync";
  after?: number;
}

interface ClientOperationsMessage {
  type: "operations";
  operations: Operation[];
}

interface ClientPresenceMessage {
  type: "presence";
  user: PresenceProfile;
  selection: PresenceSelection | null;
}

interface ClientHeartbeatMessage {
  type: "heartbeat";
}

type ClientMessage = ClientSyncMessage | ClientOperationsMessage | ClientPresenceMessage | ClientHeartbeatMessage;

export interface SyncServer {
  http: HttpServer;
  hub: CollaborationHub;
  presence: PresenceManager;
  port: number;
  close(): Promise<void>;
}

export interface SyncServerOptions {
  host?: string;
  port?: number;
  databasePath?: string;
  presenceTtlMs?: number;
  presenceSweepIntervalMs?: number;
  staticDirectory?: string | false;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function wireBatch(type: "sync" | "operations", batch: SyncBatch): object {
  return {
    type,
    documentId: batch.documentId,
    cursor: batch.cursor,
    operations: batch.operations,
  };
}

export async function startSyncServer(options: SyncServerOptions = {}): Promise<SyncServer> {
  const host = options.host ?? "127.0.0.1";
  const store = new SqliteOperationStore(options.databasePath ?? "weavepad.db");
  const staticDirectory = options.staticDirectory === undefined ? "dist" : options.staticDirectory;
  const hub = new CollaborationHub(store);
  const presence = new PresenceManager({ ttlMs: options.presenceTtlMs });
  const sockets = new Set<WebSocket>();
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  const http = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (staticDirectory && await serveStatic(request, response, staticDirectory)) return;
    response.writeHead(404).end();
  });

  http.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const match = /^\/documents\/([^/]+)$/.exec(url.pathname);
      if (!match) throw new Error("expected /documents/:documentId");
      const documentId = decodeURIComponent(match[1]);
      validateDocumentId(documentId);
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit("connection", webSocket, request, documentId);
      });
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  webSockets.on("connection", (socket: WebSocket, _request, documentId: string) => {
    const sessionId = randomUUID();
    sockets.add(socket);
    const unsubscribe = hub.subscribe(documentId, (batch) => {
      send(socket, wireBatch("operations", batch));
    });
    const unsubscribePresence = presence.subscribe(documentId, (snapshot) => send(socket, snapshot));
    send(socket, { type: "ready", documentId, sessionId, presence: presence.snapshot(documentId) });

    socket.on("message", (data, isBinary) => {
      try {
        if (isBinary) throw new Error("binary messages are not supported");
        const message = JSON.parse(data.toString()) as ClientMessage;
        if (message?.type === "sync") {
          send(socket, wireBatch("sync", hub.sync(documentId, message.after ?? 0)));
        } else if (message?.type === "operations") {
          hub.submit(documentId, message.operations);
        } else if (message?.type === "presence") {
          presence.update(documentId, sessionId, message.user, message.selection);
        } else if (message?.type === "heartbeat") {
          if (!presence.heartbeat(documentId, sessionId)) {
            throw new Error("send presence before heartbeat");
          }
        } else {
          throw new Error("unsupported message type");
        }
      } catch (error) {
        send(socket, {
          type: "error",
          message: error instanceof Error ? error.message : "invalid message",
        });
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      unsubscribe();
      unsubscribePresence();
      presence.leave(documentId, sessionId);
    });
  });

  const sweepTimer = setInterval(
    () => presence.sweepExpired(),
    options.presenceSweepIntervalMs ?? Math.min(5_000, Math.floor(presence.ttlMs / 2)),
  );
  sweepTimer.unref();

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 3000, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

  return {
    http,
    hub,
    presence,
    port: address.port,
    async close() {
      clearInterval(sweepTimer);
      for (const socket of sockets) socket.close(1001, "server shutdown");
      await new Promise<void>((resolve, reject) => {
        webSockets.close(() => http.close((error) => error ? reject(error) : resolve()));
      });
      store.close();
    },
  };
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  const server = await startSyncServer({
    host: process.env.HOST,
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    databasePath: process.env.WEAVEPAD_DB,
    staticDirectory: process.env.WEAVEPAD_STATIC ?? "dist",
  });
  console.log(`WeavePad listening on http://${process.env.HOST ?? "127.0.0.1"}:${server.port}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
  };
  const handleSignal = () => {
    void shutdown().catch((error) => {
      console.error("WeavePad shutdown failed", error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
}
