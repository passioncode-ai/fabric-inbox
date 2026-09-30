import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { chunkText, ftsQuery } from "../workers/knowledge/text";

/**
 * Knowledge for agents (KN-1..KN-4) in workerd: the store and its FTS5 index,
 * the API, agent grants, and a real run through AgentRegistryDO whose model is
 * scripted and whose system prompt is recorded.
 */

test("chunks follow paragraphs and keep their heading; a long paragraph is cut", () => {
  const text = "# Pricing\n\nFree during the preview.\n\n## Support\n\n" + "Weekdays 10–18 CET. ".repeat(120);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  assert.match(chunks[0].text, /^Pricing\nFree during the preview\./);
  assert.ok(chunks.slice(1).every((c) => c.text.startsWith("Support\n")), "every chunk under a heading says so");
  assert.ok(chunks.every((c) => c.text.length <= 1720));
  assert.deepEqual(chunkText("   \n\n "), []);
});

test("free text becomes quoted terms; FTS syntax from an email stays literal", () => {
  assert.equal(ftsQuery("Hello, how much does it COST?"), '"much" OR "does" OR "cost"');
  assert.equal(ftsQuery("стоимость подписки"), '"стоимос"* OR "подпис"*');
  const hostile = ftsQuery('price" OR NEAR(a b) * ^col: -x ')!;
  assert.ok(!/NEAR\(|\^|col:/.test(hostile.replace(/"[^"]*"\*?/g, "")), `only quoted terms remain: ${hostile}`);
  assert.equal(ftsQuery("?? !! --"), null);
});

const bundle = await build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { MailboxDO } from './workers/durableObject/index';
      import { AgentRegistryDO } from './workers/agents/registry';
      import { KnowledgeDO } from './workers/knowledge/store';
      import { knowledgeRouter } from './workers/routes/knowledge';
      import { agentsRouter } from './workers/routes/agents';
      import { receiveEmail } from './workers/index';
      const forbidden = () => { throw new Error('External AI and tools are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send: async () => ({ messageId: '<r@test>' })}}); }
        async folder(name) { return this.getEmails({folder:name}); }
      }
      export class TestRegistry extends AgentRegistryDO {
        deps(mailboxId) {
          const real = super.deps(mailboxId);
          const env = this.env;
          return {...real, injection: async () => ({ flagged: false }), callTool: forbidden,
            knowledge: env.BROKEN_KNOWLEDGE === '1' ? { search: async () => { throw new Error('index offline'); } } : real.knowledge,
            model: async (request) => {
              await env.BUCKET.put('test/last-system.txt', request.system);
              await env.BUCKET.put('test/tools.json', JSON.stringify(request.tools.map((t) => t.name)));
              const tool = request.tools.find((t) => t.name === 'search_knowledge');
              const followUp = tool ? await tool.run({ query: 'refund policy' }) : '';
              await env.BUCKET.put('test/follow-up.txt', followUp);
              return { decision: { decision: 'send', intent: 'pricing', grounded: true, body: 'It is free during the preview.', reason: '' }, text: '' };
            }};
        }
        async pump() { return this.alarm(); }
      }
      export { KnowledgeDO };
      const app = new Hono();
      app.post('/receive', async (c) => {
        const m = await c.req.json();
        const bytes = new TextEncoder().encode(m.raw);
        await receiveEmail({ to: m.to, from: 'ann@customer.invalid', rawSize: bytes.length, raw: new Response(bytes).body, setReject: () => {}, forward: async () => {} }, c.env, c.executionCtx);
        return c.json({ ok: true });
      });
      app.post('/pump', async (c) => { await c.env.AGENT_REGISTRY.getByName('workspace').pump(); return c.json({ ok: true }); });
      app.get('/runs', async (c) => c.json(await c.env.AGENT_REGISTRY.getByName('workspace').listRuns({})));
      app.get('/r2', async (c) => { const o = await c.env.BUCKET.get(c.req.query('key')); return new Response(o ? await o.text() : 'null'); });
      app.post('/mailbox', async (c) => { const b = await c.req.json(); await c.env.BUCKET.put('mailboxes/' + b.email + '.json', JSON.stringify(b.settings)); return c.json({ ok: true }); });
      app.route('/', knowledgeRouter);
      app.route('/', agentsRouter);
      export default { fetch: (r, env, ctx) => app.fetch(r, env, ctx) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

async function fixture(bindings: Record<string, string> = {}) {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      MAILBOX: { className: "TestMailbox", useSQLite: true },
      AGENT_REGISTRY: { className: "TestRegistry", useSQLite: true },
      KNOWLEDGE: { className: "KnowledgeDO", useSQLite: true },
    },
    r2Buckets: ["BUCKET"], bindings: { DOMAINS: "project.invalid", ...bindings },
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await mf.dispatchFetch("http://localhost" + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  };
  return { mf, call };
}

const FAQ = [
  { sourceUri: "faq/pricing.md", title: "Pricing", text: "# Pricing\n\nFabric Inbox is free during the preview. Prices for teams come later." },
  { sourceUri: "faq/support.md", title: "Support hours", text: "Support answers on weekdays, 10:00–18:00 CET." },
  { sourceUri: "faq/ru.md", title: "Стоимость", text: "Стоимость подписки: бесплатно во время превью." },
];

test("collections are searched by relevance, in Russian and English, and only where asked", async () => {
  const { mf, call } = await fixture();
  try {
    const faq = (await call("/api/knowledge/collections", "POST", { name: "Customer FAQ", description: "Public answers" })).body;
    assert.equal(faq.id, "customer-faq");
    const internal = (await call("/api/knowledge/collections", "POST", { name: "Internal notes" })).body;
    const first = await call(`/api/knowledge/collections/${faq.id}/documents`, "POST", { documents: FAQ });
    assert.deepEqual([first.body.added, first.body.refused.length], [3, 0]);
    await call(`/api/knowledge/collections/${internal.id}/documents`, "POST", { documents: [{ sourceUri: "secret.md", title: "Margins", text: "Our margin on the team price is 80 percent." }] });

    const en = (await call(`/api/knowledge/search?q=${encodeURIComponent("what are your prices?")}&collections=${faq.id}`)).body.hits;
    assert.equal(en[0].title, "Pricing", "“prices” finds “Prices”");
    assert.match(en[0].snippet, /«/);
    const ru = (await call(`/api/knowledge/search?q=${encodeURIComponent("какая стоимость?")}&collections=${faq.id}`)).body.hits;
    assert.equal(ru[0].sourceUri, "faq/ru.md");
    const scoped = (await call(`/api/knowledge/search?q=margin%20price&collections=${faq.id}`)).body.hits;
    assert.ok(scoped.every((h: any) => h.collectionId === faq.id), "another collection never leaks in");
    assert.equal((await call(`/api/knowledge/search?q=price`)).status, 400, "no collection named, no search");
    const hostile = await call(`/api/knowledge/search?q=${encodeURIComponent('price" OR NEAR(a b) *')}&collections=${faq.id}`);
    assert.equal(hostile.status, 200, "FTS syntax in a query is literal, not an error");

    const listed = (await call("/api/knowledge/collections")).body.collections.find((x: any) => x.id === faq.id);
    assert.deepEqual([listed.documents, listed.source.kind], [3, "manual"]);
  } finally { await mf.dispose(); }
});

test("documents are upserted by source: unchanged is a no-op, a new revision replaces, prune syncs, limits refuse one document", async () => {
  const { mf, call } = await fixture();
  try {
    const id = (await call("/api/knowledge/collections", "POST", { name: "Sync", source: { kind: "fabric", project: "project:acme", scope: "public" } })).body.id;
    const path = `/api/knowledge/collections/${id}/documents`;
    await call(path, "POST", { documents: FAQ });
    const again = (await call(path, "POST", { documents: FAQ })).body;
    assert.deepEqual([again.added, again.updated, again.unchanged], [0, 0, 3]);
    const changed = (await call(path, "POST", { documents: [{ ...FAQ[0], text: "Fabric Inbox costs 5 EUR a month.", revision: "r2" }] })).body;
    assert.equal(changed.updated, 1);
    const old = (await call(`/api/knowledge/search?q=preview&collections=${id}`)).body.hits;
    assert.ok(!old.some((h: any) => h.sourceUri === "faq/pricing.md"), "the old revision's text is gone");
    const sync = (await call(path, "POST", { documents: [FAQ[1]], prune: true })).body;
    assert.deepEqual([sync.unchanged, sync.removed], [1, 2]);
    const refused = (await call(path, "POST", { documents: [{ sourceUri: "empty.md", title: "", text: "   " }, { sourceUri: "ok.md", title: "OK", text: "fine" }] })).body;
    assert.deepEqual([refused.added, refused.refused.map((r: any) => r.sourceUri)], [1, ["empty.md"]]);
    assert.equal((await call(path, "POST", { documents: [{ sourceUri: "big.md", title: "", text: "x".repeat(200_001) }] })).status, 400);
    const docs = (await call(`/api/knowledge/collections/${id}`)).body.documents;
    const one = (await call(`/api/knowledge/collections/${id}/documents/${docs[0].id}`)).body;
    assert.ok(one.text.length > 0);
    assert.equal((await call(`/api/knowledge/collections/${id}/documents/${docs[0].id}`, "DELETE")).status, 204);
    assert.equal((await call(`/api/knowledge/collections/${id}`)).body.collection.source.project, "project:acme");
  } finally { await mf.dispose(); }
});

test("an agent is granted only collections that exist, and a collection in use cannot be deleted", async () => {
  const { mf, call } = await fixture();
  try {
    const bad = await call("/api/agents", "POST", { agent: { name: "Support", instructions: "Answer.", collections: ["nope"] } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /No such knowledge collection: nope/);
    const reserved = await call("/api/agents", "POST", { agent: { name: "Support", instructions: "Answer.", tools: [{ name: "search_knowledge", description: "x", endpoint: "https://t.example/mcp", tool: "x" }] } });
    assert.equal(reserved.status, 400, "a granted tool cannot take a built-in name");
    const faq = (await call("/api/knowledge/collections", "POST", { name: "FAQ" })).body.id;
    const made = await call("/api/agents", "POST", { agent: { name: "Support", instructions: "Answer.", collections: [faq] } });
    assert.equal(made.status, 201);
    const listed = (await call("/api/knowledge/collections")).body.collections[0];
    assert.deepEqual(listed.agents, ["Support"]);
    const del = await call(`/api/knowledge/collections/${faq}`, "DELETE");
    assert.equal(del.status, 409);
    assert.match(del.body.error, /Used by Support/);
  } finally { await mf.dispose(); }
});

const mail = (subject: string, body: string) =>
  `From: Ann <ann@customer.invalid>\r\nTo: support@project.invalid\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random()}@customer.invalid>\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;

test("a run gives the model passages from the agent's collections only, offers search_knowledge, and records the sources", async () => {
  const { mf, call } = await fixture();
  try {
    const faq = (await call("/api/knowledge/collections", "POST", { name: "FAQ" })).body.id;
    const internal = (await call("/api/knowledge/collections", "POST", { name: "Internal" })).body.id;
    await call(`/api/knowledge/collections/${faq}/documents`, "POST", { documents: [...FAQ, { sourceUri: "faq/refunds.md", title: "Refunds", text: "Refund policy: nothing to refund while the preview is free." }] });
    await call(`/api/knowledge/collections/${internal}/documents`, "POST", { documents: [{ sourceUri: "margins.md", title: "Margins", text: "The price margin is 80 percent. Price internals." }] });
    const agent = (await call("/api/agents", "POST", { agent: { name: "Support", instructions: "Answer from the FAQ.", collections: [faq],
      replyPolicy: { mode: "auto", allowedIntents: ["pricing"], dailySendLimit: 5 } } })).body;
    await call("/mailbox", "POST", { email: "support@project.invalid", settings: { agent: { id: agent.id } } });
    await call("/receive", "POST", { to: "support@project.invalid", raw: mail("What is the price?", "How much does Fabric Inbox cost?") });
    await call("/pump", "POST");
    const system = (await call("/r2?key=test/last-system.txt")).body as string;
    assert.match(system, /<passages>[\s\S]*Pricing — faq\/pricing\.md[\s\S]*free during the preview/);
    assert.doesNotMatch(system, /margin/i, "another collection never reaches the prompt");
    assert.deepEqual((await call("/r2?key=test/tools.json")).body, ["search_knowledge"]);
    assert.match((await call("/r2?key=test/follow-up.txt")).body as string, /Refunds — faq\/refunds\.md/);
    const run = (await call("/runs")).body[0];
    assert.equal(run.status, "sent");
    assert.ok(run.sources.some((s: any) => s.sourceUri === "faq/pricing.md") && run.sources.some((s: any) => s.sourceUri === "faq/refunds.md"), JSON.stringify(run.sources));
    assert.ok(run.sources.every((s: any) => s.collectionId === faq));
    assert.ok(run.toolCalls.some((t: any) => t.name === "search_knowledge" && t.ok));
  } finally { await mf.dispose(); }
});

test("when the knowledge cannot be searched, the answer is kept as a draft with the reason", async () => {
  const { mf, call } = await fixture({ BROKEN_KNOWLEDGE: "1" });
  try {
    const faq = (await call("/api/knowledge/collections", "POST", { name: "FAQ" })).body.id;
    const agent = (await call("/api/agents", "POST", { agent: { name: "Support", instructions: "Answer.", collections: [faq],
      replyPolicy: { mode: "auto", allowedIntents: ["pricing"], dailySendLimit: 5 } } })).body;
    await call("/mailbox", "POST", { email: "support@project.invalid", settings: { agent: { id: agent.id } } });
    await call("/receive", "POST", { to: "support@project.invalid", raw: mail("Price?", "How much?") });
    await call("/pump", "POST");
    const run = (await call("/runs")).body[0];
    assert.equal(run.status, "drafted", "an auto agent does not send without its knowledge");
    assert.match(run.reason, /knowledge could not be searched \(index offline\)/);
  } finally { await mf.dispose(); }
});
