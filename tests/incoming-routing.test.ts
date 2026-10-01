import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// SCN-025 / roadmap P1: inbound mail on a project domain is never lost
// silently. The production receiveEmail and MailboxDO run in workerd; only
// the agent trigger is replaced, and external mail and AI are forbidden.
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      import { receiveEmail, handleIncomingEmail } from './workers/index';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); }
      }
      const agent = {idFromName:n=>n,get:()=>({fetch:async()=>new Response('ok')})};
      export default {
        async fetch(request, env, ctx) {
          const c = await request.json();
          if (c.op === 'count') {
            const box = env.MAILBOX.getByName(c.mailbox);
            return Response.json({count: await box.countEmails({folder:'inbox'}), emails: await box.getEmails({folder:'inbox'})});
          }
          if (c.op === 'unknown') {
            const listed = await env.BUCKET.list({prefix:'unknown-recipients/'});
            const rows = [];
            for (const o of listed.objects) rows.push({key:o.key, value: await (await env.BUCKET.get(o.key)).json()});
            return Response.json(rows);
          }
          for (const m of c.mailboxes || []) await env.BUCKET.put('mailboxes/'+m+'.json','{}');
          const bytes = new TextEncoder().encode(c.raw);
          let rejected = null;
          const event = {to:c.to, from:'sender@outside.invalid', rawSize:bytes.length, raw:new Response(bytes).body,
            setReject:(reason)=>{ rejected = reason; }};
          const testEnv = {...env, EMAIL_AGENT:agent, EMAIL_ADDRESSES:c.addresses ?? [], DOMAINS:c.domains ?? '',
            UNKNOWN_ADDRESS_POLICY:c.policy};
          if (c.op === 'flaky') {
            // The mailbox fails like a Durable Object reset by a deploy, 'failures' times, then works.
            let thrown = 0;
            const real = testEnv.MAILBOX;
            const flaky = {...testEnv, MAILBOX: { idFromName: (n) => real.idFromName(n), getByName: (n) => real.getByName(n), get: (id) => {
              const stub = real.get(id);
              return new Proxy(stub, { get(target, prop) {
                if (prop === 'hasReceivedEmail' && thrown < (c.failures ?? 1)) return async () => { thrown++; throw new Error('Durable Object storage operation exceeded timeout which caused object to be reset.'); };
                return (...args) => target[prop](...args);
              } });
            } } };
            try { const result = await handleIncomingEmail(event, flaky, ctx); return Response.json({threw:false, result, thrown}); }
            catch (e) { return Response.json({threw:true, message:e.message, thrown}); }
          }
          if (c.op === 'broken') {
            const broken = {...testEnv, MAILBOX:{idFromName:()=>{throw new Error('storage unavailable')}, get:()=>{throw new Error('storage unavailable')}}};
            try { await handleIncomingEmail(event, broken, ctx); return Response.json({threw:false, rejected}); }
            catch (e) { return Response.json({threw:true, message:e.message, rejected}); }
          }
          const result = await receiveEmail(event, testEnv, ctx);
          return Response.json({result, rejected});
        }
      };
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers"],
  target: "es2022",
});

async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } },
    r2Buckets: ["BUCKET"],
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  async function command(op: string, fields: Record<string, unknown> = {}): Promise<any> {
    const response = await mf.dispatchFetch("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...fields }),
    });
    assert.equal(response.status, 200, `Test command ${op} failed: ${response.status} ${await response.clone().text()}`);
    return response.json();
  }
  return { mf, command };
}

const mail = (to: string, subject = "Where is my order?") =>
  `From: Customer <sender@outside.invalid>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <m-${subject.length}@outside.invalid>\r\n\r\nSecret body text that must not be logged.\r\n`;

test("mail to a mailbox that exists is stored and not rejected", async () => {
  const { mf, command } = await fixture();
  try {
    const out = await command("deliver", { to: "support@shop.invalid", raw: mail("support@shop.invalid"), mailboxes: ["support@shop.invalid"], domains: "shop.invalid" });
    assert.equal(out.rejected, null);
    assert.equal(out.result.inserted, true);
    assert.equal((await command("count", { mailbox: "support@shop.invalid" })).count, 1);
  } finally { await mf.dispose(); }
});

test("an unknown address is rejected by default, stored nowhere, and logged without its body", async () => {
  const { mf, command } = await fixture();
  try {
    const out = await command("deliver", { to: "sales@shop.invalid", raw: mail("sales@shop.invalid"), mailboxes: ["support@shop.invalid"], domains: "shop.invalid" });
    assert.ok(out.rejected, "setReject must be called");
    assert.match(out.rejected, /sales@shop\.invalid|address/i);
    assert.deepEqual(out.result, { rejected: "unknown_address" });
    assert.equal((await command("count", { mailbox: "support@shop.invalid" })).count, 0);
    const unknown = await command("unknown");
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].value.address, "sales@shop.invalid");
    assert.equal(unknown[0].value.action, "rejected");
    assert.equal(unknown[0].value.count, 1);
    assert.doesNotMatch(JSON.stringify(unknown), /Secret body|Where is my order|outside\.invalid/);
  } finally { await mf.dispose(); }
});

test("a catch-all policy keeps unknown-address mail once, with the original recipient", async () => {
  const { mf, command } = await fixture();
  try {
    const policy = JSON.stringify({ "shop.invalid": "catch_all:hello@shop.invalid" });
    const first = await command("deliver", { to: "sales@shop.invalid", raw: mail("sales@shop.invalid"), mailboxes: ["hello@shop.invalid"], domains: "shop.invalid", policy });
    const again = await command("deliver", { to: "sales@shop.invalid", raw: mail("sales@shop.invalid"), domains: "shop.invalid", policy });
    assert.equal(first.rejected, null);
    assert.equal(first.result.mailboxId, "hello@shop.invalid");
    assert.equal(first.result.inserted, true);
    assert.equal(again.result.inserted, false, "a repeated delivery is deduplicated");
    const box = await command("count", { mailbox: "hello@shop.invalid" });
    assert.equal(box.count, 1);
    assert.match(box.emails[0].recipient, /sales@shop\.invalid/);
    const unknown = await command("unknown");
    assert.equal(unknown[0].value.action, "catch_all");
    assert.equal(unknown[0].value.count, 2);
  } finally { await mf.dispose(); }
});

test("a catch-all that points at a missing mailbox rejects instead of dropping", async () => {
  const { mf, command } = await fixture();
  try {
    const policy = JSON.stringify({ "shop.invalid": "catch_all:hello@shop.invalid" });
    const out = await command("deliver", { to: "sales@shop.invalid", raw: mail("sales@shop.invalid"), domains: "shop.invalid", policy });
    assert.ok(out.rejected);
    assert.deepEqual(out.result, { rejected: "unknown_address" });
  } finally { await mf.dispose(); }
});

test("a domain the service does not serve is rejected", async () => {
  const { mf, command } = await fixture();
  try {
    const out = await command("deliver", { to: "support@other.invalid", raw: mail("support@other.invalid"), mailboxes: ["support@other.invalid"], domains: "shop.invalid, second.invalid" });
    assert.ok(out.rejected);
    assert.deepEqual(out.result, { rejected: "domain_not_served" });
    assert.equal((await command("count", { mailbox: "support@other.invalid" })).count, 0);
  } finally { await mf.dispose(); }
});

test("every domain in DOMAINS is served", async () => {
  const { mf, command } = await fixture();
  try {
    const out = await command("deliver", { to: "hi@second.invalid", raw: mail("hi@second.invalid"), mailboxes: ["hi@second.invalid"], domains: "shop.invalid, second.invalid" });
    assert.equal(out.rejected, null);
    assert.equal(out.result.inserted, true);
  } finally { await mf.dispose(); }
});

test("an address outside EMAIL_ADDRESSES is treated as unknown, not dropped", async () => {
  const { mf, command } = await fixture();
  try {
    const out = await command("deliver", { to: "old@shop.invalid", raw: mail("old@shop.invalid"), mailboxes: ["old@shop.invalid"], addresses: ["support@shop.invalid"], domains: "shop.invalid" });
    assert.ok(out.rejected);
    assert.deepEqual(out.result, { rejected: "unknown_address" });
  } finally { await mf.dispose(); }
});

test("a processing failure propagates instead of being reported as handled", async () => {
  const { mf, command } = await fixture();
  try {
    const out = await command("broken", { to: "support@shop.invalid", raw: mail("support@shop.invalid"), mailboxes: ["support@shop.invalid"], domains: "shop.invalid" });
    assert.equal(out.threw, true);
    assert.match(out.message, /storage unavailable/);
    assert.equal(out.rejected, null, "a temporary failure is not turned into a permanent rejection");
  } finally { await mf.dispose(); }
});

test("a Durable Object reset while a message arrives is retried once, and the message is stored once", async () => {
  const { mf, command } = await fixture();
  try {
    const once = await command("flaky", { to: "support@shop.invalid", raw: mail("support@shop.invalid", "reset once"), mailboxes: ["support@shop.invalid"], domains: "shop.invalid", failures: 1 });
    assert.equal(once.threw, false, JSON.stringify(once));
    assert.equal(once.thrown, 1);
    assert.equal(once.result.inserted, true);
    assert.equal((await command("count", { mailbox: "support@shop.invalid" })).count, 1);
    const twice = await command("flaky", { to: "support@shop.invalid", raw: mail("support@shop.invalid", "reset twice"), mailboxes: ["support@shop.invalid"], domains: "shop.invalid", failures: 2 });
    assert.equal(twice.threw, true, "a second failure is the platform's to retry");
    assert.match(twice.message, /exceeded timeout/);
  } finally { await mf.dispose(); }
});
