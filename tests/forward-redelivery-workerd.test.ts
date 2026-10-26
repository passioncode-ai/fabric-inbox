import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * B-91, in workerd: Email Routing may deliver a message again after a first invocation forwarded its
 * copy and was cut off before marking it settled. A redelivery is a new invocation with nothing in
 * memory, so the mark lives in the mailbox: "sending" before the copy leaves, "settled" the moment
 * Email Routing takes it. A redelivery sends a copy that was owed and never started; one that was
 * started and never confirmed may have left, so it is not sent twice and the operator is told.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      import { receiveEmail, replayEvent, forwardOnce } from './workers/index';
      const forbidden = () => { throw new Error('External calls are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, { ...env, AI: { run: forbidden }, EMAIL: { send: forbidden } }); }
        async setStatus(id, status) { this.ctx.storage.sql.exec('UPDATE incoming_receipts SET forward_status = ? WHERE delivery_id = ?', status, id); }
        async age(id, ms) { this.ctx.storage.sql.exec("UPDATE incoming_receipts SET received_at = ?, automation_status = 'accepted' WHERE delivery_id = ?", Date.now() - ms, id); }
        async status(id) { return this.ctx.storage.sql.exec('SELECT forward_status AS s FROM incoming_receipts WHERE delivery_id = ?', id).toArray()[0]?.s ?? null; }
      }
      const box = (env) => env.MAILBOX.get(env.MAILBOX.idFromName('support@shop.invalid'));
      export default { async fetch(request, env, ctx) {
        const b = await request.json();
        if (b.op === 'setup') {
          await env.BUCKET.put('mailboxes/support@shop.invalid.json', JSON.stringify({ agent: 'off', forwarding: { enabled: true, email: 'copy@gmail.invalid' } }));
          return Response.json({ ok: true });
        }
        if (b.op === 'set') { await box(env).setStatus(b.id, b.status); return Response.json({ ok: true }); }
        if (b.op === 'status') return Response.json({ status: await box(env).status(b.id) });
        if (b.op === 'age') { await box(env).age(b.id, b.ms); return Response.json({ ok: true }); }
        if (b.op === 'blockers') return Response.json(await box(env).renameBlockers());
        if (b.op === 'issue') { const o = await env.BUCKET.get('delivery-issues/support@shop.invalid.json'); return Response.json(o ? await o.json() : null); }
        const bytes = new TextEncoder().encode(b.raw);
        const forwards = [];
        const event = { to: 'support@shop.invalid', from: 'ann@customer.invalid', rawSize: bytes.length, raw: new Response(bytes).body,
          setReject: () => {}, forward: async (to) => { forwards.push(to); } };
        let delivery = event;
        if (b.alreadySentHere) { const once = forwardOnce(); once.sent.add('copy@gmail.invalid'); delivery = replayEvent(event, bytes, once); }
        const out = await receiveEmail(delivery, env, ctx);
        return Response.json({ ...out, forwards });
      } };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

const RAW = "From: Ann <ann@customer.invalid>\r\nTo: support@shop.invalid\r\nSubject: Hello\r\nMessage-ID: <b91@customer.invalid>\r\nDate: Tue, 13 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nHi\r\n";

async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"], bindings: { DOMAINS: "shop.invalid" },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (body: unknown) => (await mf.dispatchFetch("http://x/", { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
  await call({ op: "setup" });
  return { mf, call };
}

test("a first delivery forwards once and settles; a plain redelivery sends nothing", async () => {
  const { mf, call } = await fixture();
  try {
    const first = await call({ op: "receive", raw: RAW });
    assert.deepEqual([first.inserted, first.forwarded, first.forwards], [true, "sent", ["copy@gmail.invalid"]]);
    assert.equal((await call({ op: "status", id: first.emailId })).status, "settled");
    const again = await call({ op: "receive", raw: RAW });
    assert.deepEqual([again.inserted, again.forwards], [false, []]);
  } finally {
    await mf.dispose();
  }
});

test("a copy still owed (cut off before it was tried) is sent by the redelivery", async () => {
  const { mf, call } = await fixture();
  try {
    const first = await call({ op: "receive", raw: RAW });
    await call({ op: "set", id: first.emailId, status: "owed" });
    const again = await call({ op: "receive", raw: RAW });
    assert.deepEqual([again.forwarded, again.forwards], ["sent", ["copy@gmail.invalid"]]);
    assert.equal((await call({ op: "status", id: first.emailId })).status, "settled");
  } finally {
    await mf.dispose();
  }
});

test("a copy started and never confirmed is not sent twice by a redelivery; the operator is told", async () => {
  const { mf, call } = await fixture();
  try {
    const first = await call({ op: "receive", raw: RAW });
    await call({ op: "set", id: first.emailId, status: "sending" });
    const again = await call({ op: "receive", raw: RAW });
    assert.deepEqual([again.forwarded, again.forwards], ["failed", []], "no second copy");
    assert.equal((await call({ op: "status", id: first.emailId })).status, "settled");
    assert.match((await call({ op: "issue" })).problem, /may not have left and was not sent twice/);
  } finally {
    await mf.dispose();
  }
});

test("within one delivery, a retry after the copy left settles it as sent, without a warning", async () => {
  const { mf, call } = await fixture();
  try {
    const first = await call({ op: "receive", raw: RAW });
    await call({ op: "set", id: first.emailId, status: "sending" });
    const retry = await call({ op: "receive", raw: RAW, alreadySentHere: true });
    assert.deepEqual([retry.forwarded, retry.forwards], ["sent", []]);
    assert.equal(await call({ op: "issue" }), null);
  } finally {
    await mf.dispose();
  }
});

test("M-8: a forwarding copy still owed after a day no longer holds a rename of its address", async () => {
  const { mf, call } = await fixture();
  try {
    await call({ op: "setup" });
    const out = await call({ raw: RAW });
    await call({ op: "set", id: out.emailId, status: "owed" });
    await call({ op: "age", id: out.emailId, ms: 60_000 });
    assert.equal((await call({ op: "blockers" })).incoming, 1, "a fresh owed copy holds it");
    await call({ op: "age", id: out.emailId, ms: 2 * 86_400_000 });
    assert.equal((await call({ op: "blockers" })).incoming, 0, "after a day it does not");
  } finally { await mf.dispose(); }
});
