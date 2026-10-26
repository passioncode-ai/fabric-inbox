import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

/** B-175: the deploy's HTTP/1.1 fetch answers like fetch: JSON, a multipart upload, a timeout, a refused connection. */
const { http1Fetch } = createRequire(import.meta.url)("../desktop/http1-fetch.cjs");

async function server(handler: http.RequestListener) {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

test("JSON in and out, the status and headers as fetch gives them, over HTTP/1.1", async () => {
  const seen: any[] = [];
  const s = await server((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { seen.push({ method: req.method, version: req.httpVersion, auth: req.headers.authorization, type: req.headers["content-type"], body });
      res.writeHead(201, { "Content-Type": "application/json", "X-A": "1" }); res.end(JSON.stringify({ success: true, result: { id: 7 } })); });
  });
  try {
    const r = await http1Fetch(s.url + "/accounts?page=1", { method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: JSON.stringify({ a: 1 }) });
    assert.equal(r.status, 201);
    assert.equal(r.ok, true);
    assert.equal(r.headers.get("x-a"), "1");
    assert.deepEqual(await r.json(), { success: true, result: { id: 7 } });
    assert.deepEqual(seen, [{ method: "POST", version: "1.1", auth: "Bearer t", type: "application/json", body: '{"a":1}' }]);
  } finally { await s.close(); }
});

test("a FormData body goes as multipart with its boundary, files intact", async () => {
  let got = { type: "", body: "" };
  const s = await server((req, res) => { const parts: Buffer[] = []; req.on("data", (c) => parts.push(c)); req.on("end", () => { got = { type: String(req.headers["content-type"]), body: Buffer.concat(parts).toString() }; res.end("{}"); }); });
  try {
    const form = new FormData();
    form.set("metadata", JSON.stringify({ main_module: "index.js" }));
    form.set("index.js", new File(["export default {}"], "index.js", { type: "application/javascript+module" }));
    await http1Fetch(s.url, { method: "PUT", body: form });
    assert.match(got.type, /^multipart\/form-data; boundary=/);
    assert.match(got.body, /name="metadata"[\s\S]*"main_module":"index.js"/);
    assert.match(got.body, /filename="index.js"\r\nContent-Type: application\/javascript\+module\r\n\r\nexport default \{\}/);
  } finally { await s.close(); }
});

test("a timeout rejects with TimeoutError, as the deployer expects; a refused connection rejects", async () => {
  const s = await server(() => { /* never answers */ });
  try {
    await assert.rejects(http1Fetch(s.url, { signal: AbortSignal.timeout(100) }), (e: any) => e.name === "TimeoutError");
  } finally { await s.close(); }
  await assert.rejects(http1Fetch("http://127.0.0.1:9/"));
  await assert.rejects(http1Fetch("ftp://x.invalid/"), /unsupported protocol/);
});
