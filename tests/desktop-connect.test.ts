// Connecting a local hub (Fabric) to Fabric Inbox by the product's own consent (ADR-0115 §4 in
// passioncode-ai/fabric): a link asks, a person allows in this app, the app makes the key with the
// owner's own session and hands it to a loopback callback — and takes it back if nobody received it.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseConnectLink, promptFor, connect, mintWith, deliverTo } = require("../desktop/connect.cjs");

const STATE = "s".repeat(32);
const link = (over: Record<string, string> = {}) => {
  const q = new URLSearchParams({ client: "Fabric", client_id: "fabric", level: "admin", callback: "http://127.0.0.1:47123/fabric/v1/connect/fabric-inbox", state: STATE, ...over });
  return `fabric-inbox://connect?${q}`;
};
const config = { origin: "https://inbox.example.com", accessOrigin: "" };

test("a connect link is read strictly: loopback callback, a known level, a single-use state", () => {
  const ok = parseConnectLink(link());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { client: "Fabric", clientId: "fabric", level: "admin", send: "send", callback: "http://127.0.0.1:47123/fabric/v1/connect/fabric-inbox", state: STATE });
  assert.equal(parseConnectLink(link({ level: "read" })).value.send, "drafts", "a Read key sends nothing");
  assert.equal(parseConnectLink(link({ level: "mail", send: "send" })).value.send, "send");
  for (const [field, value] of [
    ["callback", "https://evil.example/cb"], ["callback", "http://evil.example/cb"], ["callback", "http://127.0.0.1.evil.example:1/cb"],
    ["callback", "http://user:pw@127.0.0.1:1/cb"], ["callback", "http://127.0.0.1/cb"], ["callback", "file:///tmp/x"],
    ["level", "root"], ["state", "short"], ["state", "x".repeat(22) + "/"], ["client", ""], ["client", "a\nb"], ["client_id", "Fabric!"],
  ] as const) assert.equal(parseConnectLink(link({ [field]: value })).ok, false, `${field}=${value}`);
  assert.equal(parseConnectLink("fabric-inbox://other?x=1").ok, false);
  assert.equal(parseConnectLink("https://inbox.example.com/connect").ok, false);
  for (const host of ["localhost", "[::1]"]) assert.equal(parseConnectLink(link({ callback: `http://${host}:9/cb` })).ok, true, host);
});

test("the prompt names who asks, what it may do in plain words, where the key goes, and Deny is the default", () => {
  const p = promptFor(parseConnectLink(link()).value, config);
  assert.equal(p.title, "Connect Fabric?");
  assert.match(p.message, /Fabric asks to work with your mail on inbox\.example\.com/);
  assert.match(p.detail, /Admin/);
  assert.match(p.detail, /addresses and domains/);
  assert.match(p.detail, /only to this Mac \(127\.0\.0\.1:47123\)/);
  assert.match(p.detail, /Agent access/);
  assert.deepEqual(p.buttons, ["Deny", "Allow"]);
  assert.equal(p.defaultId, 0);
  assert.equal(p.cancelId, 0);
});

/** A fake world: what was minted, revoked, delivered and logged. */
function world(over: Partial<Record<"mint" | "deliver" | "revoke" | "confirm", unknown>> = {}) {
  const seen = { minted: [] as unknown[], revoked: [] as string[], delivered: [] as Record<string, unknown>[], logs: [] as string[], signIn: 0 };
  const deps = {
    confirm: async () => true,
    mint: async (input: unknown) => { seen.minted.push(input); return { ok: true, data: { key: { id: "tok-9", clientId: "cid.access", level: "admin", send: "send", expiresAt: "2027-10-03T00:00:00Z" }, clientSecret: "SECRET-VALUE", mcpUrl: "https://inbox.example.com/mcp" } }; },
    revoke: async (id: string) => { seen.revoked.push(id); return true; },
    deliver: async (body: Record<string, unknown>) => { seen.delivered.push(body); return true; },
    signIn: async () => { seen.signIn++; },
    log: (line: string) => seen.logs.push(line),
    ...over,
  };
  return { seen, deps };
}
const request = () => parseConnectLink(link()).value;

test("Allow makes the key with the owner's session and hands it to the callback once", async () => {
  const { seen, deps } = world();
  const out = await connect({ request: request(), config, ...deps });
  assert.equal(out.outcome, "connected");
  assert.deepEqual(seen.minted, [{ name: "Fabric", level: "admin", send: "send", duration: "1y" }]);
  assert.equal(seen.delivered.length, 1);
  assert.deepEqual(seen.delivered[0], { state: STATE, outcome: "connected", server: config.origin, mcpUrl: "https://inbox.example.com/mcp",
    key: { id: "tok-9", clientId: "cid.access", level: "admin", send: "send", expiresAt: "2027-10-03T00:00:00Z" }, clientSecret: "SECRET-VALUE" });
  assert.ok(!seen.logs.join("\n").includes("SECRET-VALUE"), "the secret is never logged");
});

test("Deny tells the hub and makes nothing", async () => {
  const { seen, deps } = world({ confirm: async () => false });
  const out = await connect({ request: request(), config, ...deps });
  assert.equal(out.outcome, "denied");
  assert.deepEqual(seen.minted, []);
  assert.deepEqual(seen.delivered, [{ state: STATE, outcome: "denied" }]);
});

test("a key nobody received is revoked at once, and the person is told", async () => {
  const { seen, deps } = world({ deliver: async (body: Record<string, unknown>) => body.outcome !== "connected" });
  const out = await connect({ request: request(), config, ...deps });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "callback_unreachable");
  assert.deepEqual(seen.revoked, ["tok-9"]);
});

test("a lapsed sign-in opens the mail window and the hub hears why, with no key made", async () => {
  const { seen, deps } = world({ mint: async () => ({ ok: false, signIn: true }) });
  const out = await connect({ request: request(), config, ...deps });
  assert.equal(out.outcome, "failed");
  assert.equal(out.reason, "sign_in_required");
  assert.equal(seen.signIn, 1);
  assert.deepEqual(seen.delivered, [{ state: STATE, outcome: "failed", error: "sign_in_required" }]);
});

test("with no server set up yet, nothing is asked and the hub hears why", async () => {
  const { seen, deps } = world();
  const out = await connect({ request: request(), config: null, ...deps });
  assert.equal(out.reason, "no_server");
  assert.deepEqual(seen.delivered, [{ state: STATE, outcome: "failed", error: "no_server" }]);
});

test("minting reads the server's answer: 201 is a key, a redirect or an HTML page is a lapsed sign-in", async () => {
  const fetches: { url: string; init: RequestInit }[] = [];
  const ses = (answer: Response) => ({ fetch: async (url: string, init: RequestInit) => { fetches.push({ url, init }); return answer; } });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const made = await mintWith(ses(json(201, { key: { id: "t" }, clientSecret: "x", mcpUrl: "u" })), config.origin)({ name: "Fabric", level: "admin", send: "send", duration: "1y" });
  assert.equal(made.ok, true);
  assert.equal(fetches[0]!.url, "https://inbox.example.com/api/agent-keys");
  assert.equal(fetches[0]!.init.method, "POST");
  assert.equal(fetches[0]!.init.redirect, "manual");
  assert.equal((await mintWith(ses(new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } })), config.origin)({} as never)).signIn, true);
  assert.equal((await mintWith(ses(new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } })), config.origin)({} as never)).signIn, true);
  const refused = await mintWith(ses(json(503, { error: "This server has no Cloudflare token" })), config.origin)({} as never);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /no Cloudflare token/);
});

test("delivery posts JSON to the loopback callback and counts only a 2xx within the time limit", async () => {
  const seen: { url: string; body: string }[] = [];
  const ok = deliverTo("http://127.0.0.1:9/cb", { fetch: async (url: string, init: RequestInit) => { seen.push({ url, body: String(init.body) }); return new Response("{}", { status: 200 }); } });
  assert.equal(await ok({ state: STATE, outcome: "denied" }), true);
  assert.equal(JSON.parse(seen[0]!.body).outcome, "denied");
  const bad = deliverTo("http://127.0.0.1:9/cb", { fetch: async () => new Response("no", { status: 500 }) });
  assert.equal(await bad({ state: STATE, outcome: "denied" }), false);
  const slow = deliverTo("http://127.0.0.1:9/cb", { timeoutMs: 20, fetch: (_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))) });
  assert.equal(await slow({ state: STATE, outcome: "denied" }), false);
});
