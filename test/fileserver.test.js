import test from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";

import makeHyperHTTPFetch from "hyper-http-fetch";

import createTestnet from "hyperdht/testnet.js";
import { makeFileServer, resolveFile } from "../src/fileserver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_FOLDER = resolve(__dirname, "../app/");

const { size: INDEX_SIZE } = await stat(resolve(ROOT_FOLDER, "index.html"));

/**
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{server: Awaited<ReturnType<typeof makeFileServer>>, fetch: Awaited<ReturnType<typeof makeHyperHTTPFetch>>}>}
 */
async function setup(t) {
  const testnet = await createTestnet(3);
  t.after(() => testnet.destroy());

  const server = await makeFileServer({
    dht: { bootstrap: testnet.bootstrap },
    rootFolder: ROOT_FOLDER,
    seed: randomBytes(32),
  });
  t.after(() => server.destroy());

  const fetch = await makeHyperHTTPFetch({ bootstrap: testnet.bootstrap });
  t.after(fetch.close);

  return { server, fetch };
}

test("fileserver lists directory contents", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "?noResolve");
  assert.ok(res.ok, "Response is OK");
  assert.equal(
    res.headers.get("content-type"),
    "application/json",
    "Content-Type is application/json",
  );

  const listings = await res.json();
  assert.ok(Array.isArray(listings), "Response body is an array");
  assert.ok(
    listings.some((entry) => entry === "index.html"),
    "Listings contain index.html",
  );
  assert.ok(
    listings.some((entry) => entry.endsWith(".js")),
    "Listings contain .js files",
  );
});

test("fileserver serves index.html content", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "index.html");
  assert.ok(res.ok, "Response is OK");
  assert(
    res.headers.get("content-type")?.startsWith("text/html"),
    "Content-Type starts with text/html",
  );

  const body = await res.text();
  assert.ok(body.includes("Setkamost"), "Body contains expected HTML content");
});

test("resolveFile rejects path traversal (../README.md) in the path", async (t) => {
  assert.throws(
    () => resolveFile(ROOT_FOLDER, "./../README.md"),
    { message: "Invalid path" },
    "resolveFile throws on path traversal",
  );
});

test("fileserver resolves / to index.html", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url);
  assert.ok(res.ok, "Response is OK");
  assert(
    res.headers.get("content-type")?.startsWith("text/html"),
    "Content-Type is text/html",
  );

  const body = await res.text();
  assert.ok(
    body.includes("<!DOCTYPE html>") || body.includes("Setkamost"),
    "Body contains HTML content",
  );
});

test("fileserver serves HTML directory listing with Accept: text/html", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "?noResolve", {
    headers: { Accept: "text/html" },
  });
  assert.ok(res.ok, "Response is OK");
  assert(
    res.headers.get("content-type")?.startsWith("text/html"),
    "Content-Type is text/html",
  );

  const body = await res.text();
  assert.ok(body.includes("<!DOCTYPE html>"), "Body is HTML");
  assert.ok(body.includes("Index of"), "Body contains index heading");
});

test("fileserver serves JSON directory listing by default with noResolve", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "?noResolve");
  assert.ok(res.ok, "Response is OK");
  assert.equal(
    res.headers.get("content-type"),
    "application/json",
    "Content-Type is application/json",
  );

  const listings = await res.json();
  assert.ok(Array.isArray(listings), "Response body is an array");
});

test("fileserver resolves extension-less path to .html", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "index");
  assert.ok(res.ok, "Response is OK");
  assert(
    res.headers.get("content-type")?.startsWith("text/html"),
    "Content-Type is text/html",
  );
});

test("fileserver HEAD on directory returns 204", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url, { method: "HEAD" });
  assert.equal(res.status, 204, "Status is 204");
});

test("fileserver HEAD on file returns 204 with content-type", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "index.html", {
    method: "HEAD",
  });
  assert.equal(res.status, 204, "Status is 204");
  assert(
    res.headers.get("content-type")?.startsWith("text/html"),
    "Content-Type is text/html",
  );
});

test("fileserver 404 for non-existent file", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "does-not-exist-xyz");
  assert.equal(res.status, 404, "Status is 404");
});

test("fileserver GET with Range header returns 206 and partial content", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "index.html", {
    headers: { Range: "bytes=0-99" },
  });
  assert.equal(res.status, 206, "Status is 206");
  assert(
    res.headers.get("content-type")?.startsWith("text/html"),
    "Content-Type is text/html",
  );
  assert.equal(
    res.headers.get("content-range"),
    `bytes 0-99/${INDEX_SIZE}`,
    "Content-Range is correct",
  );
  assert.equal(
    res.headers.get("content-length"),
    "100",
    "Content-Length is 100",
  );

  const body = await res.arrayBuffer();
  assert.equal(body.byteLength, 100, "Body is 100 bytes");
});

test("fileserver GET with mid-file Range header returns 206", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "index.html", {
    headers: { Range: "bytes=1000-1999" },
  });
  assert.equal(res.status, 206, "Status is 206");
  assert.equal(
    res.headers.get("content-range"),
    `bytes 1000-1999/${INDEX_SIZE}`,
    "Content-Range is correct",
  );
  assert.equal(
    res.headers.get("content-length"),
    "1000",
    "Content-Length is 1000",
  );

  const body = await res.arrayBuffer();
  assert.equal(body.byteLength, 1000, "Body is 1000 bytes");
});

test("fileserver GET with open-ended Range header returns 206", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "index.html", {
    headers: { Range: "bytes=3500-" },
  });
  assert.equal(res.status, 206, "Status is 206");
  assert.equal(
    res.headers.get("content-range"),
    `bytes 3500-${INDEX_SIZE - 1}/${INDEX_SIZE}`,
    "Content-Range is correct",
  );

  const body = await res.arrayBuffer();
  assert.equal(body.byteLength, 53, "Body is 53 bytes");
});

test("fileserver HEAD with Range header includes Content-Range", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "index.html", {
    method: "HEAD",
    headers: { Range: "bytes=0-49" },
  });
  assert.equal(res.status, 204, "Status is 204");
  assert.equal(
    res.headers.get("content-range"),
    `bytes 0-49/${INDEX_SIZE}`,
    "Content-Range is correct",
  );
  assert.equal(res.headers.get("content-length"), "50", "Content-Length is 50");
});

test("fileserver GET without Range returns full file", async (t) => {
  const { server, fetch: hyperFetch } = await setup(t);

  const res = await hyperFetch(server.url + "index.html");
  assert.equal(res.status, 200, "Status is 200");
  assert.equal(
    res.headers.get("content-length"),
    `${INDEX_SIZE}`,
    "Content-Length is full size",
  );
  assert.equal(
    res.headers.get("accept-ranges"),
    "bytes",
    "Accept-Ranges is bytes",
  );

  const body = await res.arrayBuffer();
  assert.equal(body.byteLength, INDEX_SIZE, "Body is full size");
});
