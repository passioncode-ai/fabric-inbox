import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CloudflareApi } from "../workers/routing/cloudflare-api";
import { rawMime } from "../workers/providers/gmail-client";
import {
  ensureUnsubscribeApp, handleUnsubscribe, oneClickUrl, tokenAddress, unsubscribeAppName, unsubscribeToken, UNSUBSCRIBE_PATH, UNSUBSCRIBE_POLICY,
} from "../workers/campaigns/unsubscribe";

/**
 * B-181 (SCN-090): one-click unsubscribe (RFC 8058). The token names one address and cannot be made without the
 * server's key; GET only asks, POST puts the address on the do-not-write list; the page is the only one outside Access;
 * the server makes its own Bypass application on <host>/u; the message carries both targets.
 */
const SECRET = "k".repeat(43);
const fakeCampaigns = () => {
  const calls: [string, string][] = [];
  return { calls, binding: { getByName: () => ({ unsubscribe: async (email: string, reason: string) => { calls.push([email, reason]); } }) } };
};

test("a token names its address, and a changed one or another server's key reads as nothing", async () => {
  const token = await unsubscribeToken(SECRET, "Ann@Acme.example");
  assert.match(`/u/${token}`, UNSUBSCRIBE_PATH);
  assert.equal(await tokenAddress(SECRET, token), "ann@acme.example");
  assert.equal(await tokenAddress("x".repeat(43), token), null, "another server's key");
  const [v, address, sig] = token.split(".");
  const other = Buffer.from("bob@acme.example").toString("base64url");
  assert.equal(await tokenAddress(SECRET, `${v}.${other}.${sig}`), null, "the signature of another address");
  assert.equal(await tokenAddress(SECRET, `${v}.${address}.${"A".repeat(22)}`), null);
  assert.equal(await tokenAddress(SECRET, "garbage"), null);
  assert.equal(await oneClickUrl({ MAIL_CREDENTIAL_KEY: SECRET }, "ann@acme.example", null), null, "no page yet: no one-click");
  assert.equal(await oneClickUrl({}, "ann@acme.example", { host: "inbox.owner.example", appId: "a", createdAt: "" }), null, "no key: no one-click");
  assert.equal(await oneClickUrl({ MAIL_CREDENTIAL_KEY: SECRET }, "ann@acme.example", { host: "inbox.owner.example", appId: "a", createdAt: "" }),
    `https://inbox.owner.example/u/${token}`);
});

test("GET only asks; POST (the page's button or a mail client's one click) unsubscribes; a bad token changes nothing", async () => {
  const token = await unsubscribeToken(SECRET, "ann@acme.example");
  const { calls, binding } = fakeCampaigns();
  const env = { MAIL_CREDENTIAL_KEY: SECRET, CAMPAIGNS: binding };
  const asked = await handleUnsubscribe(new Request(`https://x.example/u/${token}`), env, token);
  assert.equal(asked.status, 200);
  assert.match(await asked.text(), /Stop emails to ann@acme\.example\?[\s\S]*<form method="post">/);
  assert.deepEqual(calls, [], "a link scanner opening it unsubscribes nobody");
  assert.equal(asked.headers.get("cache-control"), "no-store");
  assert.match(asked.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const oneClick = await handleUnsubscribe(new Request(`https://x.example/u/${token}`, { method: "POST", body: "List-Unsubscribe=One-Click",
    headers: { "content-type": "application/x-www-form-urlencoded" } }), env, token);
  assert.equal(oneClick.status, 200);
  assert.deepEqual(calls, [["ann@acme.example", "one_click_unsubscribe"]]);
  const ru = await handleUnsubscribe(new Request(`https://x.example/u/${token}`, { headers: { "accept-language": "ru-RU,ru;q=0.9" } }), env, token);
  assert.match(await ru.text(), /lang="ru"[\s\S]*ann@acme\.example/);
  const bad = await handleUnsubscribe(new Request("https://x.example/u/1.YWJj.AAAAAAAAAAAAAAAAAAAAAA", { method: "POST" }), env, "1.YWJj.AAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(bad.status, 404);
  assert.equal(calls.length, 1);
  assert.equal((await handleUnsubscribe(new Request(`https://x.example/u/${token}`), { CAMPAIGNS: binding }, token)).status, 503, "no key on the server");
});

test("the page is the only one served before Access, and only for a token's shape", () => {
  const source = readFileSync(new URL("../workers/app.ts", import.meta.url), "utf8");
  const page = source.indexOf('app.use("/u/*"'), access = source.indexOf("// Cloudflare Access JWT validation middleware");
  assert.ok(page > 0 && page < access, "before the Access check");
  assert.match(source, /const match = UNSUBSCRIBE_PATH\.exec\(c\.req\.path\);\s*return match \? handleUnsubscribe\(c\.req\.raw, c\.env, match\[1\]!\) : next\(\);/);
  for (const path of ["/u/", "/u/x", "/u/1.abc", "/u/../api/members", "/api/campaigns", "/u/1.YWJjZA.short"]) assert.equal(UNSUBSCRIBE_PATH.test(path), false, path);
});

test("the server makes its Bypass application on <host>/u once, with an everyone policy, and touches no other application", async () => {
  const state = { apps: [{ id: "app1", name: "fabric-inbox", domain: "inbox.owner.example" }] as Record<string, unknown>[], policies: [] as Record<string, unknown>[], posts: [] as string[] };
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace("/client/v4", ""), method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") state.posts.push(`${method} ${path}`);
    if (path === "/accounts/acc/access/apps" && method === "GET") return ok(state.apps);
    if (path === "/accounts/acc/access/apps" && method === "POST") { const a = { id: "app2", ...body }; state.apps.push(a); return ok(a); }
    if (path === "/accounts/acc/access/policies" && method === "GET") return ok(state.policies);
    if (path === "/accounts/acc/access/policies" && method === "POST") { const p = { id: "pol1", ...body }; state.policies.push(p); return ok(p); }
    return new Response(JSON.stringify({ success: false, errors: [{ message: `unexpected ${method} ${path}` }] }), { status: 404 });
  };
  const api = new CloudflareApi("t", fetcher as typeof fetch);
  const made = await ensureUnsubscribeApp(api, "acc", "inbox.owner.example");
  assert.equal(made.state, "created");
  assert.deepEqual(state.policies[0], { id: "pol1", name: UNSUBSCRIBE_POLICY, decision: "bypass", include: [{ everyone: {} }] });
  const app = state.apps[1]!;
  assert.deepEqual([app.name, app.domain, app.type, app.policies], [unsubscribeAppName("inbox.owner.example"), "inbox.owner.example/u", "self_hosted", [{ id: "pol1", precedence: 1 }]]);
  assert.equal((await ensureUnsubscribeApp(api, "acc", "inbox.owner.example")).state, "already");
  assert.deepEqual(state.posts, ["POST /accounts/acc/access/policies", "POST /accounts/acc/access/apps"], "nothing else changed, once");
});

test("a campaign message carries both targets, and the one-click header only with an https one", () => {
  const base = { to: ["ann@acme.example"], subject: "Hi", text: "Hello" };
  const both = rawMime("me@owner.example", { ...base, listUnsubscribe: ["https://inbox.owner.example/u/1.a.b", "mailto:me@owner.example?subject=unsubscribe"] });
  assert.match(both, /\r\nList-Unsubscribe: <https:\/\/inbox\.owner\.example\/u\/1\.a\.b>, <mailto:me@owner\.example\?subject=unsubscribe>\r\n/);
  assert.match(both, /\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n/);
  const reply = rawMime("me@owner.example", { ...base, listUnsubscribe: ["mailto:me@owner.example?subject=unsubscribe"] });
  assert.match(reply, /List-Unsubscribe: <mailto:/);
  assert.doesNotMatch(reply, /List-Unsubscribe-Post/);
  assert.doesNotMatch(rawMime("me@owner.example", { ...base, listUnsubscribe: ["javascript:x", "https://a b"] }), /List-Unsubscribe/, "anything else is dropped");
  assert.doesNotMatch(rawMime("me@owner.example", base), /List-Unsubscribe/);
});
