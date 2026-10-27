import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { builtinModules } from "node:module";

/**
 * B-181 step 1 (SCN-089) in workerd: the campaigns object behind its routes. A campaign is prepared only from a
 * connected Gmail, Outlook or IMAP account; recipients skip repeats, invalid addresses and the do-not-write list;
 * preview names the fields some recipients lack; the dry run spaces sends inside the window and sends nothing;
 * a changed draft needs the version read; adding to the do-not-write list takes queued recipients out at once.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { DurableObject } from 'cloudflare:workers';
      import { Hono } from 'hono';
      import { campaignsRouter } from './workers/routes/campaigns';
      export { CampaignsDO } from './workers/campaigns/store';
      export class FakeAccounts extends DurableObject {
        async listAccounts() { return { accounts: [{ id: 'g1', provider: 'gmail' }, { id: 'o1', provider: 'outlook' }] }; }
      }
      const app = new Hono();
      app.route('/', campaignsRouter);
      export default { fetch: (request, env, ctx) => app.fetch(request, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser",
  external: ["cloudflare:*", "node:*", ...builtinModules], alias: { mimetext: "mimetext/browser" }, target: "es2022",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/');" },
});

const steps = [{ subject: "Hi {{first_name|there}}", body: "Hello {{first_name}}, about {{company}}." }, { body: "Following up.", delayDays: 3 }];
const draft = (over: Record<string, unknown> = {}) => ({ name: "Pilot", sender: "gmail:g1", timezone: "UTC", steps, ...over });

test("SCN-089: prepare, add, preview, dry-run and the do-not-write list, nothing sent", async () => {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CAMPAIGNS: { className: "CampaignsDO", useSQLite: true }, GMAIL_ACCOUNTS: { className: "FakeAccounts", useSQLite: true } },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await mf.dispatchFetch(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: r.status === 204 ? null : await r.json() as any };
  };
  try {
    // Only a connected Gmail, Outlook or IMAP account sends; Cloudflare and an unknown account are refused.
    assert.equal((await call("POST", "/api/campaigns", { campaign: draft({ sender: "cloudflare:hi@owner.example" }) })).status, 400);
    const unknown = await call("POST", "/api/campaigns", { campaign: draft({ sender: "gmail:nobody" }) });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /not a connected account/);
    assert.equal((await call("POST", "/api/campaigns", { campaign: draft({ window: { start: "17:00", end: "09:00" } }) })).status, 400);
    assert.equal((await call("POST", "/api/campaigns", { campaign: draft({ dailyCap: 500 }) })).status, 400, "the ceiling is 50 a day");

    const created = await call("POST", "/api/campaigns", { campaign: draft() });
    assert.equal(created.status, 201);
    const id = created.json.id as string;
    assert.equal(created.json.state, "draft");
    assert.equal(created.json.dailyCap, 30, "human-paced by default");

    // Recipients: a repeat, an invalid address and one already on the list are left out with why.
    assert.equal((await call("POST", "/api/suppression", { add: ["blocked.example"], reason: "asked" })).status, 200);
    const added = await call("POST", `/api/campaigns/${id}/recipients`, { recipients: [
      { email: "Ann@Acme.example", fields: { first_name: "Ann", company: "Acme" } },
      { email: "ann@acme.example" }, { email: "not an address" }, { email: "bob@sub.blocked.example" },
      { email: "cy@beta.example", fields: { company: "Beta" } },
    ] });
    assert.equal(added.json.added, 2);
    assert.deepEqual(added.json.skipped.map((s: { why: string }) => s.why).sort(), ["invalid", "repeat", "suppressed"]);

    // Preview fills the fields and names the one a recipient lacks; the fallback covers the subject.
    const preview = await call("POST", `/api/campaigns/${id}/preview`, { email: "cy@beta.example" });
    assert.equal(preview.json.steps[0].subject, "Hi there");
    assert.deepEqual(preview.json.steps[0].missing, ["first_name"]);
    assert.deepEqual(preview.json.lacking, [{ field: "first_name", recipients: 1, examples: ["cy@beta.example"] }]);

    // The dry run spaces the sends 5 to 10 minutes apart, inside the weekday window, and changes nothing.
    const run = await call("POST", `/api/campaigns/${id}/dry-run`, { count: 10 });
    assert.equal(run.json.sends.length, 2);
    const [a, b] = run.json.sends.map((s: { at: string }) => new Date(s.at));
    const gap = (b.getTime() - a.getTime()) / 60_000;
    // Late in the day the second send no longer fits the window and waits for the next one, which opens at 09:00 UTC.
    const nextWindow = b.getUTCHours() === 9 && b.getUTCMinutes() < 30;
    assert.ok(gap >= 5 && (gap <= 10 || nextWindow), `gap ${gap}`);
    for (const t of [a, b]) { assert.ok(t.getUTCDay() >= 1 && t.getUTCDay() <= 5); assert.ok(t.getUTCHours() >= 9 && t.getUTCHours() < 17); }
    assert.equal(run.json.queued, 2);

    // A draft changes only with the version read.
    assert.equal((await call("PUT", `/api/campaigns/${id}`, { campaign: draft({ name: "Pilot 2" }), expectedVersion: 7 })).status, 409);
    const changed = await call("PUT", `/api/campaigns/${id}`, { campaign: draft({ name: "Pilot 2" }), expectedVersion: 1 });
    assert.equal(changed.json.version, 2);

    // The do-not-write list takes a queued recipient out of every campaign at once.
    const blocked = await call("POST", "/api/suppression", { add: ["cy@beta.example"], reason: "unsubscribed" });
    assert.equal(blocked.json.removedRecipients, 1);
    assert.deepEqual((await call("GET", `/api/campaigns/${id}`)).json.counts, { queued: 1, suppressed: 1 });
    assert.equal((await call("GET", `/api/campaigns/${id}/recipients?status=suppressed`)).json.total, 1);
    assert.equal((await call("POST", "/api/suppression", { remove: ["cy@beta.example"] })).json.removed, 1);

    assert.equal((await call("POST", `/api/campaigns/${id}/recipients`, { remove: ["ann@acme.example"] })).json.removed, 1);
    assert.equal((await call("DELETE", `/api/campaigns/${id}`)).status, 204);
    assert.equal((await call("GET", `/api/campaigns/${id}`)).status, 404);
    assert.equal((await call("POST", `/api/campaigns/${id}/preview`, {})).status, 404);
  } finally {
    await mf.dispose();
  }
});
