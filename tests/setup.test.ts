import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { parseSetup, SETUP_FORMAT } from "../shared/setup";
import { setupFromRouting } from "../workers/routing/to-setup";
import type { DomainRouting } from "../workers/routing/email-routing";

/** R2 keys as the Worker writes them. */
const mailboxKey = (address: string) => `mailboxes/${address}.json`;
const issueKey = (address: string) => `delivery-issues/${address}.json`;

const server = { origin: "https://fabric-inbox.example.workers.dev" };
const fwd = (value: string) => ({ type: "forward" as const, value });

test("Email Routing becomes a setup that keeps every forward working", () => {
  const routings: DomainRouting[] = [
    { domain: "product.invalid", visible: true, enabled: true,
      rules: [{ address: "support@product.invalid", enabled: true, action: fwd("owner@gmail.invalid") },
        { address: "old@product.invalid", enabled: false, action: fwd("owner@gmail.invalid") },
        { address: "spam@product.invalid", enabled: true, action: { type: "drop" } }],
      catchAll: { enabled: true, action: fwd("owner@gmail.invalid") } },
    { domain: "quiet.invalid", visible: true, enabled: true, rules: [{ address: "info@quiet.invalid", enabled: true, action: fwd("me@gmail.invalid") }],
      catchAll: { enabled: true, action: { type: "drop" } } },
    { domain: "dead.invalid", visible: true, enabled: true, rules: [{ address: "x@dead.invalid", enabled: false, action: fwd("me@gmail.invalid") }], catchAll: { enabled: false, action: { type: "drop" } } },
    { domain: "elsewhere.invalid", visible: false, enabled: false, rules: [], catchAll: null },
    { domain: "off.test", visible: true, enabled: false, rules: [], catchAll: null },
  ];
  const setup = setupFromRouting(routings, server);
  assert.deepEqual(setup.domains, ["product.invalid", "quiet.invalid"]);
  assert.deepEqual(setup.mailboxes.map((m) => [m.address, m.forwardTo]), [
    ["support@product.invalid", "owner@gmail.invalid"],
    ["catch-all@product.invalid", "owner@gmail.invalid"],
    ["info@quiet.invalid", "me@gmail.invalid"],
  ]);
  assert.deepEqual(setup.catchAll, [{ domain: "product.invalid", mailbox: "catch-all@product.invalid" }]);
  assert.deepEqual(setup.notServed.map((n) => n.domain), ["dead.invalid", "elsewhere.invalid", "off.test"]);
  // No agent is named: a new mailbox starts Off, and one that exists keeps the agent it has (audit finding 1).
  assert.ok(setup.mailboxes.every((m) => m.agent === undefined), "the setup names no agent");
  assert.equal(parseSetup(setup).ok, true, "the result is a valid setup");
});

test("a forward to a domain the setup also serves is dropped instead of looping", () => {
  const setup = setupFromRouting([
    { domain: "a.invalid", visible: true, enabled: true, rules: [{ address: "hi@a.invalid", enabled: true, action: fwd("hi@b.invalid") }], catchAll: null },
    { domain: "b.invalid", visible: true, enabled: true, rules: [{ address: "hi@b.invalid", enabled: true, action: fwd("me@gmail.invalid") }], catchAll: null },
  ], server);
  assert.equal(setup.mailboxes[0].forwardTo, undefined);
  assert.match(setup.mailboxes[0].note!, /not kept/);
  assert.equal(parseSetup(setup).ok, true);
});

test("a malformed setup names its problems", () => {
  const bad = parseSetup({ format: SETUP_FORMAT, name: "x", server: { origin: "https://s.test" }, domains: ["a.invalid"],
    mailboxes: [{ address: "hi@b.invalid" }, { address: "x@a.invalid", forwardTo: "y@a.invalid" }], catchAll: [{ domain: "a.invalid", mailbox: "z@a.invalid" }] });
  assert.equal(bad.ok, false);
  const text = (bad as { problems: string[] }).problems.join("\n");
  assert.match(text, /hi@b\.invalid: its domain is not in domains/);
  assert.match(text, /would loop/);
  assert.match(text, /z@a\.invalid is not one of the mailboxes/);
  assert.equal(parseSetup({ format: "other" }).ok, false);
});

// ── Applying a setup and receiving mail, in workerd ─────────────────
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      import { receiveEmail } from './workers/index';
      import { setupRouter } from './workers/routes/setup';
      import { createMailbox } from './workers/lib/mailbox-store';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); }
      }
      export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname === '/receive') {
            const c = await request.json();
            const bytes = new TextEncoder().encode(c.raw);
            const forwards = []; let rejected = null;
            const event = { to: c.to, from: 'a@outside.invalid', rawSize: bytes.length, raw: new Response(bytes).body,
              setReject: (r) => { rejected = r; },
              forward: async (to) => { if (c.forwardFails) throw new Error('destination not verified'); forwards.push(to); } };
            const result = await receiveEmail(event, env, ctx);
            return Response.json({ result, forwards, rejected });
          }
          if (url.pathname === '/create') { const c = await request.json(); return Response.json(await createMailbox(env, c.email, c.name)); }
          if (url.pathname === '/inbox') return Response.json(await env.MAILBOX.getByName(url.searchParams.get('box')).getEmails({ folder: 'inbox' }));
          if (url.pathname === '/r2') { const o = await env.BUCKET.get(url.searchParams.get('key')); return new Response(o ? await o.text() : 'null'); }
          return setupRouter.fetch(request, env, ctx);
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
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"],
    bindings: { DOMAINS: "base.invalid" },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (path: string, body?: unknown) => {
    const r = await mf.dispatchFetch("http://localhost" + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const text = async (path: string) => (await mf.dispatchFetch("http://localhost" + path)).text();
  return { mf, call, text };
}
const mail = (to: string, id: string) => `From: A <a@outside.invalid>\r\nTo: ${to}\r\nSubject: Hello ${id}\r\nMessage-ID: <${id}@outside.invalid>\r\n\r\nHi\r\n`;
const setup = {
  format: SETUP_FORMAT, name: "Owner", server,
  domains: ["product.invalid"],
  mailboxes: [
    { address: "support@product.invalid", name: "Acme support", forwardTo: "owner@gmail.invalid" },
    { address: "catch-all@product.invalid", name: "Everything else", forwardTo: "owner@gmail.invalid" },
  ],
  catchAll: [{ domain: "product.invalid", mailbox: "catch-all@product.invalid" }],
};

test("applying a setup serves its domains and mailboxes at once, and again changes nothing", async () => {
  const { mf, call } = await fixture();
  try {
    const first = await call("/api/setup/apply", setup);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.domainsAdded, ["product.invalid"]);
    assert.deepEqual(first.body.catchAllSet, ["product.invalid"]);
    assert.deepEqual(first.body.mailboxes.map((m: any) => m.outcome), ["created", "created"]);
    const again = await call("/api/setup/apply", setup);
    assert.deepEqual(again.body.domainsAdded, []);
    assert.deepEqual(again.body.mailboxes.map((m: any) => m.outcome), ["unchanged", "unchanged"]);
    assert.equal((await call("/api/setup/apply", { ...setup, domains: [] })).status, 400, "an invalid file is refused whole");
  } finally { await mf.dispose(); }
});

test("mail is kept and the original still reaches its old destination; unknown addresses land in the catch-all", async () => {
  const { mf, call, text } = await fixture();
  try {
    await call("/api/setup/apply", setup);
    const known = await call("/receive", { to: "support@product.invalid", raw: mail("support@product.invalid", "m1") });
    assert.equal(known.body.result.forwarded, "sent");
    assert.deepEqual(known.body.forwards, ["owner@gmail.invalid"]);
    assert.equal((await call("/inbox?box=support@product.invalid")).body.length, 1);
    const unknown = await call("/receive", { to: "random@product.invalid", raw: mail("random@product.invalid", "m2") });
    assert.equal(unknown.body.rejected, null, "a catch-all domain does not bounce");
    assert.equal(unknown.body.result.mailboxId, "catch-all@product.invalid");
    assert.deepEqual(unknown.body.forwards, ["owner@gmail.invalid"]);
    const other = await call("/receive", { to: "x@nowhere.invalid", raw: mail("x@nowhere.invalid", "m3") });
    assert.match(other.body.rejected, /not served/);
  } finally { await mf.dispose(); }
});

test("a refused forward keeps the mail and is recorded for the operator", async () => {
  const { mf, call, text } = await fixture();
  try {
    await call("/api/setup/apply", setup);
    const r = await call("/receive", { to: "support@product.invalid", raw: mail("support@product.invalid", "m4"), forwardFails: true });
    assert.equal(r.body.result.inserted, true);
    assert.equal(r.body.result.forwarded, "failed");
    assert.equal((await call("/inbox?box=support@product.invalid")).body.length, 1);
    const issue = JSON.parse(await text(`/r2?key=${issueKey("support@product.invalid")}`));
    assert.match(issue.problem, /destination not verified/);
    assert.equal(issue.target, "owner@gmail.invalid");
  } finally { await mf.dispose(); }
});

test("export returns the applied setup in the same format", async () => {
  const { mf, call } = await fixture();
  try {
    await call("/api/setup/apply", setup);
    const exported = await call("/api/setup/export");
    assert.equal(exported.body.format, SETUP_FORMAT);
    assert.deepEqual(exported.body.domains.sort(), ["base.invalid", "product.invalid"]);
    assert.deepEqual(exported.body.mailboxes.map((m: any) => [m.address, m.forwardTo]).sort(), [
      ["catch-all@product.invalid", "owner@gmail.invalid"], ["support@product.invalid", "owner@gmail.invalid"]]);
    assert.deepEqual(exported.body.catchAll, [{ domain: "product.invalid", mailbox: "catch-all@product.invalid" }]);
    assert.equal(parseSetup(exported.body).ok, true);
  } finally { await mf.dispose(); }
});

test("a successful forward retires the recorded failure for that address", async () => {
  const { mf, call, text } = await fixture();
  try {
    await call("/api/setup/apply", setup);
    await call("/receive", { to: "support@product.invalid", raw: mail("support@product.invalid", "f1"), forwardFails: true });
    assert.notEqual(await text(`/r2?key=${issueKey("support@product.invalid")}`), "null");
    const ok = await call("/receive", { to: "support@product.invalid", raw: mail("support@product.invalid", "f2") });
    assert.equal(ok.body.result.forwarded, "sent");
    assert.equal(await text(`/r2?key=${issueKey("support@product.invalid")}`), "null");
  } finally { await mf.dispose(); }
});


test("a mailbox created without an agent is Off, not silently given a drafting agent", async () => {
  const { mf, call, text } = await fixture();
  try {
    // The Mailboxes page creates with no settings at all (workers/index.ts POST /api/v1/mailboxes).
    const created = await call("/create", { email: "plain@base.invalid", name: "Plain" });
    assert.equal(created.body.status, "created");
    assert.equal(JSON.parse(await text(`/r2?key=${mailboxKey("plain@base.invalid")}`)).agent, "off");
  } finally { await mf.dispose(); }
});
