// Remote MCP tool calls as the Worker makes them: in workerd (Miniflare), against a stand-in MCP
// server answering through outboundService. Node tests that replace globalThis.fetch could not see
// that Workers' fetch refuses `redirect: "error"` before any request leaves; from 0.8 until this
// fix every rule and agent tool call failed that way without reaching its host (live 2026-10-10:
// the urgent-mail rule on support@nicegram.me ended "unknown", the signals server saw nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const HOST = "tools.example.com";

const bundle = await build({
  stdin: {
    contents: `
      import { callMcpTool } from './workers/automation/mcp';
      import { readToolSchema } from './workers/agents/tool-schema';
      export default {
        async fetch(request) {
          const c = await request.json();
          try {
            if (c.op === 'call') return Response.json({ ok: await callMcpTool(c.call, '${HOST}', { SIGNALS: 'secret-token' }) });
            if (c.op === 'schema') return Response.json({ ok: await readToolSchema(c.grant, '${HOST}', {}) });
          } catch (e) { return Response.json({ error: String(e && e.message || e) }); }
          return new Response('unknown op', { status: 400 });
        },
      };`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers"],
  target: "es2022",
});

type Seen = { method: string; path: string; auth: string | null; rpc: string | null; redirect: string };

function standInServer(seen: Seen[]) {
  return async (request: Request) => {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : null;
    seen.push({ method: request.method, path: url.pathname, auth: request.headers.get("authorization"), rpc: body?.method ?? null, redirect: request.redirect });
    if (url.pathname === "/moved") return new Response(null, { status: 307, headers: { Location: `https://${HOST}/mcp` } });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result =
      body.method === "initialize" ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1" } }
      : body.method === "tools/list" ? { tools: [{ name: "communicator.signal.emit", inputSchema: { type: "object", properties: { kind: { type: "string" } } } }] }
      : body.method === "tools/call" ? { content: [{ type: "text", text: `emitted ${body.params.arguments.kind}` }] }
      : null;
    if (!result) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
}

async function worker(seen: Seen[]) {
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: standInServer(seen),
  });
  const run = async (command: unknown) => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(command) })).json() as Promise<any>;
  return { mf, run };
}

test("a rule's tool call reaches its host from workerd, with its credential, and returns the tool's result", async () => {
  const seen: Seen[] = [];
  const { mf, run } = await worker(seen);
  try {
    const out = await run({ op: "call", call: { endpoint: `https://${HOST}/mcp`, tool: "communicator.signal.emit", arguments: { kind: "inbox.mail.urgent" }, tokenRef: "SIGNALS" } });
    assert.equal(out.error, undefined, out.error);
    assert.deepEqual(out.ok.content, [{ type: "text", text: "emitted inbox.mail.urgent" }]);
    const rpcs = seen.filter((s) => s.method === "POST").map((s) => s.rpc);
    assert.deepEqual(rpcs, ["initialize", "notifications/initialized", "tools/call"]);
    assert.ok(seen.every((s) => s.auth === "Bearer secret-token"), "every request carries the configured credential");
  } finally {
    await mf.dispose();
  }
});

test("an agent's tool schema is read from workerd too", async () => {
  const seen: Seen[] = [];
  const { mf, run } = await worker(seen);
  try {
    const out = await run({ op: "schema", grant: { endpoint: `https://${HOST}/mcp`, tool: "communicator.signal.emit" } });
    assert.equal(out.error, undefined, out.error);
    assert.deepEqual(out.ok, { type: "object", properties: { kind: { type: "string" } } });
  } finally {
    await mf.dispose();
  }
});

test("a redirecting endpoint is refused and its Location is never requested", async () => {
  const seen: Seen[] = [];
  const { mf, run } = await worker(seen);
  try {
    const out = await run({ op: "call", call: { endpoint: `https://${HOST}/moved`, tool: "communicator.signal.emit", arguments: {} } });
    assert.match(out.error, /redirect/i);
    assert.deepEqual(seen.map((s) => s.path), ["/moved"], "one request; the redirect target is not fetched");
  } finally {
    await mf.dispose();
  }
});
