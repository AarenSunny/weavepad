import type { IncomingMessage, ServerResponse } from "node:http";
import type { CollaborationHub } from "./sync.ts";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  hub: CollaborationHub,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;
  if (request.method !== "GET") {
    json(response, 405, { error: "method not allowed" });
    return true;
  }

  try {
    const versionMatch = /^\/api\/documents\/([^/]+)\/versions\/(\d+)$/.exec(url.pathname);
    if (versionMatch) {
      const documentId = decodeURIComponent(versionMatch[1]);
      const sequence = Number(versionMatch[2]);
      const revision = hub.revisionAt(documentId, sequence);
      if (!revision) {
        json(response, 404, { error: "revision not found" });
      } else {
        json(response, 200, { documentId, revision, text: hub.versionText(documentId, sequence) });
      }
      return true;
    }

    const historyMatch = /^\/api\/documents\/([^/]+)\/history$/.exec(url.pathname);
    if (historyMatch) {
      const documentId = decodeURIComponent(historyMatch[1]);
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
      json(response, 200, { documentId, revisions: hub.history(documentId, limit) });
      return true;
    }

    json(response, 404, { error: "API route not found" });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : "invalid request" });
  }
  return true;
}
