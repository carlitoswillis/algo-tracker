// lib/recall-api.js against a throwaway data directory, driven the way both
// servers drive it: a Node request-shaped stream in, a response-shaped sink
// out. ALGO_DATA_DIR is pointed at the temp dir before the first call, which
// is all lib/data-dir.js needs — it resolves the path on every request.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recall-api-"));
process.env.ALGO_DATA_DIR = tmp;

const { handleRecallRequest, recallFileFor } = await import("../lib/recall-api.js");
const { RECALL_EMPTY } = await import("../lib/recall.js");

const ROOT = path.resolve(import.meta.dirname, "..");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A request the handler can read like an IncomingMessage: `url`, `method`,
// and 'data' / 'end' events carrying the body. A response that records what
// was written and resolves once `end` is called.
// A GET is answered synchronously inside the handler call and a PUT after
// the body stream ends, so the promise settles whenever both the handler's
// return value and the written response are known.
const call = (method, body) => new Promise((resolve) => {
  const req = Readable.from(body == null ? [] : [Buffer.from(body)]);
  req.url = "/api/recall";
  req.method = method;
  let handled = null;
  let out = null;
  const settle = () => { if (handled !== null && (out !== null || handled === false)) resolve({ ...(out ?? { status: null, body: null }), handled }); };
  const res = {
    statusCode: null,
    headers: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(chunk) { out = { status: this.statusCode, body: chunk ? JSON.parse(chunk) : null }; settle(); },
  };
  handled = handleRecallRequest(req, res, { dir: ROOT });
  settle();
});

const sample = {
  version: 1,
  items: [{ id: "py-01", side: "python", prompt: "a dict comprehension", answer: "inv = {v: k for k, v in d.items()}" }],
  log: [{ date: "2026-10-03", id: "py-01", result: "clean" }],
};

before(() => {
  assert.equal(recallFileFor(ROOT), path.join(tmp, "recall.json"), "handler resolves into the temp dir");
});

test("GET with no file returns RECALL_EMPTY", async () => {
  const r = await call("GET");
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, RECALL_EMPTY);
  assert.equal(fs.existsSync(recallFileFor(ROOT)), false, "a read does not create the file");
});

test("PUT then GET round-trips the file", async () => {
  const put = await call("PUT", JSON.stringify(sample));
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, sample);
  assert.deepEqual(JSON.parse(fs.readFileSync(recallFileFor(ROOT), "utf-8")), sample);

  const get = await call("GET");
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, sample);
});

test("PUT a bad shape is a 400 and leaves the file alone", async () => {
  const before = fs.readFileSync(recallFileFor(ROOT), "utf-8");
  for (const bad of [
    { version: 1, items: "nope", log: [] },
    { version: 1, items: [{ id: "x", side: "ruby", prompt: "p", answer: "a" }], log: [] },
    { version: 1, items: [], log: [{ date: "2026-10-03", id: "ghost", result: "clean" }] },
    [],
  ]) {
    const r = await call("PUT", JSON.stringify(bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, /./);
  }
  const notJson = await call("PUT", "{not json");
  assert.equal(notJson.status, 400);
  assert.equal(fs.readFileSync(recallFileFor(ROOT), "utf-8"), before);
});

test("a second PUT keeps the previous file as recall.json.prev", async () => {
  const next = { ...sample, log: [] };
  const r = await call("PUT", JSON.stringify(next));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${recallFileFor(ROOT)}.prev`, "utf-8")), sample);
  assert.deepEqual(JSON.parse(fs.readFileSync(recallFileFor(ROOT), "utf-8")), next);
});

test("other paths and methods are not handled", async () => {
  const post = await call("POST", JSON.stringify(sample));
  assert.equal(post.handled, false);
  const req = Readable.from([]); req.url = "/api/sets"; req.method = "GET";
  assert.equal(handleRecallRequest(req, {}, { dir: ROOT }), false);
});
