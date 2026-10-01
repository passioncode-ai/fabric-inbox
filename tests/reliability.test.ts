import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * Reliability (the 2026-09-29 backend audit) in workerd: a real MailboxDO and its incoming
 * journal, delivered through receiveEmail. The categories consumer refuses any message whose
 * subject says "poison"; agents are a recorder of what reached them.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { DurableObject } from 'cloudflare:workers';
      import { MailboxDO } from './workers/durableObject/index';
      import { receiveEmail } from './workers/index';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); }
        async dueNow() { this.ctx.storage.sql.exec("UPDATE incoming_receipts SET next_at = 0 WHERE automation_status = 'pending'"); await this.flushIncomingEvents(); }
        async receipts() { return this.ctx.storage.sql.exec('SELECT automation_status AS s, attempts AS a FROM incoming_receipts').toArray(); }
        async addSent(recipient) { this.ctx.storage.sql.exec("INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body) VALUES (?, 'sent', 'Hi', 'me@p.invalid', ?, ?, '')", crypto.randomUUID(), recipient, new Date().toISOString()); }
      }
      export class TestAgents extends DurableObject {
        async enqueue(mailboxId, emailId) { const seen = (await this.ctx.storage.get('seen')) || []; await this.ctx.storage.put('seen', [...seen, emailId]); }
        async seen() { return (await this.ctx.storage.get('seen')) || []; }
      }
      export class TestCategories extends DurableObject {
        async ingest(account, event) { if (/poison/.test(event.subject)) throw new Error('categories refused it'); }
      }
      export default {
        async fetch(request, env, ctx) {
          const c = await request.json();
          const box = env.MAILBOX.get(env.MAILBOX.idFromName('me@p.invalid'));
          if (c.op === 'setup') { await env.BUCKET.put('mailboxes/' + 'me@p.invalid' + '.json', JSON.stringify({ agent: 'off' })); return Response.json(true); }
          if (c.op === 'receive') {
            const bytes = new TextEncoder().encode(c.raw);
            return Response.json(await receiveEmail({ to: 'me@p.invalid', from: 'a@x.invalid', rawSize: bytes.length, raw: new Response(bytes).body, setReject() {} }, env, ctx));
          }
          if (c.op === 'forwarding') { await env.BUCKET.put('mailboxes/' + 'me@p.invalid' + '.json', JSON.stringify({ agent: 'off', forwarding: { enabled: true, email: 'copy@gmail.invalid' } })); return Response.json(true); }
          if (c.op === 'deliver') {
            // A delivery that is cut off right after the message was stored, then Cloudflare's retry.
            const bytes = new TextEncoder().encode(c.raw);
            const sent = [];
            const event = { to: 'me@p.invalid', from: 'a@x.invalid', rawSize: bytes.length, raw: new Response(bytes).body, setReject() {} };
            if (c.cut) Object.defineProperty(event, 'forward', { get() { throw new Error('the Worker was reset'); } });
            else event.forward = async (to) => { sent.push(to); };
            try { const r = await receiveEmail(event, env, ctx); return Response.json({ r, sent }); }
            catch (e) { return Response.json({ threw: e.message, sent }); }
          }
          if (c.op === 'thread') { const e = await box.getEmail(c.id); return Response.json({ one: e.body.length, thread: (await box.getThreadEmails(e.thread_id)).map((x) => ({ len: x.body.length, key: x.body_key ?? null })) }); }
          if (c.op === 'email') return Response.json(await box.getEmail(c.id));
          if (c.op === 'sent') { await box.addSent(c.recipient); return Response.json(true); }
          if (c.op === 'known') return Response.json(await box.knownCorrespondent(c.address));
          if (c.op === 'agents') return Response.json(await env.AGENT_REGISTRY.getByName('workspace').seen());
          if (c.op === 'counts') return Response.json(await box.inboxCounts());
          if (c.op === 'due') { await box.dueNow(); return Response.json(true); }
          if (c.op === 'retry') return Response.json(await box.retryIncoming());
          if (c.op === 'receipts') return Response.json(await box.receipts());
          return new Response('?', { status: 400 });
        }
      };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true }, AGENT_REGISTRY: { className: "TestAgents", useSQLite: true },
      CATEGORIES: { className: "TestCategories", useSQLite: true } },
    r2Buckets: ["BUCKET"], bindings: { DOMAINS: "p.invalid" },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const op = async (fields: Record<string, unknown>): Promise<any> => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(fields) })).json();
  await op({ op: "setup" });
  let n = 0;
  const receive = (subject: string) => op({ op: "receive",
    raw: `From: a@x.invalid\r\nTo: me@p.invalid\r\nSubject: ${subject}\r\nMessage-ID: <m${++n}@x.invalid>\r\nContent-Type: text/plain\r\n\r\nThe text of message ${n}.\r\n` });
  return { mf, op, receive };
}

test("events that always fail wait their backoff and are set aside, so later mail still reaches its consumers (audit H2)", async () => {
  const { mf, op, receive } = await fixture();
  try {
    for (let i = 0; i < 25; i++) await receive(`poison ${i}`);
    const fine = await receive("An ordinary message");
    const reached = await op({ op: "agents" }) as string[];
    assert.ok(reached.includes(fine.emailId), "the ordinary message is not held behind 25 failing ones");
    let counts = await op({ op: "counts" });
    assert.equal(counts.total, 26);
    assert.equal(counts.stuck.retrying, 25);
    assert.match(counts.stuck.lastError, /categories refused it/);
    for (let i = 0; i < 12; i++) await op({ op: "due" });
    counts = await op({ op: "counts" });
    assert.deepEqual([counts.stuck.dead, counts.stuck.retrying], [25, 0], "set aside after the bound, not retried forever");
    const receipts = await op({ op: "receipts" }) as { s: string; a: number }[];
    assert.ok(receipts.filter((r) => r.s === "dead").every((r) => r.a === 10));
    assert.equal(await op({ op: "retry" }), 25, "Retry brings them back");
    assert.equal((await op({ op: "counts" })).stuck.dead, 0);
  } finally { await mf.dispose(); }
});

test("a delivery cut off after storing still sends its forwarding copy when Cloudflare retries it, once (audit M1)", async () => {
  const { mf, op } = await fixture();
  try {
    await op({ op: "forwarding" });
    const raw = "From: a@x.invalid\r\nTo: me@p.invalid\r\nSubject: Hello\r\nMessage-ID: <cut@x.invalid>\r\nContent-Type: text/plain\r\n\r\nA message whose copy must reach Gmail.\r\n";
    const first = await op({ op: "deliver", raw, cut: true });
    assert.match(first.threw, /reset/, "the first attempt stored the message, then was cut off");
    const retry = await op({ op: "deliver", raw });
    assert.equal(retry.r.inserted, false);
    assert.deepEqual(retry.sent, ["copy@gmail.invalid"], "the retry sends the copy it still owed");
    const again = await op({ op: "deliver", raw });
    assert.deepEqual(again.sent, [], "and never twice");
  } finally { await mf.dispose(); }
});

test("a long message reads whole in its thread as alone; a long attachment name is stored; a known sender is the whole address (2026-10-01 review)", async () => {
  const { mf, op } = await fixture();
  try {
    const long = "x".repeat(450_000);
    const stored = await op({ op: "receive", raw: `From: a@x.invalid\r\nTo: me@p.invalid\r\nSubject: Long\r\nMessage-ID: <long@x.invalid>\r\nContent-Type: text/plain\r\n\r\n${long}\r\n` });
    const read = await op({ op: "thread", id: stored.emailId });
    assert.equal(read.thread[0].len, read.one, "the thread shows what the message shows");
    assert.ok(read.one >= 450_000);
    assert.equal(read.thread[0].key, null, "the storage key is not part of the answer");

    const name = "\u00e9".repeat(600) + ".pdf";
    const boundary = "b1";
    const withFile = await op({ op: "receive", raw: [`From: a@x.invalid`, `To: me@p.invalid`, `Subject: File`, `Message-ID: <file@x.invalid>`,
      `MIME-Version: 1.0`, `Content-Type: multipart/mixed; boundary=${boundary}`, ``, `--${boundary}`, `Content-Type: text/plain`, ``, `See attached.`,
      `--${boundary}`, `Content-Type: application/pdf; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, `Content-Transfer-Encoding: base64`, ``, `aGk=`, `--${boundary}--`, ``].join("\r\n") });
    assert.ok(withFile.emailId, JSON.stringify(withFile));
    const email = await op({ op: "email", id: withFile.emailId });
    assert.equal(email.attachments.length, 1);
    assert.ok(new TextEncoder().encode(email.attachments[0].filename).length <= 200);
    assert.match(email.attachments[0].filename, /\.pdf$/);

    await op({ op: "sent", recipient: "ax@example.invalid, x@example.invalid.au" });
    assert.equal(await op({ op: "known", address: "x@example.invalid" }), false, "not a part of another address");
    await op({ op: "sent", recipient: "Friend <x@example.invalid>, other@example.invalid" });
    assert.equal(await op({ op: "known", address: "x@example.invalid" }), true);
  } finally { await mf.dispose(); }
});
