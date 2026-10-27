import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { memberGate } from "../workers/lib/member-gate";
import { decodeRows, encodeRows, blobKeysOf, missingIds } from "../workers/lib/mailbox-transfer";

// B-158 M1 step 3a: a mailbox read out of one server and written into another, ids kept, counted against the source.
// Two workerd servers, each with its own Durable Objects and R2; the routes are the production ones, called the way
// an agent's export_mailbox and import_mailbox call them. No network.
const bundle = await build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { MailboxDO } from './workers/durableObject/index';
      import { transferRouter } from './workers/routes/transfer';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); }
        async seed(n) {
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES ('projects', 'Projects', 1)");
          for (let i = 0; i < n; i++) {
            this.ctx.storage.sql.exec("INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, body_key) VALUES (?, ?, ?, 'x@outside.invalid', 'a', ?, '', ?)",
              'm' + i, i % 2 ? 'projects' : 'inbox', 'Subject ' + i, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), 'bodies/m' + i + '.html');
            await this.env.BUCKET.put('bodies/m' + i + '.html', '<p>Body ' + i + '</p>');
            if (i % 4 === 0) {
              this.ctx.storage.sql.exec("INSERT INTO attachments (id, email_id, filename, mimetype, size) VALUES (?, ?, 'a.txt', 'text/plain', 3)", 'a' + i, 'm' + i);
              await this.env.BUCKET.put('attachments/m' + i + '/a' + i + '/a.txt', 'abc');
            }
          }
        }
        async trySend() { return this.sendMail({ mailboxId: 'support@shop.invalid', request: { to: 'x@outside.invalid', from: 'support@shop.invalid', subject: 'Hi', html: '<p>Hi</p>' }, kind: 'send' }); }
        async table(name) { return this.ctx.storage.sql.exec('SELECT * FROM ' + name + ' ORDER BY rowid').toArray(); }
      }
      const app = new Hono();
      app.post('/test/seed', async (c) => { const b = await c.req.json(); await c.env.BUCKET.put('mailboxes/' + b.address + '.json', JSON.stringify(b.settings));
        await c.env.MAILBOX.get(c.env.MAILBOX.idFromName(b.address)).seed(b.n); return c.json(true); });
      app.post('/test/table', async (c) => { const b = await c.req.json(); return c.json(await c.env.MAILBOX.get(c.env.MAILBOX.idFromName(b.address)).table(b.name)); });
      app.post('/test/r2', async (c) => { const b = await c.req.json(); const o = await c.env.BUCKET.get(b.key); return c.json(o ? await o.text() : null); });
      app.post('/test/settings', async (c) => { const b = await c.req.json(); const o = await c.env.BUCKET.get('mailboxes/' + b.address + '.json'); return c.json(o ? await o.json() : null); });
      app.post('/test/send', async (c) => { const b = await c.req.json(); return c.json(await c.env.MAILBOX.get(c.env.MAILBOX.idFromName(b.address)).trySend()); });
      app.route('/', transferRouter);
      export default app;
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

function server() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"],
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const r = await mf.dispatchFetch(`http://localhost${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  return { mf, call };
}
const ADDRESS = "support@shop.invalid";
const base = `/api/transfer/${encodeURIComponent(ADDRESS)}`;
const settings = { fromName: "Shop Support", signature: { enabled: true, text: "Shop" }, agent: "support", forwarding: { enabled: false, email: "" } };

test("B-158: a mailbox moves to another server with every message, attachment, folder and file, counted against the source", async () => {
  const a = server(), b = server();
  try {
    await a.call("POST", "/test/seed", { address: ADDRESS, settings, n: 25 });
    const manifest = await a.call("GET", base);
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.body.counts, { emails: 25, attachments: 7 });
    assert.deepEqual(manifest.body.blockers, { sends: 0, incoming: 0 });
    assert.equal((await b.call("GET", base)).status, 404, "nothing on the receiving server yet");

    const opened = await b.call("POST", `${base}/open`, { settings: manifest.body.settings });
    assert.deepEqual(opened.body, { address: ADDRESS, created: true });
    const copied = (await b.call("POST", "/test/settings", { address: ADDRESS })).body;
    assert.equal(copied.fromName, "Shop Support");
    assert.equal(copied.agent, "off", "no agent answers until one is chosen on the receiving server");

    // A file whose row has not arrived is refused: a receiving server never takes a file no row of the mailbox names.
    const early = await b.call("PUT", `${base}/file`, { key: "bodies/m0.html", data: Buffer.from("x").toString("base64") });
    assert.equal(early.status, 409);

    let files = 0;
    for (const table of ["folders", "emails", "attachments"]) {
      let after = 0;
      for (;;) {
        const page = await a.call("GET", `${base}/rows?table=${table}&after=${after}&limit=10`);
        assert.equal(page.status, 200, JSON.stringify(page.body));
        const wrote = await b.call("POST", `${base}/rows`, { table, rows: page.body.rows });
        assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
        for (const key of page.body.files) {
          const file = await a.call("GET", `${base}/file?key=${encodeURIComponent(key)}`);
          assert.equal(file.status, 200, key);
          assert.equal((await b.call("PUT", `${base}/file`, { key, data: file.body.data, contentType: file.body.contentType })).body.written, true);
          files++;
        }
        if (page.body.next === null) break;
        after = page.body.next;
      }
    }
    assert.equal(files, 25 + 7, "every stored body and every attachment");

    const ids = await a.call("GET", `${base}/ids`);
    const check = await b.call("POST", `${base}/check`, ids.body);
    assert.deepEqual(check.body, { complete: true, missing: { emails: [], attachments: [] }, counts: { emails: 0, attachments: 0 } });
    const [from, to] = await Promise.all([a.call("POST", "/test/table", { address: ADDRESS, name: "emails" }), b.call("POST", "/test/table", { address: ADDRESS, name: "emails" })]);
    assert.deepEqual(to.body.map((e: any) => [e.id, e.folder_id, e.subject, e.body_key]), from.body.map((e: any) => [e.id, e.folder_id, e.subject, e.body_key]));
    assert.equal((await b.call("POST", "/test/r2", { key: "attachments/m4/a4/a.txt" })).body, "abc");
    assert.equal((await b.call("POST", "/test/r2", { key: "bodies/m7.html" })).body, "<p>Body 7</p>");

    // Again changes nothing: open keeps the mailbox, rows are brought up to date, a file of the same size is left.
    assert.equal((await b.call("POST", `${base}/open`, { settings })).body.created, false);
    const again = await a.call("GET", `${base}/rows?table=emails&after=0&limit=5`);
    assert.equal((await b.call("POST", `${base}/rows`, { table: "emails", rows: again.body.rows })).body.received, 5);
    const file = await a.call("GET", `${base}/file?key=${encodeURIComponent("bodies/m0.html")}`);
    assert.equal((await b.call("PUT", `${base}/file`, { key: "bodies/m0.html", data: file.body.data })).body.written, false);
    // The sending server still has everything: a transfer only reads it.
    assert.equal((await a.call("GET", base)).body.counts.emails, 25);
  } finally { await a.mf.dispose(); await b.mf.dispose(); }
});

test("B-158: a transfer reads only the mailbox's own files, and a missing copy is named", async () => {
  const a = server();
  try {
    await a.call("POST", "/test/seed", { address: ADDRESS, settings, n: 3 });
    await a.call("POST", "/test/seed", { address: "other@shop.invalid", settings, n: 0 });
    const other = `/api/transfer/${encodeURIComponent("other@shop.invalid")}`;
    assert.equal((await a.call("GET", `${other}/file?key=${encodeURIComponent("bodies/m0.html")}`)).status, 404, "another mailbox's body is not this one's");
    for (const key of ["config/agent-keys.json", "mailboxes/support@shop.invalid.json", "../bodies/m0.html"])
      assert.equal((await a.call("GET", `${base}/file?key=${encodeURIComponent(key)}`)).status, 404, key);
    assert.equal((await a.call("GET", `${base}/rows?table=outbox`)).status, 400);
    const ids = await a.call("GET", `${base}/ids`);
    const partial = await a.call("POST", `${other}/check`, ids.body);
    assert.equal(partial.body.complete, false);
    assert.deepEqual(partial.body.counts, { emails: 3, attachments: 1 });
  } finally { await a.mf.dispose(); }
});

test("B-158: a member never reaches a transfer; rows survive JSON with bytes; the files a page names are its bodies and attachments", () => {
  for (const path of ["/api/transfer/support%40shop.invalid", "/api/transfer/support%40shop.invalid/rows", "/api/transfer/support%40shop.invalid/file"])
    assert.equal(memberGate("GET", path, ["cloudflare:support@shop.invalid"]), "refuse", path);
  const bytes = new Uint8Array([0, 1, 255]).buffer;
  const round = decodeRows(JSON.parse(JSON.stringify(encodeRows([{ id: "x", n: 2, nothing: null, raw: bytes }]))));
  assert.deepEqual(new Uint8Array(round[0]!.raw as ArrayBuffer), new Uint8Array([0, 1, 255]));
  assert.throws(() => decodeRows([{ "id; DROP": 1 }]), /not a column name/);
  assert.throws(() => decodeRows([{ id: { nested: true } }]), /not text, a number, null or bytes/);
  assert.deepEqual(blobKeysOf("emails", [{ body_key: "bodies/m1.html" }, { body_key: null }, { body_key: "config/x" }]), ["bodies/m1.html"]);
  assert.deepEqual(blobKeysOf("attachments", [{ email_id: "m1", id: "a1", filename: "f.pdf" }]), ["attachments/m1/a1/f.pdf"]);
  assert.deepEqual(missingIds({ emails: ["a", "b"], attachments: [] }, { emails: ["b", "c"], attachments: [] }), { emails: ["a"], attachments: [] });
});

test("B-158 step 3c: a hold on the sending server stops new sends and its agent, and release puts both back", async () => {
  const a = server();
  try {
    await a.call("POST", "/test/seed", { address: ADDRESS, settings, n: 1 });
    const held = await a.call("POST", `${base}/hold`, {});
    assert.deepEqual([held.body.held, held.body.changed], [true, true]);
    assert.equal((await a.call("POST", "/test/settings", { address: ADDRESS })).body.agent, "off");
    const refused = (await a.call("POST", "/test/send", { address: ADDRESS })).body;
    assert.equal(refused.code, "MOVED", JSON.stringify(refused));
    assert.equal((await a.call("POST", `${base}/hold`, {})).body.changed, false, "again changes nothing");
    const released = await a.call("POST", `${base}/hold`, { release: true });
    assert.deepEqual([released.body.held, released.body.changed], [false, true]);
    assert.equal((await a.call("POST", "/test/settings", { address: ADDRESS })).body.agent, "support", "the agent it had answers again");
    assert.notEqual((await a.call("POST", "/test/send", { address: ADDRESS })).body.code, "MOVED");
  } finally { await a.mf.dispose(); }
});
