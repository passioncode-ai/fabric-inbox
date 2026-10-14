import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * B-90, in workerd: a mailbox's 30-day purge of Spam and Discarded deletes the messages' stored
 * bodies and attachments from R2 in a few calls of up to 1,000 keys — never one or two per message,
 * which ran past the subrequest limit and left files behind — and deletes a row only after its files
 * are gone: when R2 refuses, every row stays for the next alarm, so no file is ever orphaned.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      const forbidden = () => { throw new Error('External calls are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) {
          const counter = { deletes: 0, keys: 0 };
          const bucket = new Proxy(env.BUCKET, { get: (target, name) => name === 'delete'
            ? async (keys) => {
                if (await ctx.storage.get('r2-down')) throw new Error('R2 refused');
                counter.deletes++; counter.keys += Array.isArray(keys) ? keys.length : 1;
                return target.delete(keys);
              }
            : typeof target[name] === 'function' ? target[name].bind(target) : target[name] });
          super(ctx, { ...env, BUCKET: bucket, AI: { run: forbidden }, EMAIL: { send: forbidden } });
          this.counter = counter;
        }
        async seed(n, folder) {
          const old = new Date(Date.now() - 40 * 86400000).toISOString();
          for (let i = 0; i < n; i++) {
            const id = folder + i;
            this.ctx.storage.sql.exec("INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, body_key, spam_at, discarded_at) VALUES (?, ?, 's', 'x@a.invalid', 'b@shop.invalid', ?, '', ?, ?, ?)",
              id, folder, old, 'bodies/' + id, folder === 'spam' ? old : null, folder === 'discarded' ? old : null);
            this.ctx.storage.sql.exec("INSERT INTO attachments (id, email_id, filename, mimetype, size) VALUES (?, ?, 'a.pdf', 'application/pdf', 1)", 'att' + id, id);
            await this.env.BUCKET.put('bodies/' + id, 'body');
            await this.env.BUCKET.put('attachments/' + id + '/att' + id + '/a.pdf', 'file');
          }
        }
        async r2Down(on) { await this.ctx.storage.put('r2-down', on); }
        async state(folder) {
          const rows = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM emails WHERE folder_id = ?', folder).one().n;
          const files = (await this.env.BUCKET.list({ prefix: 'bodies/' })).objects.length + (await this.env.BUCKET.list({ prefix: 'attachments/' })).objects.length;
          const attachments = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM attachments').one().n;
          return { rows, files, attachments, deletes: this.counter.deletes, keys: this.counter.keys };
        }
      }
      const box = (env) => env.MAILBOX.get(env.MAILBOX.idFromName('b@shop.invalid'));
      export default { async fetch(request, env) {
        const { op, folder, n, all, on } = await request.json();
        const b = box(env);
        if (op === 'seed') { await b.seed(n, folder); return Response.json({ ok: true }); }
        if (op === 'down') { await b.r2Down(on); return Response.json({ ok: true }); }
        if (op === 'state') return Response.json(await b.state(folder));
        if (op === 'spam') return Response.json(await b.purgeSpam({ all }));
        return Response.json(await b.purgeDiscarded({ all }));
      } };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"], bindings: { DOMAINS: "shop.invalid" },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (body: unknown) => (await mf.dispatchFetch("http://x/", { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
  return { mf, call };
}

test("old Spam goes 200 messages a pass, its files in one R2 call per pass, nothing left behind", async () => {
  const { mf, call } = await fixture();
  try {
    await call({ op: "seed", folder: "spam", n: 450 });
    assert.equal(await call({ op: "spam" }), 200);
    let state = await call({ op: "state", folder: "spam" });
    assert.deepEqual([state.rows, state.files, state.deletes, state.keys], [250, 500, 1, 400], "400 files of 200 messages in one call");
    assert.equal(await call({ op: "spam" }), 200);
    assert.equal(await call({ op: "spam" }), 50);
    state = await call({ op: "state", folder: "spam" });
    assert.deepEqual([state.rows, state.files, state.attachments, state.deletes], [0, 0, 0, 3]);
  } finally {
    await mf.dispose();
  }
});

test("when R2 refuses, no row goes: the files and their rows wait for the next alarm together", async () => {
  const { mf, call } = await fixture();
  try {
    await call({ op: "seed", folder: "discarded", n: 30 });
    await call({ op: "down", on: true });
    assert.equal(await call({ op: "discarded" }), 0);
    let state = await call({ op: "state", folder: "discarded" });
    assert.deepEqual([state.rows, state.files, state.attachments], [30, 60, 30], "nothing orphaned, nothing lost");
    await call({ op: "down", on: false });
    assert.equal(await call({ op: "discarded" }), 30);
    state = await call({ op: "state", folder: "discarded" });
    assert.deepEqual([state.rows, state.files, state.attachments], [0, 0, 0]);
  } finally {
    await mf.dispose();
  }
});

test("Empty Spam deletes up to 1,000 messages in one request, in a few R2 calls", async () => {
  const { mf, call } = await fixture();
  try {
    await call({ op: "seed", folder: "spam", n: 450 });
    assert.equal(await call({ op: "spam", all: true }), 450);
    const state = await call({ op: "state", folder: "spam" });
    assert.deepEqual([state.rows, state.files, state.deletes], [0, 0, 3]);
  } finally {
    await mf.dispose();
  }
});
