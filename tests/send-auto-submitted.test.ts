// The whole path from MailboxDO.sendMail to the send_email binding, in workerd. An agent's reply sets
// `auto_submitted`, and transportParams turns it into `Auto-Submitted: auto-replied` (RFC 3834) so
// other auto-responders do not answer it — but sendMail's request schema dropped the field, so no
// agent reply ever carried the header (bug hunt 2026-10-12). Each piece was tested, not the seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) {
          super(ctx, { ...env, AI: { run: () => { throw new Error('no AI'); } }, EMAIL: { send: async (m) => {
            await ctx.storage.put('sent', [...((await ctx.storage.get('sent')) || []), { to: m.to, headers: m.headers || {} }]);
            return { messageId: '<r@test.invalid>' };
          } } });
        }
        async sentLog() { return (await this.ctx.storage.get('sent')) || []; }
      }
      export default {
        async fetch(request, env) {
          const c = await request.json();
          const box = env.MAILBOX.getByName('support@p.invalid');
          if (c.op === 'send') return Response.json(await box.sendMail(c.command));
          if (c.op === 'sent') return Response.json(await box.sentLog());
          if (c.op === 'draft') { await box.createEmail('draft', c.row, []); return Response.json(true); }
          if (c.op === 'sendDraft') return Response.json(await Promise.all(c.keys.map((k) => box.sendDraft({ mailboxId: 'support@p.invalid', draftId: c.id, idempotencyKey: k, from: 'support@p.invalid' }))));
          if (c.op === 'get') return Response.json(await box.getEmail(c.id));
          return new Response('unknown', { status: 400 });
        },
      };`,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

test("an agent's reply leaves with Auto-Submitted: auto-replied; a person's send does not", async () => {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"], bindings: { DOMAINS: "p.invalid" },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const op = async (body: unknown): Promise<any> => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(body) })).json();
  try {
    const base = { from: "support@p.invalid", to: "ann@customer.invalid", subject: "Re: Price?", text: "It costs 10 EUR." };
    const agent = await op({ op: "send", command: { mailboxId: "support@p.invalid", kind: "send", idempotencyKey: "agent-1", request: { ...base, auto_submitted: true } } });
    assert.equal(agent.error, undefined, JSON.stringify(agent));
    const person = await op({ op: "send", command: { mailboxId: "support@p.invalid", kind: "send", idempotencyKey: "person-1", request: base } });
    assert.equal(person.error, undefined, JSON.stringify(person));
    const sent = await op({ op: "sent" });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].headers["Auto-Submitted"], "auto-replied", "the agent's reply says it is automatic");
    assert.equal(sent[1].headers["Auto-Submitted"], undefined, "a person's mail does not");
  } finally { await mf.dispose(); }
});

test("one draft sent twice at once leaves once; the second send is refused as a conflict (bug hunt 2026-10-12)", async () => {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"], bindings: { DOMAINS: "p.invalid" },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const op = async (body: unknown): Promise<any> => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(body) })).json();
  try {
    await op({ op: "draft", row: { id: "d1", subject: "Hello", sender: "support@p.invalid", recipient: "ann@customer.invalid", date: "2026-10-12T10:00:00.000Z", body: "<p>Hi</p>", thread_id: "d1" } });
    const results = await op({ op: "sendDraft", id: "d1", keys: ["window-a", "window-b"] });
    const accepted = results.filter((r: any) => r.status === "accepted");
    const refused = results.filter((r: any) => r.code === "DRAFT_CONFLICT");
    assert.equal(accepted.length, 1, JSON.stringify(results));
    assert.equal(refused.length, 1, JSON.stringify(results));
    assert.equal((await op({ op: "sent" })).length, 1, "the message left once");
    assert.equal(await op({ op: "get", id: "d1" }), null, "the sent draft is gone");
  } finally { await mf.dispose(); }
});
