import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// B-27, second half: rename an address keeping its mail. The production MailboxDO, CategoriesDO and the
// rename run in workerd over a local R2; Cloudflare routing is not configured (no token), so no network.
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      import { CategoriesDO } from './workers/categories/store';
      import { renameAddress, renameStatus } from './workers/lib/address-rename';
      import { receiveEmail } from './workers/index';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); }
        async seed(n, withAttachments) {
          this.ctx.storage.sql.exec("INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES ('projects', 'Projects', 1)");
          for (let i = 0; i < n; i++) {
            const folder = i % 3 === 0 ? 'projects' : i % 3 === 1 ? 'inbox' : 'draft';
            this.ctx.storage.sql.exec("INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0)");
            this.ctx.storage.sql.exec("INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, body_key) VALUES (?, ?, ?, 'x@outside.invalid', 'a', ?, '', ?)",
              'm' + i, folder, 'Subject ' + i, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), 'bodies/m' + i + '.html');
            await this.env.BUCKET.put('bodies/m' + i + '.html', '<p>Body ' + i + '</p>');
            if (withAttachments && i % 5 === 0) {
              this.ctx.storage.sql.exec("INSERT INTO attachments (id, email_id, filename, mimetype, size) VALUES (?, ?, 'a.txt', 'text/plain', 3)", 'a' + i, 'm' + i);
              await this.env.BUCKET.put('attachments/m' + i + '/a' + i + '/a.txt', 'abc');
            }
          }
        }
        async table(name) { return this.ctx.storage.sql.exec('SELECT * FROM ' + name + ' ORDER BY rowid').toArray(); }
      }
      export { CategoriesDO };
      export default {
        async fetch(request, env, ctx) {
          const c = await request.json();
          const box = (m) => env.MAILBOX.get(env.MAILBOX.idFromName(m));
          if (c.op === 'setup') {
            for (const [m, s] of Object.entries(c.mailboxes)) await env.BUCKET.put('mailboxes/' + m + '.json', JSON.stringify(s));
            await box(c.from).seed(c.n, true);
            return Response.json(true);
          }
          if (c.op === 'verdict') { env.CATEGORIES.getByName('workspace').ctx; return Response.json(true); }
          if (c.op === 'rename') {
            let mailbox = env.MAILBOX;
            if (c.breakAfter) {
              // A request cut off after this many pages were imported into the new address.
              let imports = 0;
              mailbox = { idFromName: (n) => env.MAILBOX.idFromName(n), get: (id) => {
                const stub = env.MAILBOX.get(id);
                return new Proxy(stub, { get(t, p) {
                  if (p === 'importRows') return async (...a) => { if (++imports > c.breakAfter) throw new Error('cut off'); return t.importRows(...a); };
                  return (...a) => t[p](...a);
                } });
              } };
            }
            try { const r = await renameAddress({...env, MAILBOX: mailbox, DOMAINS: c.domains}, c.from, c.to); return Response.json({status: r.status, body: r.body}); }
            catch (e) { return Response.json({threw: e.message}); }
          }
          if (c.op === 'status') { const r = await renameStatus(env, c.from); return Response.json({status: r.status, body: r.body}); }
          if (c.op === 'table') return Response.json(await box(c.mailbox).table(c.name));
          if (c.op === 'r2') return Response.json(await (await env.BUCKET.get(c.key))?.text() ?? null);
          if (c.op === 'head') return Response.json(!!(await env.BUCKET.head(c.key)));
          if (c.op === 'deliver') {
            const bytes = new TextEncoder().encode('From: s@outside.invalid\\r\\nTo: ' + c.to + '\\r\\nSubject: After\\r\\nMessage-ID: <after-' + Date.now() + '@outside.invalid>\\r\\n\\r\\nHello\\r\\n');
            let rejected = null;
            const event = {to: c.to, from: 's@outside.invalid', rawSize: bytes.length, raw: new Response(bytes).body, setReject: (r) => { rejected = r; }};
            const result = await receiveEmail(event, {...env, DOMAINS: c.domains, EMAIL_AGENT: {idFromName:n=>n,get:()=>({fetch:async()=>new Response('ok')})}}, ctx);
            return Response.json({result, rejected});
          }
          return new Response('unknown op', {status: 400});
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
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true }, CATEGORIES: { className: "CategoriesDO", useSQLite: true } },
    r2Buckets: ["BUCKET"],
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (op: string, fields: Record<string, unknown> = {}): Promise<any> => {
    const r = await mf.dispatchFetch("http://localhost/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, ...fields }) });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { mf, call };
}
const FROM = "old@shop.invalid", TO = "new@shop.invalid", DOMAINS = "shop.invalid";
const settings = { fromName: "Old Support", signature: { enabled: true, text: "— Shop" }, agent: { id: "support" }, forwarding: { enabled: false, email: "" } };

test("B-27: a rename moves every message, attachment, draft and folder to the new address; the old object is empty and R2 keeps the files", async () => {
  const { mf, call } = await fixture();
  try {
    await call("setup", { mailboxes: { [FROM]: settings }, from: FROM, n: 30 });
    const before = await call("table", { mailbox: FROM, name: "emails" });
    const done = await call("rename", { from: FROM, to: TO, domains: DOMAINS });
    assert.equal(done.status, 200, JSON.stringify(done));
    assert.equal(done.body.state, "done");
    const after = await call("table", { mailbox: TO, name: "emails" });
    assert.deepEqual(after.map((e: any) => [e.id, e.folder_id, e.subject, e.body_key]), before.map((e: any) => [e.id, e.folder_id, e.subject, e.body_key]));
    assert.equal((await call("table", { mailbox: TO, name: "attachments" })).length, 6);
    assert.ok((await call("table", { mailbox: TO, name: "folders" })).some((f: any) => f.id === "projects"), "a person's own folder moves");
    assert.equal((await call("table", { mailbox: FROM, name: "emails" })).length, 0, "the old object is empty");
    assert.equal(await call("r2", { key: "bodies/m7.html" }), "<p>Body 7</p>", "R2 keeps the bodies the new rows name");
    assert.equal(await call("r2", { key: "attachments/m5/a5/a.txt" }), "abc");
    assert.equal(await call("head", { key: `mailboxes/${FROM}.json` }), false, "the old address's settings are gone");
    const moved = JSON.parse((await call("r2", { key: `mailboxes/${TO}.json` }))!);
    assert.deepEqual([moved.fromName, moved.signature, moved.agent], [settings.fromName, settings.signature, settings.agent], "settings and who answers move");
    assert.equal(await call("head", { key: `renames/${FROM}.json` }), false, "the journal is gone once done");
    assert.equal((await call("status", { from: FROM })).body.to, TO);
    // Mail to the old address now lands in the new one.
    const delivered = await call("deliver", { to: FROM, domains: DOMAINS });
    assert.equal(delivered.result.mailboxId, TO);
    assert.equal(delivered.rejected, null);
  } finally { await mf.dispose(); }
});

test("B-27: a rename cut off mid-copy and called again finishes with every message once", async () => {
  const { mf, call } = await fixture();
  try {
    await call("setup", { mailboxes: { [FROM]: settings }, from: FROM, n: 450 });
    const cut = await call("rename", { from: FROM, to: TO, domains: DOMAINS, breakAfter: 2 });
    assert.equal(cut.threw, "cut off");
    const status = await call("status", { from: FROM });
    assert.equal(status.body.state, "running");
    assert.equal(status.body.step, "copy");
    let r = await call("rename", { from: FROM, to: TO, domains: DOMAINS });
    for (let i = 0; i < 5 && r.body.state === "running"; i++) r = await call("rename", { from: FROM, to: TO, domains: DOMAINS });
    assert.equal(r.body.state, "done", JSON.stringify(r));
    const ids = (await call("table", { mailbox: TO, name: "emails" })).map((e: any) => e.id);
    assert.equal(ids.length, 450);
    assert.equal(new Set(ids).size, 450, "nothing copied twice");
    assert.equal((await call("table", { mailbox: TO, name: "attachments" })).length, 90);
  } finally { await mf.dispose(); }
});

test("B-27: refusals come before any write: same name, an existing target, an unserved domain, a missing address, another rename running", async () => {
  const { mf, call } = await fixture();
  try {
    await call("setup", { mailboxes: { [FROM]: settings, [TO]: {} }, from: FROM, n: 3 });
    assert.equal((await call("rename", { from: FROM, to: FROM, domains: DOMAINS })).status, 400);
    assert.equal((await call("rename", { from: FROM, to: TO, domains: DOMAINS })).status, 409);
    assert.equal((await call("rename", { from: FROM, to: "x@elsewhere.invalid", domains: DOMAINS })).status, 400);
    assert.equal((await call("rename", { from: "ghost@shop.invalid", to: "y@shop.invalid", domains: DOMAINS })).status, 404);
    assert.equal(await call("head", { key: `renames/${FROM}.json` }), false, "nothing written");
    assert.equal((await call("table", { mailbox: FROM, name: "emails" })).length, 3, "the old address untouched");
    const cut = await call("rename", { from: FROM, to: "third@shop.invalid", domains: DOMAINS, breakAfter: 1 });
    assert.equal(cut.threw, "cut off");
    assert.equal((await call("rename", { from: FROM, to: "fourth@shop.invalid", domains: DOMAINS })).status, 409, "one rename at a time");
  } finally { await mf.dispose(); }
});
