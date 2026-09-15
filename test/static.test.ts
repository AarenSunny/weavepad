import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startSyncServer } from "../src/server.ts";

test("the production server serves the editor and immutable assets", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "weavepad-static-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>WeavePad</title>");
  await writeFile(join(directory, "assets", "app-abc123.js"), "console.log('weavepad')");
  const server = await startSyncServer({ port: 0, databasePath: ":memory:", staticDirectory: directory });
  context.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.port}`;

  const index = await fetch(`${origin}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(index.headers.get("cache-control"), "no-cache");
  assert.match(await index.text(), /WeavePad/);

  const asset = await fetch(`${origin}/assets/app-abc123.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

  const clientRoute = await fetch(`${origin}/document/demo`);
  assert.equal(clientRoute.status, 200);
  assert.match(await clientRoute.text(), /WeavePad/);
});

test("static serving cannot escape its configured directory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "weavepad-static-"));
  await writeFile(join(directory, "index.html"), "safe");
  const server = await startSyncServer({ port: 0, databasePath: ":memory:", staticDirectory: directory });
  context.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${server.port}/..%2Fpackage.json`);
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "");
});
