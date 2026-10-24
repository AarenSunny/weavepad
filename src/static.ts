import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

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

class StaticPathEscapeError extends Error {}

function isWithinRoot(root: string, candidate: string): boolean {
  const withinRoot = relative(root, candidate);
  return withinRoot !== ".." && !withinRoot.startsWith(`..${sep}`) && !isAbsolute(withinRoot);
}

function safePath(root: string, requestPath: string): string | null {
  const candidate = resolve(root, requestPath);
  return isWithinRoot(root, candidate) ? candidate : null;
}

async function regularFile(root: string, candidate: string): Promise<string> {
  const canonical = await realpath(candidate);
  if (!isWithinRoot(root, canonical)) throw new StaticPathEscapeError();
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error("not a file");
  return canonical;
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

  let root: string;
  try {
    root = await realpath(resolve(directory));
  } catch {
    return false;
  }
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = safePath(root, requested);
  if (!file) {
    response.writeHead(403).end();
    return true;
  }

  try {
    file = await regularFile(root, file);
  } catch (error) {
    if (error instanceof StaticPathEscapeError) {
      response.writeHead(403).end();
      return true;
    }
    if (requested.startsWith("assets/") || extname(requested)) return false;
    file = safePath(root, "index.html");
    if (!file) return false;
    try {
      file = await regularFile(root, file);
    } catch (fallbackError) {
      if (fallbackError instanceof StaticPathEscapeError) {
        response.writeHead(403).end();
        return true;
      }
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
