import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function safePath(root: string, requestPath: string): string | null {
  const candidate = resolve(root, requestPath);
  const withinRoot = relative(root, candidate);
  if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) return null;
  return candidate;
}

export async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  directory: string,
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400).end();
    return true;
  }

  const root = resolve(directory);
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = safePath(root, requested);
  if (!file) {
    response.writeHead(403).end();
    return true;
  }

  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error("not a file");
  } catch {
    if (extname(requested)) return false;
    file = safePath(root, "index.html");
    if (!file) return false;
    try {
      const fallback = await stat(file);
      if (!fallback.isFile()) return false;
    } catch {
      return false;
    }
  }

  const extension = extname(file).toLowerCase();
  const immutableAsset = requested.startsWith("assets/");
  response.writeHead(200, {
    "cache-control": immutableAsset ? "public, max-age=31536000, immutable" : "no-cache",
    "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
  } else {
    const stream = createReadStream(file);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }
  return true;
}
