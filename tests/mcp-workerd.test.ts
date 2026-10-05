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
            const sent = (await ctx.storage.get('test:sent')) || [];
            await ctx.storage.put('test:sent', [...sent, { to: m.to, subject: m.subject, ...(m.attachments ? { attachments: m.attachments.map((a) => ({ filename: a.filename, type: a.type, content: a.content })) } : {}) }]);
            return { messageId: '<sent-' + sent.length + '@cloudflare.invalid>' };
          } } });
        }
        async testSent() { return (await this.ctx.storage.get('test:sent')) || []; }
        async testInbox(sender, subject) { const id = 'in-' + crypto.randomUUID(); await this.createEmail('inbox', { id, subject, sender, recipient: this.ctx.id.name ?? 'me', date: new Date().toISOString(), body: 'hello' }, []); return id; }
        async testWithFiles(files) {
          const id = 'in-' + crypto.randomUUID();
          const rows = files.map((f, i) => ({ id: id + '-' + i, email_id: id, filename: f.filename, mimetype: f.mimetype, size: f.bytes.length, content_id: null, disposition: 'attachment' }));
          for (const [i, f] of files.entries()) await this.env.BUCKET.put('attachments/' + id + '/' + rows[i].id + '/' + f.filename, Uint8Array.from(f.bytes));
          await this.createEmail('inbox', { id, subject: 'Files', sender: 'ann@customer.invalid', recipient: this.ctx.id.name ?? 'me', date: new Date().toISOString(), body: 'see attached' }, rows);
          return { id, attachmentIds: rows.map((r) => r.id) };
        }
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
          if (url.pathname === '/test/files') { const b = await request.json(); return Response.json(await env.MAILBOX.get(env.MAILBOX.idFromName(b.mailbox)).testWithFiles(b.files)); }
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
  { id: "k-scoped", clientId: "scoped.access", name: "Research agent", level: "read", send: "drafts", dailySendLimit: 50, createdAt: "2026-10-03T00:00:00Z", expiresAt: null, accounts: ["cloudflare:other@shop.invalid"] },
  { id: "k-scoped-mail", clientId: "scoped-mail.access", name: "Scoped mailer", level: "mail", send: "drafts", dailySendLimit: 50, createdAt: "2026-10-03T00:00:00Z", expiresAt: null, accounts: [`cloudflare:${"support@shop.invalid"}`] },
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
  const connect = async (claims: Record<string, unknown> | null, extra: Record<string, string> = {}) => {
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: ((url: string | URL, init?: RequestInit) => mf.dispatchFetch(String(url), init as never)) as typeof fetch,
      requestInit: { headers: { ...(claims ? { "x-test-claims": JSON.stringify(claims) } : {}), ...extra } },
    });
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(transport);
    return client;
  };
  const as = (clientId: string, extra: Record<string, string> = {}) => connect({ common_name: clientId, sub: "" }, extra);
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
  };
  const sent = async () => (await (await mf.dispatchFetch(`http://localhost/test/sent?mailbox=${MAILBOX}`)).json()) as { to: string; subject: string; attachments?: { filename: string; content: string }[] }[];
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

test("a key limited to one mailbox sees and reaches that mailbox only, end to end (AP-11)", async () => {
  const { mf, as, call } = await fixture();
  try {
    const inbox = (mailbox: string, subject: string) => mf.dispatchFetch("http://localhost/test/inbox", { method: "POST", body: JSON.stringify({ mailbox, sender: "news@letter.invalid", subject }) });
    await inbox(MAILBOX, "for support");
    await inbox("other@shop.invalid", "for research");

    const scopedMail = await as("scoped-mail.access");
    const tools = await names(scopedMail);
    assert.ok(tools.includes("list_messages") && tools.includes("save_draft") && tools.includes("move_messages"));
    for (const t of ["list_addresses", "list_domains", "mark_spam", "list_rules", "list_agents"]) assert.ok(!tools.includes(t), `a limited key must not see ${t}`);

    const feed = await call(scopedMail, "list_messages", {});
    assert.equal(feed.isError, false, JSON.stringify(feed.data));
    assert.deepEqual([...new Set(feed.data.messages.map((m: { accountId: string }) => m.accountId))], [`cloudflare:${MAILBOX}`]);
    assert.ok(feed.data.messages.some((m: { subject: string }) => m.subject === "for support"));

    const other = await call(scopedMail, "list_mailbox_messages", { accountId: "cloudflare:other@shop.invalid" });
    assert.equal(other.isError, true);
    assert.match(other.data.error, /limited to support@shop\.invalid/);
    const draft = await call(scopedMail, "save_draft", { accountId: "cloudflare:other@shop.invalid", to: "x@y.invalid", subject: "no", text: "no" });
    assert.equal(draft.isError, true, "writing in another mailbox is refused too");
    const own = await call(scopedMail, "save_draft", { accountId: `cloudflare:${MAILBOX}`, to: "x@y.invalid", subject: "yes", text: "yes" });
    assert.equal(own.isError, false, JSON.stringify(own.data));

    const accounts = await call(await as("scoped.access"), "list_accounts");
    assert.equal(accounts.isError, false, JSON.stringify(accounts.data));
    assert.ok(accounts.data.accounts.every((a: { accountId: string }) => a.accountId === "cloudflare:other@shop.invalid"), JSON.stringify(accounts.data.accounts));
  } finally { await mf.dispose(); }
});

test("a hub's admin key narrowed by X-Fabric-Accounts reaches the named mailbox only, end to end (ADR-0115 §5)", async () => {
  const { mf, as, call } = await fixture();
  try {
    await mf.dispatchFetch("http://localhost/test/inbox", { method: "POST", body: JSON.stringify({ mailbox: MAILBOX, sender: "a@b.invalid", subject: "for support" }) });
    const narrowed = await as("admin.access", { "X-Fabric-Accounts": `cloudflare:${MAILBOX}` });
    const tools = await names(narrowed);
    assert.ok(tools.includes("read_message") && tools.includes("send_email"));
    assert.ok(!tools.includes("create_address") && !tools.includes("list_addresses"), "workspace tools are gone once narrowed");
    const feed = await call(narrowed, "list_messages", {});
    assert.equal(feed.isError, false, JSON.stringify(feed.data));
    assert.ok(feed.data.messages.every((m: { accountId: string }) => m.accountId === `cloudflare:${MAILBOX}`));
    const other = await call(narrowed, "list_mailbox_messages", { accountId: "cloudflare:other@shop.invalid" });
    assert.equal(other.isError, true);
    await assert.rejects(as("admin.access", { "X-Fabric-Accounts": "not-an-account" }), /limited to no mailbox|403/, "a header naming nothing valid reaches nothing, refused at the door");
    const whole = await names(await as("admin.access"));
    assert.ok(whole.includes("create_address"), "without the header the key is what it was");
  } finally { await mf.dispose(); }
});

test("an attachment reaches the agent and a forward byte for byte, whatever its type says (agent audit 3)", async () => {
  const { mf, as, call, sent } = await fixture();
  try {
    const files = [
      { filename: "broken.json", mimetype: "application/json", bytes: [...new TextEncoder().encode('{"total": 12,')] },
      { filename: "prices.csv", mimetype: "text/csv", bytes: [0x63, 0x6f, 0xe9, 0x74, 0x0d, 0x0a, 0xff, 0x00] },
      { filename: "invite.ics", mimetype: "text/calendar", bytes: [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2] },
    ];
    const made = (await (await mf.dispatchFetch("http://localhost/test/files", { method: "POST", body: JSON.stringify({ mailbox: MAILBOX, files }) })).json()) as { id: string; attachmentIds: string[] };
    const sender = await as("send.access");
    const base64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
    for (const [i, f] of files.entries()) {
      const got = await call(sender, "get_attachment", { accountId: `cloudflare:${MAILBOX}`, messageId: made.id, attachmentId: made.attachmentIds[i] });
      assert.equal(got.isError, false, JSON.stringify(got.data));
      assert.equal(got.data.base64, base64(f.bytes), `${f.filename} comes back unchanged`);
      assert.equal(got.data.size, f.bytes.length);
    }
    const forwarded = await call(sender, "forward", { accountId: `cloudflare:${MAILBOX}`, messageId: made.id, to: "bob@customer.invalid", idempotencyKey: "fwd-files" });
    assert.equal(forwarded.isError, false, JSON.stringify(forwarded.data));
    const [out] = await sent();
    assert.deepEqual(out!.attachments!.map((a) => [a.filename, a.content]), files.map((f) => [f.filename, base64(f.bytes)]));
  } finally { await mf.dispose(); }
});

test("search_mailbox with hasAttachment: false finds the mail without attachments, rather than ignoring the filter (agent audit 5)", async () => {
  const { mf, as, call } = await fixture();
  try {
    await mf.dispatchFetch("http://localhost/test/files", { method: "POST", body: JSON.stringify({ mailbox: MAILBOX, files: [{ filename: "a.txt", mimetype: "text/plain", bytes: [104, 105] }] }) });
    await mf.dispatchFetch("http://localhost/test/inbox", { method: "POST", body: JSON.stringify({ mailbox: MAILBOX, sender: "a@b.invalid", subject: "no files" }) });
    const admin = await as("admin.access");
    const subjects = async (hasAttachment: boolean) => {
      const found = await call(admin, "search_mailbox", { accountId: `cloudflare:${MAILBOX}`, hasAttachment, folder: "inbox" });
      assert.equal(found.isError, false, JSON.stringify(found.data));
      return found.data.messages.map((m: { subject: string }) => m.subject);
    };
    assert.deepEqual(await subjects(true), ["Files"]);
    assert.deepEqual(await subjects(false), ["no files"]);
    const cursor = await call(admin, "search_mailbox", { accountId: `cloudflare:${MAILBOX}`, cursor: "abc" });
    assert.equal(cursor.isError, true, "a Gmail cursor on a Cloudflare mailbox is refused, not ignored");
  } finally { await mf.dispose(); }
});
