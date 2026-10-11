// The coding agent's setup (B-79, docs/agents/onboard.md): every step with fakes for Cloudflare,
// the app's connect link, the key store and Claude Code. What is checked is what matters for the
// person: a secret never reaches argv, stdout or the record, and each human step is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(os.tmpdir(), "fabric-onboard-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.APPDATA = path.join(home, "AppData");
const m = await import("../scripts/onboard.mjs");

function fakeStore() {
  const items = new Map<string, unknown>();
  return { items, put: async (a: string, v: unknown) => { items.set(a, v); }, get: async (a: string) => (items.get(a) as any) ?? null, remove: async (a: string) => items.delete(a) };
}
const events: any[] = [];
const say = (e: unknown) => { events.push(e); };

test("the token is never an argument; arguments are flags", () => {
  assert.throws(() => m.parseArgs(["server", "--token", "abc"]), /never an argument/);
  assert.deepEqual(m.parseArgs(["connect", "--level", "read", "--send", "--json"]), { command: "connect", opts: { level: "read", send: true, json: true } });
});

test("the Cloudflare token comes from a named variable, or a hidden prompt in a terminal only", async () => {
  assert.equal(await m.readToken({ envName: "CF_TOKEN", env: { CF_TOKEN: " t0ken \n" } }), "t0ken");
  await assert.rejects(m.readToken({ envName: "CF_TOKEN", env: {} }), (e: any) => e.code === "no_token");
  await assert.rejects(m.readToken({ stdin: { isTTY: false } as any }), (e: any) => e.code === "no_token" && /terminal/.test(e.human));
});

test("the key store takes the secret on stdin on every system, never as an argument", async () => {
  const value = { clientId: "abc.access", clientSecret: "f00d".repeat(16) };
  for (const platform of ["darwin", "linux", "win32"]) {
    const calls: { file: string; args: string[]; input?: string }[] = [];
    let kept = "";
    const exec = async (file: string, args: string[], o: { input?: string } = {}) => {
      calls.push({ file, args, input: o.input });
      if (o.input !== undefined) { kept = platform === "darwin" ? /-w "([^"]+)"/.exec(o.input)![1] : o.input; return ""; }
      return kept;
    };
    const store = m.keyStore(platform, exec);
    await store.put("mail.example.workers.dev", value);
    assert.ok(calls.every((c) => !c.args.join(" ").includes(value.clientSecret) && !c.args.join(" ").includes(kept)), `${platform}: no secret in argv`);
    assert.deepEqual(await store.get("mail.example.workers.dev"), value, platform);
  }
  assert.equal(await m.keyStore("darwin", async () => { throw new Error("not found"); }).get("x"), null);
});

test("the record says where things are and refuses to hold a secret", () => {
  assert.ok(m.recordPath("darwin", {}, "/Users/p").endsWith(path.join("Library", "Application Support", "PassionCode", "fabric-inbox", "onboard.json")));
  assert.ok(m.recordPath("linux", { XDG_CONFIG_HOME: "/x" }, "/home/p").startsWith(path.join("/x", "PassionCode")));
  assert.throws(() => m.writeRecord({ server: "https://a", clientSecret: "no" }, path.join(home, "r.json")), /must not hold/);
});

test("server: one account is used; several need --account; the person is told what is theirs next", async () => {
  const deployer = {
    accounts: async () => [{ id: "acc1", name: "Mine" }],
    deploy: async (o: any) => { o.onStep({ id: "subdomain", outcome: "done", detail: "x" }); return { origin: "https://fabric-inbox.me.workers.dev", accessOrigin: "https://me.cloudflareaccess.com", steps: [] }; },
  };
  events.length = 0;
  const record = await m.stepServer({ email: "me@example.com" }, { say, deployer, token: "t", bundle: async () => "/bundle" });
  assert.equal(record.server, "https://fabric-inbox.me.workers.dev");
  const last = events.at(-1);
  assert.equal(last.step, "server");
  assert.match(last.human, /sign in/);
  assert.ok(!JSON.stringify(events).includes('"t"'), "the token is in no event");
  // The app offers this server on its welcome screen (B-80): the file is a setup it accepts.
  const { readSetup } = (await import("node:module")).createRequire(import.meta.url)("../desktop/policy.cjs");
  const setup = readSetup(JSON.parse(readFileSync(path.join(path.dirname(m.recordPath()), "setup.json"), "utf8")));
  assert.equal(setup.ok, true, setup.error);
  assert.deepEqual([setup.summary.origin, setup.summary.accessOrigin, setup.summary.domainCount], ["https://fabric-inbox.me.workers.dev", "https://me.cloudflareaccess.com", 0]);
  const two = { ...deployer, accounts: async () => [{ id: "a", name: "A" }, { id: "b", name: "B" }] };
  await assert.rejects(m.stepServer({}, { say, deployer: two, token: "t", bundle: async () => "/b" }), (e: any) => e.code === "choose_account");
});

test("connect: the app's answer reaches only the one-shot listener with the right state, and the key goes to the store", async () => {
  const store = fakeStore();
  const open = (link: string) => {
    const url = new URL(link);
    const callback = url.searchParams.get("callback")!;
    assert.match(callback, /^http:\/\/127\.0\.0\.1:\d+\/fabric-inbox\/callback$/);
    assert.equal(url.searchParams.get("level"), "mail");
    setTimeout(async () => {
      const wrong = await fetch(callback, { method: "POST", body: JSON.stringify({ state: "x".repeat(32), outcome: "connected" }) });
      assert.equal(wrong.status, 400, "another request id is refused");
      await fetch(callback, { method: "POST", body: JSON.stringify({ state: url.searchParams.get("state"), outcome: "connected",
        server: "https://fabric-inbox.me.workers.dev", mcpUrl: "https://fabric-inbox.me.workers.dev/mcp",
        key: { id: "k1", clientId: "abc.access", level: "mail", send: "drafts", expiresAt: null }, clientSecret: "s3cret" }) });
    }, 20);
  };
  events.length = 0;
  const record = await m.stepConnect({}, { say, store, open });
  assert.deepEqual(store.items.get("fabric-inbox.me.workers.dev"), { clientId: "abc.access", clientSecret: "s3cret" });
  assert.equal(record.key.id, "k1");
  assert.ok(!readFileSync(m.recordPath(), "utf8").includes("s3cret"), "the record holds no secret");
  assert.ok(!JSON.stringify(events).includes("s3cret"), "no event carries the secret");
  assert.match(events[0].human, /Allow/);

  const denied = (link: string) => { const u = new URL(link); setTimeout(() => fetch(u.searchParams.get("callback")!, { method: "POST", body: JSON.stringify({ state: u.searchParams.get("state"), outcome: "denied" }) }), 10); };
  await assert.rejects(m.stepConnect({}, { say, store: fakeStore(), open: denied }), (e: any) => e.code === "denied");
  await assert.rejects(m.stepConnect({}, { say, store: fakeStore(), open: () => {}, timeoutMs: 50 }), (e: any) => e.code === "timeout");
});

test("register: Claude Code gets the URL and a headersHelper; the secret is in neither", async () => {
  const calls: string[][] = [];
  events.length = 0;
  const entry = await m.stepRegister({}, { say, exec: async (_f: string, args: string[]) => { calls.push(args); return ""; } });
  const add = calls.find((a) => a[1] === "add-json")!;
  assert.deepEqual(add.slice(0, 5), ["mcp", "add-json", "--scope", "user", "fabric-inbox"]);
  const json = JSON.parse(add[5]);
  assert.equal(json.url, "https://fabric-inbox.me.workers.dev/mcp");
  assert.match(json.headersHelper, /PassionCode\/fabric-inbox\/headers\.mjs' --server 'https:\/\/fabric-inbox\.me\.workers\.dev'$/,
    "the helper is a stable copy beside the record, so a plugin update never moves it");
  assert.ok(existsSync(m.helperPath()), "the helper was copied there");
  assert.ok(!add.join(" ").includes("s3cret"));
  assert.deepEqual(entry, json);
  const other = async (_f: string, args: string[]) => (args[1] === "get" ? "fabric-inbox: https://someone-else.example/mcp (HTTP)" : "");
  await assert.rejects(m.stepRegister({}, { say, exec: other }), (e: any) => e.code === "exists", "another server's entry of that name is not overwritten");
  const removed: string[][] = [];
  await m.stepRegister({ replace: true }, { say, exec: async (f: string, args: string[]) => { removed.push(args); return other(f, args); } });
  assert.ok(removed.some((a) => a[1] === "remove"), "--replace replaces it");
});

test("headers: what the headersHelper prints is exactly the two Access headers from the store", async () => {
  const store = fakeStore();
  await store.put("fabric-inbox.me.workers.dev", { clientId: "abc.access", clientSecret: "s3cret" });
  assert.deepEqual(await m.headers({ server: "https://fabric-inbox.me.workers.dev" }, { store }),
    { "CF-Access-Client-Id": "abc.access", "CF-Access-Client-Secret": "s3cret" });
  assert.deepEqual(await m.headers({}, { store, env: { CLAUDE_CODE_MCP_SERVER_URL: "https://fabric-inbox.me.workers.dev/mcp" } }),
    { "CF-Access-Client-Id": "abc.access", "CF-Access-Client-Secret": "s3cret" }, "the server comes from the record or Claude Code's own variable");
  await assert.rejects(m.headers({ server: "https://other.example" }, { store }), (e: any) => e.code === "no_key");
});

test("status: each step done or to do, for a launcher, with no secret", async () => {
  const store = fakeStore();
  await store.put("fabric-inbox.me.workers.dev", { clientId: "abc.access", clientSecret: "s3cret" });
  const s = await m.status({ store, exec: async () => "fabric-inbox: https://fabric-inbox.me.workers.dev/mcp (HTTP)" });
  assert.deepEqual(s.steps.map((x: any) => `${x.step}:${x.outcome}`), ["server:done", "connect:done", "register:done"]);
  assert.ok(!JSON.stringify(s).includes("s3cret"));
});

test("prove: initialize, tools/list and list_accounts with the stored key, JSON or event-stream answers", async () => {
  const store = fakeStore();
  await store.put("fabric-inbox.me.workers.dev", { clientId: "abc.access", clientSecret: "s3cret" });
  const seen: { method: string; id?: string; secret: string | null }[] = [];
  const doFetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ method: body.method, secret: init.headers["CF-Access-Client-Secret"] });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fabric-inbox", version: "0.14.1" } }
      : body.method === "tools/list" ? { tools: Array.from({ length: 89 }, (_, i) => ({ name: `t${i}` })) }
      : { content: [{ type: "text", text: JSON.stringify({ accounts: [{}, {}, {}] }) }] };
    const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    return body.method === "tools/list"
      ? new Response(`event: message\ndata: ${msg}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : new Response(msg, { headers: { "content-type": "application/json" } });
  };
  events.length = 0;
  assert.deepEqual(await m.stepProve({}, { say, store, doFetch }), { tools: 89, accounts: 3 });
  assert.deepEqual(seen.map((x) => x.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.ok(seen.every((x) => x.secret === "s3cret"));
  assert.ok(!JSON.stringify(events).includes("s3cret"));
  const refused = async () => new Response("no", { status: 403 });
  await assert.rejects(m.stepProve({}, { say, store, doFetch: refused }), (e: any) => e.code === "prove" && /not accepted/.test(e.message));
  const redirected = async () => new Response(null, { status: 302, headers: { location: "https://me.cloudflareaccess.com/login" } });
  await assert.rejects(m.stepProve({}, { say, store, doFetch: redirected }), (e: any) => /redirected/.test(e.message), "an Access login redirect is a refused key, not an answer");
});
