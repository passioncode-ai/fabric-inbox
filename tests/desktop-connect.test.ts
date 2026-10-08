// Connecting a local hub (Fabric) to Fabric Inbox by the product's own consent (ADR-0115 §4 in
// passioncode-ai/fabric): a link asks, a person allows in this app, the app makes the key with the
// owner's own session and hands it to a loopback callback — and takes it back if nobody received it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseConnectLink, promptFor, connect, mintWith, deliverTo, listenerWith, attendWith, pauseFor, PROMPT_POLL_MS, PROMPT_DEADLINE_MS } = require("../desktop/connect.cjs");

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

const HUB = { pid: 4242, name: "Fabric", path: "/Applications/Fabric.app/Contents/MacOS/Fabric" };

test("the prompt names the app that will receive the key, what it may do in plain words, and Deny is the default", () => {
  const p = promptFor(parseConnectLink(link({ level: "mail" })).value, config, HUB);
  assert.equal(p.title, "Connect Fabric?");
  assert.match(p.message, /Fabric asks to work with your mail on inbox\.example\.com/);
  assert.match(p.detail, /Mail/);
  assert.match(p.detail, /calls itself “Fabric” and listens on this Mac as Fabric \(process 4242\)/);
  assert.match(p.detail, /sent only to that process/);
  assert.match(p.detail, /Agent access/);
  assert.deepEqual(p.buttons, ["Deny", "Allow"]);
  assert.equal(p.defaultId, 0);
  assert.equal(p.cancelId, 0);
  assert.equal(p.checkboxLabel, undefined, "a Mail key needs no extra tick");
});

test("the prompt shows the real process when the link's own name differs from it", () => {
  const p = promptFor(parseConnectLink(link({ client: "Fabric" })).value, config, { pid: 77, name: "Terminal", path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" });
  assert.match(p.message, /^Terminal asks/, "the name a person sees is the listening app's, not the link's");
  assert.match(p.detail, /calls itself “Fabric” and listens on this Mac as Terminal \(process 77\)/);
});

test("an Admin key is a warning that needs the person's own tick", () => {
  const p = promptFor(request(), config, HUB);
  assert.equal(p.type, "warning");
  assert.match(p.detail, /addresses and domains/);
  assert.equal(p.checkboxLabel, "I started this connection from Fabric");
  assert.equal(p.checkboxChecked, false);
});

/** A fake world: what was minted, revoked, delivered and logged. */
function world(over: Partial<Record<"mint" | "deliver" | "revoke" | "confirm" | "identify" | "sleep" | "pause" | "self", unknown>> = {}) {
  const seen = { minted: [] as unknown[], revoked: [] as string[], delivered: [] as Record<string, unknown>[], logs: [] as string[], signIn: 0, slept: 0, prompts: [] as Record<string, unknown>[] };
  const deps = {
    confirm: async (prompt: Record<string, unknown>) => { seen.prompts.push(prompt); return { response: 1, checkboxChecked: true }; },
    identify: async () => HUB,
    sleep: async () => { seen.slept++; },
    self: 1,
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
  const { seen, deps } = world({ confirm: async () => ({ response: 0, checkboxChecked: false }) });
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

test("Allow on an Admin request without the tick is a Deny", async () => {
  const { seen, deps } = world({ confirm: async () => ({ response: 1, checkboxChecked: false }) });
  const out = await connect({ request: request(), config, ...deps });
  assert.equal(out.outcome, "denied");
  assert.deepEqual(seen.minted, []);
  assert.deepEqual(seen.delivered, [{ state: STATE, outcome: "denied" }]);
  assert.ok(seen.logs.some((l) => l.includes("admin_not_confirmed")));
});

test("when nothing listens on the callback, nothing is asked or made, after a short wait", async () => {
  const { seen, deps } = world({ identify: async () => null });
  const out = await connect({ request: request(), config, ...deps });
  assert.deepEqual([out.outcome, out.reason], ["failed", "no_listener"]);
  assert.equal(seen.prompts.length, 0);
  assert.deepEqual(seen.minted, []);
  assert.deepEqual(seen.delivered, []);
  assert.equal(seen.slept, 5, "five one-second waits for a hub that binds its port late");
  let calls = 0;
  const late = world({ identify: async () => (++calls >= 3 ? HUB : null) });
  assert.equal((await connect({ request: request(), config, ...late.deps })).outcome, "connected");
});

test("a callback held by this app itself is refused", async () => {
  const { seen, deps } = world({ self: HUB.pid });
  const out = await connect({ request: request(), config, ...deps });
  assert.deepEqual([out.outcome, out.reason], ["failed", "listener_is_self"]);
  assert.deepEqual(seen.minted, []);
});

test("a key is revoked, not delivered, when another process took the port meanwhile", async () => {
  let calls = 0;
  const { seen, deps } = world({ identify: async () => (++calls === 1 ? HUB : { pid: 999, name: "Other", path: "/tmp/other" }) });
  const out = await connect({ request: request(), config, ...deps });
  assert.deepEqual([out.outcome, out.reason], ["failed", "listener_changed"]);
  assert.deepEqual(seen.revoked, ["tok-9"]);
  assert.deepEqual(seen.delivered, []);
});

test("a listener_changed failure is told in words: the key was made, could not reach the app, and was revoked (B2)", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  assert.match(main, /out\.reason === 'listener_changed' \? \(out\.revoked \? t\('The key was made but could not reach \{client\}, and was revoked again\.'/);
  assert.match(main, /The key was made but could not reach \{client\}, and it could not be revoked: revoke it in Settings → Agent access\./);
});

// A prompt must not outlive its requester (observed 2026-10-08: a sheet on a background window sat
// unseen for 10 minutes while both hubs' listeners timed out and a second link queued behind it).
/** A prompt nobody answers: it ends only when its signal closes it, as Electron's does. */
const unanswered = (prompts: unknown[], onClose = { response: 0, checkboxChecked: false }) =>
  async (prompt: unknown, { signal }: { signal: AbortSignal }) => {
    prompts.push(prompt);
    await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
    return onClose;
  };

test("the prompt closes itself when the requester stops listening: nothing is made or sent, and the log says so", async () => {
  let calls = 0;
  const prompts: unknown[] = [];
  let pauses = 0;
  const { seen, deps } = world({
    identify: async () => (++calls === 1 ? HUB : null),
    pause: async (ms: number) => { assert.equal(ms, PROMPT_POLL_MS); pauses++; },
    // Even an Allow racing the close is not taken: the requester is gone.
    confirm: unanswered(prompts, { response: 1, checkboxChecked: true }),
  });
  const out = await connect({ request: request(), config, ...deps });
  assert.deepEqual([out.outcome, out.reason, out.abandoned], ["failed", "no_listener", true]);
  assert.equal(prompts.length, 1, "the person was asked once");
  assert.equal(pauses, 2, "two misses in a row, one poll apart, close it");
  assert.deepEqual(seen.minted, []);
  assert.deepEqual(seen.delivered, [], "nobody listens, so nothing is posted");
  assert.ok(seen.logs.some((l) => l.includes('"connect.abandoned"') && l.includes("no_listener")));
});

test("one missed lookup does not close the prompt; the person's answer still counts", async () => {
  const answers = [null, HUB, HUB];
  let calls = 0;
  let answer!: (value: unknown) => void;
  const answered = new Promise((resolve) => { answer = resolve; });
  let pauses = 0;
  const { seen, deps } = world({
    identify: async () => (++calls === 1 ? HUB : answers.shift() ?? HUB),
    pause: async () => { if (++pauses === 3) answer({ response: 1, checkboxChecked: true }); },
    confirm: async () => answered,
  });
  const out = await connect({ request: request(), config, ...deps });
  assert.equal(out.outcome, "connected");
  assert.equal(seen.delivered.length, 1);
});

test("another process taking the port closes the prompt at once", async () => {
  let calls = 0;
  const prompts: unknown[] = [];
  const { seen, deps } = world({
    identify: async () => (++calls === 1 ? HUB : { pid: 999, name: "Other", path: "/tmp/other" }),
    pause: async () => {},
    confirm: unanswered(prompts),
  });
  const out = await connect({ request: request(), config, ...deps });
  assert.deepEqual([out.outcome, out.reason], ["failed", "no_listener"]);
  assert.equal(calls, 2, "closed on the first look");
  assert.deepEqual(seen.delivered, []);
  assert.deepEqual(seen.minted, []);
});

test("a prompt nobody answers closes at the deadline, and the hub that still listens hears why", async () => {
  let pauses = 0;
  const prompts: unknown[] = [];
  const { seen, deps } = world({ pause: async () => { pauses++; }, confirm: unanswered(prompts) });
  const out = await connect({ request: request(), config, ...deps });
  assert.deepEqual([out.outcome, out.reason, out.abandoned], ["failed", "not_answered", true]);
  assert.equal(pauses, PROMPT_DEADLINE_MS / PROMPT_POLL_MS, "two minutes of three-second looks");
  assert.equal(PROMPT_DEADLINE_MS, 120000);
  assert.deepEqual(seen.delivered, [{ state: STATE, outcome: "failed", error: "not_answered" }]);
  assert.deepEqual(seen.minted, []);
  assert.ok(seen.logs.some((l) => l.includes('"connect.abandoned"') && l.includes("not_answered")));
});

test("an answer stops the watch: no lookup after it, no timer left behind", async () => {
  let calls = 0;
  const { deps } = world({ identify: async () => { calls++; return HUB; } });
  const started = Date.now();
  const out = await connect({ request: request(), config, ...deps });
  assert.equal(out.outcome, "connected");
  assert.equal(calls, 2, "one look before the prompt and the same-process check after Allow");
  assert.ok(Date.now() - started < PROMPT_POLL_MS, "the default wait ended with the answer");
  const controller = new AbortController();
  const waiting = pauseFor(60000, controller.signal);
  controller.abort();
  await waiting;
  await pauseFor(60000, controller.signal);
});

test("before the prompt the app comes forward: window restored and focused, app made active, the Dock bounces until answered", () => {
  const calls: string[] = [];
  const app = {
    focus: (options?: { steal?: boolean }) => calls.push(`app.focus ${JSON.stringify(options ?? null)}`),
    dock: { bounce: (type: string) => { calls.push(`bounce ${type}`); return 7; }, cancelBounce: (id: number) => calls.push(`cancel ${id}`) },
  };
  const win = { isDestroyed: () => false, isMinimized: () => true, restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus") };
  const stop = attendWith(app, "darwin")(win);
  assert.deepEqual(calls, ["restore", "show", "focus", 'app.focus {"steal":true}', "bounce critical"]);
  stop();
  assert.equal(calls.at(-1), "cancel 7");
  // No window and no Dock (not a Mac): still asks for focus, and nothing throws.
  const plain: string[] = [];
  attendWith({ focus: (o?: unknown) => plain.push(`focus ${JSON.stringify(o ?? null)}`) }, "linux")(null)();
  assert.deepEqual(plain, ["focus null"]);
  const throwing = { focus: () => { throw new Error("no"); }, dock: { bounce: () => { throw new Error("no"); }, cancelBounce: () => {} } };
  assert.doesNotThrow(() => attendWith(throwing, "darwin")({ isDestroyed: () => true })());
});

test("the desktop app shows the prompt on a window brought forward, closable by its signal, and no notice for a requester that left", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  assert.match(main, /confirm: async \(prompt, \{ signal \} = \{\}\) => \{\n\s+const owner = promptWindow\(\);\n\s+const stop = attend\(owner\);/);
  assert.match(main, /dialog\.showMessageBox\(owner, \{ type: 'question', \.\.\.prompt, signal \}\)/);
  assert.match(main, /finally \{ stop\(\); \}/);
  assert.match(main, /if \(out\.reason === 'no_listener' \|\| out\.reason === 'not_answered'\) return;/);
});

test("the listener is read from lsof and ps: the app bundle's name, else the command", async () => {
  const runs: string[] = [];
  const exec = async (file: string, args: string[]) => {
    runs.push(`${file} ${args.join(" ")}`);
    if (file.endsWith("lsof")) return { stdout: "p4242\ncFabric\n" };
    return { stdout: "/Applications/Fabric.app/Contents/MacOS/Fabric\n" };
  };
  assert.deepEqual(await listenerWith(exec)(47123), { pid: 4242, name: "Fabric", path: "/Applications/Fabric.app/Contents/MacOS/Fabric" });
  assert.match(runs[0], /^\/usr\/sbin\/lsof -nP -iTCP:47123 -sTCP:LISTEN -Fpc$/);
  const bare = listenerWith(async (file: string) => (file.endsWith("lsof") ? { stdout: "p51\ncnode\n" } : { stdout: "/opt/homebrew/bin/node\n" }));
  assert.deepEqual(await bare(1), { pid: 51, name: "node", path: "/opt/homebrew/bin/node" });
  assert.equal(await listenerWith(async () => { throw Object.assign(new Error("exit 1"), { code: 1 }); })(1), null, "lsof finds nothing: exit 1");
  assert.equal(await listenerWith(async () => ({ stdout: "" }))(1), null);
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
