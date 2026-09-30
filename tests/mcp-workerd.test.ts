import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * The agent protocol end to end in workerd (AP-1..AP-6): a real MCP client over Streamable HTTP,
 * the real handler, tools calling the app's routes in-process, real MailboxDOs and the ledger.
 * Access is outside the Worker, so the test hands the handler the claims Access would have verified.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      import { handleMcp } from './workers/mcp/handler';
      export { EmailMCP } from './workers/mcp/ledger';
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) {
          super(ctx, { ...env, AI: { run: () => { throw new Error('no AI in this test'); } }, EMAIL: { send: async (m) => {
            const sent = (await ctx.storage.get('test:sent')) || []; await ctx.storage.put('test:sent', [...sent, { to: m.to, subject: m.subject }]);
            return { messageId: '<sent-' + sent.length + '@cloudflare.invalid>' };
          } } });
        }
        async testSent() { return (await this.ctx.storage.get('test:sent')) || []; }
        async testInbox(sender, subject) { const id = 'in-' + crypto.randomUUID(); await this.createEmail('inbox', { id, subject, sender, recipient: this.ctx.id.name ?? 'me', date: new Date().toISOString(), body: 'hello' }, []); return id; }
      }
      export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname === '/mcp') {
            const claims = request.headers.get('x-test-claims');
            return handleMcp(request, env, ctx, claims ? JSON.parse(claims) : null);
          }
          if (url.pathname === '/test/sent') {
            const m = url.searchParams.get('mailbox');
            return Response.json(await env.MAILBOX.get(env.MAILBOX.idFromName(m)).testSent());
          }
          if (url.pathname === '/test/inbox') { const b = await request.json(); return Response.json({ id: await env.MAILBOX.get(env.MAILBOX.idFromName(b.mailbox)).testInbox(b.sender, b.subject) }); }
          if (url.pathname === '/test/put') { const b = await request.json(); await env.BUCKET.put(b.key, JSON.stringify(b.value)); return Response.json({ ok: true }); }
          return new Response('not found', { status: 404 });
        },
      };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  // As wrangler builds it: workerd's own modules stay imports, and mimetext takes its runtime-neutral build.
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:*", "node:*"], target: "es2022",
  alias: { mimetext: "mimetext/browser" },
  define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": '"test"' },
});

const MAILBOX = "support@shop.invalid";
const KEYS = [
  { id: "k-read", clientId: "read.access", name: "Reader", level: "read", send: "drafts", dailySendLimit: 50, createdAt: "2026-09-29T00:00:00Z", expiresAt: null },
  { id: "k-drafts", clientId: "drafts.access", name: "Drafter", level: "mail", send: "drafts", dailySendLimit: 50, createdAt: "2026-09-29T00:00:00Z", expiresAt: null },
  { id: "k-send", clientId: "send.access", name: "Sender", level: "mail", send: "send", dailySendLimit: 1, createdAt: "2026-09-29T00:00:00Z", expiresAt: null },
  { id: "k-admin", clientId: "admin.access", name: "Admin", level: "admin", send: "send", dailySendLimit: 50, createdAt: "2026-09-29T00:00:00Z", expiresAt: null },
  { id: "k-old", clientId: "old.access", name: "Old", level: "admin", send: "send", dailySendLimit: 50, createdAt: "2025-01-01T00:00:00Z", expiresAt: "2025-06-01T00:00:00Z" },
];

async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true }, EMAIL_MCP: { className: "EmailMCP", useSQLite: true } },
    r2Buckets: ["BUCKET"], bindings: { DOMAINS: "shop.invalid", EMAIL_ADDRESSES: MAILBOX },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const put = (key: string, value: unknown) => mf.dispatchFetch("http://localhost/test/put", { method: "POST", body: JSON.stringify({ key, value }) });
  await put(`mailboxes/${MAILBOX}.json`, { agent: "off", fromName: "Shop support", signature: { enabled: true, text: "— Shop" } });
  await put("config/agent-keys.json", { keys: KEYS });
  const connect = async (claims: Record<string, unknown> | null) => {
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: ((url: string | URL, init?: RequestInit) => mf.dispatchFetch(String(url), init as never)) as typeof fetch,
      requestInit: { headers: claims ? { "x-test-claims": JSON.stringify(claims) } : {} },
    });
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(transport);
    return client;
  };
  const as = (clientId: string) => connect({ common_name: clientId, sub: "" });
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
  };
  const sent = async () => (await (await mf.dispatchFetch(`http://localhost/test/sent?mailbox=${MAILBOX}`)).json()) as { to: string; subject: string }[];
  return { mf, connect, as, call, sent };
}

const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

test("an unknown service token, an expired key and no identity are refused before any tool (AP-1)", async () => {
  const { mf, connect } = await fixture();
  try {
    await assert.rejects(connect({ common_name: "stranger.access", sub: "" }), /not an agent key|403/);
    await assert.rejects(connect({ common_name: "old.access", sub: "" }), /not an agent key|403/);
    await assert.rejects(connect(null), /not an agent key|403/);
  } finally { await mf.dispose(); }
});

test("each level sees only its tools, and a Drafts only key sees no sending tool (AP-2, AP-3)", async () => {
  const { mf, as, connect } = await fixture();
  try {
    const read = await names(await as("read.access"));
    assert.ok(read.includes("list_messages") && read.includes("read_message"));
    for (const t of ["save_draft", "send_email", "move_messages", "create_address", "empty_spam"]) assert.ok(!read.includes(t), `read key must not see ${t}`);
    const drafts = await names(await as("drafts.access"));
    assert.ok(drafts.includes("save_draft") && drafts.includes("move_messages"));
    for (const t of ["send_email", "reply", "forward", "approve_rule_run", "create_address"]) assert.ok(!drafts.includes(t), `drafts-only key must not see ${t}`);
    const sender = await names(await as("send.access"));
    assert.ok(sender.includes("send_email") && sender.includes("reply") && !sender.includes("create_address"));
    const owner = await names(await connect({ email: "owner@shop.invalid" }));
    const admin = await names(await as("admin.access"));
    assert.deepEqual(admin.sort(), owner.sort(), "an admin key sees what the owner sees");
    assert.ok(admin.includes("remove_address") && admin.includes("save_agent"));
    const readClient = await as("read.access");
    const refused = (await readClient.callTool({ name: "send_email", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(refused.isError, true, "a tool outside the key's level cannot be called either");
    assert.match(refused.content[0]!.text, /not found/i);
  } finally { await mf.dispose(); }
});

test("an agent drafts, sends once per key per day, and every change is journalled with its key (AP-3, AP-6)", async () => {
  const { mf, as, call, sent } = await fixture();
  try {
    const drafter = await as("drafts.access");
    const draft = await call(drafter, "save_draft", { accountId: `cloudflare:${MAILBOX}`, to: "ann@customer.invalid", subject: "Your order", text: "It ships Monday." });
    assert.equal(draft.isError, false, JSON.stringify(draft.data));
    const drafts = await call(drafter, "list_mailbox_messages", { accountId: `cloudflare:${MAILBOX}`, folder: "draft" });
    assert.equal(drafts.data.messages.length, 1);
    assert.deepEqual(await sent(), [], "a draft sends nothing");

    const sender = await as("send.access");
    const first = await call(sender, "send_email", { accountId: `cloudflare:${MAILBOX}`, to: "ann@customer.invalid", subject: "Shipped", text: "On its way.", idempotencyKey: "order-1-shipped" });
    assert.equal(first.isError, false, JSON.stringify(first.data));
    assert.equal((await sent()).length, 1);
    const second = await call(sender, "send_email", { accountId: `cloudflare:${MAILBOX}`, to: "bob@customer.invalid", subject: "Hi", text: "Hello.", idempotencyKey: "hello-bob" });
    assert.equal(second.isError, true);
    assert.match(second.data.error, /sent its 1 messages for today/);
    assert.equal((await sent()).length, 1, "the limit held");

    const admin = await as("admin.access");
    const journal = await call(admin, "list_agent_activity", {});
    const rows = journal.data.entries.map((e: { callerLabel: string; tool: string; outcome: string }) => `${e.callerLabel} ${e.tool} ${e.outcome}`);
    assert.ok(rows.includes("Drafter save_draft done"), rows.join("\n"));
    assert.ok(rows.includes("Sender send_email done"));
    assert.ok(rows.includes("Sender send_email refused"));
    assert.ok(!rows.some((r: string) => r.includes("list_mailbox_messages")), "reading is not journalled");
  } finally { await mf.dispose(); }
});

test("a refused send gives its allowance back", async () => {
  const { mf, as, call } = await fixture();
  try {
    const sender = await as("send.access");
    const bad = await call(sender, "send_email", { accountId: "cloudflare:nobody@shop.invalid", to: "ann@customer.invalid", subject: "x", text: "x", idempotencyKey: "k1" });
    assert.equal(bad.isError, true);
    const good = await call(sender, "send_email", { accountId: `cloudflare:${MAILBOX}`, to: "ann@customer.invalid", subject: "x", text: "x", idempotencyKey: "k2" });
    assert.equal(good.isError, false, JSON.stringify(good.data));
  } finally { await mf.dispose(); }
});

test("an irreversible action takes two calls, and its code works once, for the same key and arguments (AP-4)", async () => {
  const { mf, as, call } = await fixture();
  try {
    const admin = await as("admin.access");
    const draft = await call(admin, "save_draft", { accountId: `cloudflare:${MAILBOX}`, to: "ann@customer.invalid", subject: "Delete me", text: "x" });
    const other = await call(admin, "save_draft", { accountId: `cloudflare:${MAILBOX}`, to: "ann@customer.invalid", subject: "Keep me", text: "y" });
    const args = { accountId: `cloudflare:${MAILBOX}`, messageId: draft.data.id };
    const asked = await call(admin, "delete_message", args);
    assert.equal(asked.data.needsConfirmation, true);
    assert.match(asked.data.summary, /Delete for good the message "Delete me"/);
    const listed = async () => (await call(admin, "list_mailbox_messages", { accountId: `cloudflare:${MAILBOX}`, folder: "draft" })).data.messages.map((m: { subject: string }) => m.subject).sort();
    assert.deepEqual(await listed(), ["Delete me", "Keep me"], "the first call changes nothing");

    const wrongArgs = await call(admin, "delete_message", { accountId: `cloudflare:${MAILBOX}`, messageId: other.data.id, confirm: asked.data.confirm });
    assert.equal(wrongArgs.isError, true, "a code is for the arguments it was issued for");
    const otherKey = await as("drafts.access");
    const wrongKey = await call(otherKey, "delete_message", { ...args, confirm: asked.data.confirm });
    assert.equal(wrongKey.isError, true, "a code is for the key it was issued to");
    assert.deepEqual(await listed(), ["Delete me", "Keep me"]);

    const done = await call(admin, "delete_message", { ...args, confirm: asked.data.confirm });
    assert.equal(done.isError, false, JSON.stringify(done.data));
    assert.deepEqual(await listed(), ["Keep me"]);
    const again = await call(admin, "delete_message", { ...args, confirm: asked.data.confirm });
    assert.equal(again.isError, true, "a code works once");
  } finally { await mf.dispose(); }
});

test("an agent reads what the app shows: accounts, the feed, one message, with the address's signature on what it wrote (AP-5)", async () => {
  const { mf, as, call } = await fixture();
  try {
    const admin = await as("admin.access");
    const accounts = await call(admin, "list_accounts", {});
    assert.equal(accounts.isError, false, JSON.stringify(accounts.data));
    assert.deepEqual(accounts.data.accounts.map((a: { accountId: string }) => a.accountId), [`cloudflare:${MAILBOX}`]);
    const draft = await call(admin, "save_draft", { accountId: `cloudflare:${MAILBOX}`, to: "ann@customer.invalid", subject: "Signed", text: "Body line" });
    const read = await call(admin, "read_message", { accountId: `cloudflare:${MAILBOX}`, messageId: draft.data.id });
    assert.equal(read.isError, false, JSON.stringify(read.data));
    assert.match(read.data.text, /Body line\s+— Shop/);
    const bad = await call(admin, "read_message", { accountId: "not-an-account", messageId: "x" });
    assert.equal(bad.isError, true);
    assert.match(bad.data.error, /cloudflare:<address>/);
  } finally { await mf.dispose(); }
});

test("a web page the owner visits cannot use their sign-in to call tools: foreign Origin, a simple request or a GET is refused (review 1, 13)", async () => {
  const { mf } = await fixture();
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const owner = JSON.stringify({ email: "owner@shop.invalid" });
    const send = (headers: Record<string, string>, method = "POST") =>
      mf.dispatchFetch("http://localhost/mcp", { method, headers: { "x-test-claims": owner, Accept: "application/json, text/event-stream", ...headers }, ...(method === "POST" ? { body } : {}) });
    const foreign = await send({ "Content-Type": "application/json", Origin: "https://evil.example" });
    assert.equal(foreign.status, 403); await foreign.text();
    const crossSite = await send({ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" });
    assert.equal(crossSite.status, 403); await crossSite.text();
    const simple = await send({ "Content-Type": "text/plain;application/json" });
    assert.equal(simple.status, 415); await simple.text();
    const get = await send({}, "GET");
    assert.equal(get.status, 405); await get.text();
    const same = await send({ "Content-Type": "application/json", Origin: "http://localhost" });
    assert.equal(same.status, 200, "the app's own origin and MCP clients (no Origin) are served"); await same.text();
  } finally { await mf.dispose(); }
});

test("an id with . or .. cannot reach another route, and mark_spam remembers the message's own sender (review 3, 9)", async () => {
  const { mf, as, call } = await fixture();
  try {
    const admin = await as("admin.access");
    const dots = await call(admin, "manage_folder", { accountId: `cloudflare:${MAILBOX}`, action: "remove", folderId: ".." });
    assert.equal(dots.isError, true);
    assert.match(dots.data.error, /not valid/);
    const badAccount = await call(admin, "list_folders", { accountId: "cloudflare:.." });
    assert.equal(badAccount.isError, true);

    const mail = await as("drafts.access");
    const received = (await (await mf.dispatchFetch("http://localhost/test/inbox", { method: "POST", body: JSON.stringify({ mailbox: MAILBOX, sender: "Deals <deals@spammy.invalid>", subject: "Offer" }) })).json()) as { id: string };
    const tool = (await mail.listTools()).tools.find((t) => t.name === "mark_spam")!;
    const item = (tool.inputSchema.properties!.messages as { items: { properties: Record<string, unknown> } }).items.properties;
    assert.ok(!("sender" in item), "the caller cannot name the sender");
    const marked = await call(mail, "mark_spam", { messages: [{ accountId: `cloudflare:${MAILBOX}`, messageId: received.id, sender: "x@attacker.invalid" }], spam: true, list: "sender" });
    assert.equal(marked.isError, false, JSON.stringify(marked.data));
    const lists = (await call(admin, "get_spam_settings", {})).data.lists;
    assert.deepEqual(lists.blockedSenders, ["deals@spammy.invalid"], "the message's own sender, not the one the caller named");
    assert.deepEqual(lists.blockedDomains, []);
  } finally { await mf.dispose(); }
});
