import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { decodeBody } from "../workers/providers/gmail-client";

// Audit fixes of 2026-09-28 (REQ-A), each exercised on the production code in
// workerd: MailboxDO SQL and the mailbox HTTP API. External mail and AI are forbidden.
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      import { app, receiveEmail } from './workers/index';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); }
        async seed(folder, row) { return this.createEmail(folder, row, []); }
        async attach(row) { this.ctx.storage.sql.exec("INSERT INTO attachments (id, email_id, filename, mimetype, size) VALUES (?, ?, ?, 'text/plain', 1)", row.id, row.email_id, row.filename); }
      }
      export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname === '/do') {
            const c = await request.json();
            const box = env.MAILBOX.getByName(c.mailbox);
            if (c.op === 'seed') { for (const [folder, row] of c.rows) await box.seed(folder, row); return Response.json(true); }
            if (c.op === 'attach') { await box.attach(c.row); await env.BUCKET.put('attachments/' + c.row.email_id + '/' + c.row.id + '/' + c.row.filename, 'x'); return Response.json(true); }
            if (c.op === 'threaded') return Response.json(await box.getThreadedEmails({ folder: c.folder }));
            if (c.op === 'createFolder') return Response.json(await box.createFolder(c.id, c.id));
            if (c.op === 'deleteFolder') return Response.json(await box.deleteFolder(c.id));
            if (c.op === 'folder') return Response.json(await box.getEmails({ folder: c.folder }));
            if (c.op === 'search') return Response.json(await box.searchEmails({ query: c.query }));
            if (c.op === 'get') return Response.json(await box.getEmail(c.id));
            if (c.op === 'delete') return Response.json(await box.deleteEmail(c.id));
            if (c.op === 'r2get') { const o = await env.BUCKET.get(c.key); return Response.json(o ? (await o.text()).length : null); }
            if (c.op === 'r2') return Response.json((await env.BUCKET.list({ prefix: c.prefix })).objects.map(o => o.key));
            if (c.op === 'receive') {
              let rejected = null;
              const bytes = c.raw ? new TextEncoder().encode(c.raw) : null;
              const result = await receiveEmail({ to: c.to, from: 'a@b.invalid', rawSize: bytes ? bytes.length : c.size, raw: new Response(bytes ?? 'x').body, setReject: (r) => { rejected = r; } }, env, ctx);
              return Response.json({ result, rejected });
            }
          }
          return app.fetch(request, env, ctx);
        }
      };
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"],
    bindings: { DOMAINS: "p.invalid" },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const op = async (fields: Record<string, unknown>): Promise<any> =>
    (await mf.dispatchFetch("http://localhost/do", { method: "POST", body: JSON.stringify({ mailbox: "me@p.invalid", ...fields }) })).json();
  const api = (path: string, init?: RequestInit) => mf.dispatchFetch("http://localhost" + path, init);
  return { mf, op, api };
}
const email = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, subject: "S " + id, sender: "ann@x.invalid", recipient: "me@p.invalid", date: "2026-09-28T10:00:00.000Z", body: "body " + id, thread_id: "t1", ...over });

test("threaded list: 'has draft' and 'needs reply' reflect the thread (they were always false)", async () => {
  const { mf, op } = await fixture();
  try {
    await op({ op: "seed", rows: [
      ["inbox", email("in1", { read: true, date: "2026-09-28T10:00:00.000Z" })],
      ["draft", email("d1", { sender: "me@p.invalid", date: "2026-09-28T10:05:00.000Z" })],
      ["inbox", email("in2", { thread_id: "t2", read: true, date: "2026-09-28T11:00:00.000Z" })],
      ["sent", email("s2", { thread_id: "t2", sender: "me@p.invalid", date: "2026-09-28T11:30:00.000Z" })],
    ] });
    const rows = await op({ op: "threaded", folder: "inbox" });
    const t1 = rows.find((r: any) => r.thread_id === "t1"), t2 = rows.find((r: any) => r.thread_id === "t2");
    assert.equal(!!t1.has_draft, true);
    assert.equal(!!t2.has_draft, false);
    assert.equal(!!t2.needs_reply, false, "the last message was ours");
    await op({ op: "seed", rows: [["inbox", email("in3", { thread_id: "t3", read: true, date: "2026-09-28T12:00:00.000Z" })]] });
    const t3 = (await op({ op: "threaded", folder: "inbox" })).find((r: any) => r.thread_id === "t3");
    assert.equal(!!t3.needs_reply, true);
  } finally { await mf.dispose(); }
});

test("deleting a folder moves its mail to Inbox instead of deleting it", async () => {
  const { mf, op } = await fixture();
  try {
    await op({ op: "createFolder", id: "projects" });
    await op({ op: "seed", rows: [["projects", email("p1")]] });
    assert.equal(await op({ op: "deleteFolder", id: "projects" }), true);
    assert.deepEqual((await op({ op: "folder", folder: "inbox" })).map((e: any) => e.id), ["p1"]);
  } finally { await mf.dispose(); }
});

test("search treats % and _ as text", async () => {
  const { mf, op } = await fixture();
  try {
    await op({ op: "seed", rows: [["inbox", email("a", { subject: "Discount 100% off" })], ["inbox", email("b", { subject: "Order 1000 shipped" })], ["inbox", email("c", { subject: "file_name.txt" })], ["inbox", email("d", { subject: "filexname" })]] });
    assert.deepEqual((await op({ op: "search", query: "100%" })).map((e: any) => e.id), ["a"]);
    assert.deepEqual((await op({ op: "search", query: "file_" })).map((e: any) => e.id), ["c"]);
  } finally { await mf.dispose(); }
});

test("search finds a phrase longer than LIKE's 50-byte cap, and Cyrillic in any case (live 2026-10-09)", async () => {
  const { mf, op } = await fixture();
  try {
    const long = "Fabric Inbox routing test 2026-10-08 22:26 UTC · e832587f";
    await op({ op: "seed", rows: [["inbox", email("t", { subject: long })], ["inbox", email("r", { subject: "Привет, вопрос по счёту" })], ["inbox", email("x", { subject: "Other" })]] });
    assert.deepEqual((await op({ op: "search", query: long })).map((e: any) => e.id), ["t"]);
    for (const q of ["привет", "Привет", "ПРИВЕТ", "счёту"]) assert.deepEqual((await op({ op: "search", query: q })).map((e: any) => e.id), ["r"], q);
  } finally { await mf.dispose(); }
  // Durable Object SQLite caps LIKE patterns at 50 bytes; a longer one matched nothing. The search uses instr.
  const source = (await import("node:fs")).readFileSync("workers/durableObject/index.ts", "utf8");
  const builder = source.slice(source.indexOf("#buildSearchConditions("), source.indexOf("async searchEmails("));
  assert.doesNotMatch(builder, /LIKE \$\{/, "no SQL LIKE condition is built");
});

test("a draft id can only replace a draft, and the old draft goes only after the new one is stored", async () => {
  const { mf, op, api } = await fixture();
  try {
    await mf.dispatchFetch("http://localhost/api/v1/mailboxes", { method: "POST", body: JSON.stringify({ email: "me@p.invalid", name: "Me" }) });
    await op({ op: "seed", rows: [["inbox", email("keep")], ["draft", email("old-draft", { sender: "me@p.invalid" })]] });
    const refused = await api("/api/v1/mailboxes/me@p.invalid/drafts", { method: "POST", body: JSON.stringify({ body: "x", draft_id: "keep" }) });
    assert.equal(refused.status, 400);
    assert.deepEqual((await op({ op: "folder", folder: "inbox" })).map((e: any) => e.id), ["keep"], "an inbox message is never deleted as a draft");
    const replaced = await api("/api/v1/mailboxes/me@p.invalid/drafts", { method: "POST", body: JSON.stringify({ body: "new", draft_id: "old-draft" }) });
    assert.equal(replaced.status, 201);
    const drafts = await op({ op: "folder", folder: "draft" });
    assert.equal(drafts.length, 1);
    assert.notEqual(drafts[0].id, "old-draft");
  } finally { await mf.dispose(); }
});

test("deleting a mailbox removes its mail and attachments, so the address starts empty again", async () => {
  const { mf, op, api } = await fixture();
  try {
    await api("/api/v1/mailboxes", { method: "POST", body: JSON.stringify({ email: "me@p.invalid", name: "Me" }) });
    await op({ op: "seed", rows: [["inbox", email("m1")]] });
    await op({ op: "attach", row: { id: "a1", email_id: "m1", filename: "f.txt" } });
    // One path with Domains & addresses (MB-1): the answer says what happens to the next message.
    assert.equal((await api("/api/v1/mailboxes/me@p.invalid", { method: "DELETE" })).status, 200);
    assert.deepEqual(await op({ op: "r2", prefix: "attachments/" }), []);
    assert.deepEqual(await op({ op: "r2", prefix: "mailboxes/" }), []);
    await api("/api/v1/mailboxes", { method: "POST", body: JSON.stringify({ email: "me@p.invalid", name: "Me" }) });
    assert.deepEqual(await op({ op: "folder", folder: "inbox" }), []);
  } finally { await mf.dispose(); }
});

test("mailbox creation is limited to served domains; oversize inbound mail is bounced, not failed", async () => {
  const { mf, op, api } = await fixture();
  try {
    const foreign = await api("/api/v1/mailboxes", { method: "POST", body: JSON.stringify({ email: "x@elsewhere.invalid", name: "X" }) });
    assert.equal(foreign.status, 400, "a domain not served here is refused like on Domains & addresses (MB-1)");
    const big = await op({ op: "receive", to: "me@p.invalid", size: 26 * 1024 * 1024 });
    assert.match(big.rejected, /too large/);
  } finally { await mf.dispose(); }
});

test("Gmail text parts decode in their declared charset", () => {
  const cp1251 = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет"
  assert.equal(decodeBody(cp1251, [{ name: "Content-Type", value: 'text/plain; charset="windows-1251"' }]), "Привет");
  const koi8 = Uint8Array.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]);
  assert.equal(decodeBody(koi8, [{ name: "content-type", value: "text/plain; charset=KOI8-R" }]), "Привет");
  assert.equal(decodeBody(new TextEncoder().encode("Привет"), []), "Привет");
  assert.equal(decodeBody(new TextEncoder().encode("ok"), [{ name: "Content-Type", value: "text/plain; charset=x-unknown" }]), "ok");
});

test("a message whose body is larger than a database row is kept whole: the body lives in R2, the row keeps its start (reliability audit H1)", async () => {
  const { mf, op, api } = await fixture();
  try {
    await api("/api/v1/mailboxes", { method: "POST", body: JSON.stringify({ email: "me@p.invalid", name: "Me" }), headers: { "content-type": "application/json" } });
    const body = "log line ".repeat(350_000); // ~3 MB of text
    const raw = `From: Ann <ann@x.invalid>\r\nTo: me@p.invalid\r\nSubject: Big log\r\nMessage-ID: <big@x.invalid>\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
    const got = await op({ op: "receive", to: "me@p.invalid", raw });
    assert.equal(got.rejected, null);
    assert.equal(got.result.inserted, true, "stored on the first delivery, not failed on every retry");
    const email = await op({ op: "get", id: got.result.emailId });
    assert.equal(email.body.trim().length, body.trim().length, "reading it gives the whole body");
    assert.equal((await op({ op: "r2", prefix: "bodies/" })).length, 1);
    await op({ op: "delete", id: got.result.emailId });
    assert.deepEqual(await op({ op: "r2", prefix: "bodies/" }), [], "deleting the message deletes its body");
    const small = await op({ op: "receive", to: "me@p.invalid", raw: "From: a@x.invalid\r\nTo: me@p.invalid\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\nhello\r\n" });
    assert.equal((await op({ op: "get", id: small.result.emailId })).body.trim(), "hello");
    assert.deepEqual(await op({ op: "r2", prefix: "bodies/" }), [], "a small body stays in its row");
  } finally { await mf.dispose(); }
});
