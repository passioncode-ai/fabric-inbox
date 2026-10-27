import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { agentInputOf, sameAgent } from "../workers/lib/mailbox-transfer";

// B-158 M1 step 3b: what a mailbox carries besides mail (its rules, its agent and that agent's knowledge) read out of
// one server and written into another. Two workerd servers with their own Durable Objects and R2; the routes are the
// production ones, called the way export_mailbox and import_mailbox call them. No network.
const bundle = await build({
  stdin: {
    contents: `
      import { Hono } from 'hono';
      import { MailboxDO } from './workers/durableObject/index';
      import { AutomationDO } from './workers/automation/index';
      import { AgentRegistryDO } from './workers/agents/registry';
      import { KnowledgeDO } from './workers/knowledge/store';
      import { transferRouter } from './workers/routes/transfer';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO { constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); } }
      export { AutomationDO, AgentRegistryDO, KnowledgeDO };
      const app = new Hono();
      const ws = (ns, env) => env[ns].getByName('workspace');
      app.post('/test/seed', async (c) => {
        const b = await c.req.json();
        const k = ws('KNOWLEDGE', c.env);
        const col = await k.createCollection({ name: 'FAQ', description: 'Questions' });
        await k.upsertDocuments(col.id, b.documents);
        await k.createCollection({ name: 'Internal' });
        const agent = await ws('AGENT_REGISTRY', c.env).createAgent({ name: 'Support', instructions: 'Answer kindly.', knowledge: 'Hours: 9 to 5.', collections: [col.id] });
        await c.env.BUCKET.put('mailboxes/' + b.address + '.json', JSON.stringify({ fromName: 'Shop', agent: { id: agent.id } }));
        const rules = c.env.AUTOMATIONS.get(c.env.AUTOMATIONS.idFromName(b.address));
        for (const rule of b.rules) await rules.saveRule(rule);
        return c.json({ collection: col.id, agent: agent.id });
      });
      app.post('/test/collection', async (c) => c.json(await ws('KNOWLEDGE', c.env).createCollection(await c.req.json())));
      app.post('/test/state', async (c) => {
        const b = await c.req.json();
        const k = ws('KNOWLEDGE', c.env);
        const collections = await k.listCollections();
        const documents = {};
        for (const x of collections) documents[x.id] = (await k.listDocuments(x.id)).map((d) => d.sourceUri).sort();
        const settings = await c.env.BUCKET.get('mailboxes/' + b.address + '.json');
        return c.json({ rules: await c.env.AUTOMATIONS.get(c.env.AUTOMATIONS.idFromName(b.address)).rules(), agents: await ws('AGENT_REGISTRY', c.env).listAgents(),
          collections: collections.map((x) => ({ id: x.id, name: x.name })), documents, settings: settings ? await settings.json() : null });
      });
      app.route('/', transferRouter);
      export default app;
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

function server(hosts: string) {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    bindings: { AUTOMATION_MCP_HOSTS: hosts },
    durableObjects: {
      MAILBOX: { className: "TestMailbox", useSQLite: true }, AUTOMATIONS: { className: "AutomationDO", useSQLite: true },
      AGENT_REGISTRY: { className: "AgentRegistryDO", useSQLite: true }, KNOWLEDGE: { className: "KnowledgeDO", useSQLite: true },
    },
    r2Buckets: ["BUCKET"],
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
const documents = [
  { sourceUri: "faq/pricing.md", title: "Pricing", text: "It is free during the preview." },
  { sourceUri: "faq/refunds.md", title: "Refunds", text: "Refunds within 14 days." },
];
const rules = [
  { id: "receipts", version: 1, name: "Receipts to archive", enabled: true, mode: "automatic", conditions: { subject: "receipt" }, action: { type: "archive" }, dailyLimit: 20 },
  { id: "billing", version: 1, name: "Billing to the ledger", enabled: false, mode: "approval", conditions: { from: "billing@shop.invalid" },
    action: { type: "mcp", endpoint: "https://tools.project.invalid/mcp", tool: "record", arguments: {}, location: "cloud" }, dailyLimit: 5 },
];

test("B-158 step 3b: a mailbox's rules, agent and knowledge move to another server, and a repeat adds nothing", async () => {
  const a = server("tools.project.invalid"), b = server("");
  try {
    const seeded = (await a.call("POST", "/test/seed", { address: ADDRESS, documents, rules })).body;
    const setup = await a.call("GET", `${base}/setup`);
    assert.equal(setup.status, 200);
    assert.equal(setup.body.rules.length, 2);
    assert.equal(setup.body.agent.id, seeded.agent);
    assert.deepEqual(setup.body.collections.map((x: any) => [x.id, x.name, x.documents.length]), [[seeded.collection, "FAQ", 2]],
      "only the collections its agent reads, never another one on the server");

    // The receiving server already has a collection whose id the FAQ would take.
    await b.call("POST", "/test/collection", { name: "FAQ!" });
    await b.call("POST", `${base}/open`, { settings: { fromName: "Shop", agent: { id: seeded.agent } } });

    const saved = await b.call("POST", `${base}/rules`, { rules: setup.body.rules });
    assert.deepEqual(saved.body.saved, ["receipts"], JSON.stringify(saved.body));
    assert.equal(saved.body.refused.length, 1, "a tool host this server does not allow is refused with its reason");
    assert.equal(saved.body.refused[0].id, "billing");

    const map: Record<string, string> = {};
    for (const col of setup.body.collections) {
      const made = await b.call("POST", `${base}/collection`, { name: col.name, description: col.description });
      assert.deepEqual(made.body, { id: "faq-2", created: true });
      map[col.id] = made.body.id;
      const texts = [];
      for (const d of col.documents) {
        const doc = await a.call("GET", `${base}/document?collection=${col.id}&document=${d.id}`);
        assert.equal(doc.status, 200);
        texts.push({ sourceUri: doc.body.sourceUri, title: doc.body.title, revision: doc.body.revision, text: doc.body.text });
      }
      const upserted = await b.call("POST", `${base}/documents`, { collection: made.body.id, documents: texts });
      assert.equal(upserted.body.added, 2);
      assert.equal((await b.call("POST", `${base}/documents`, { collection: made.body.id, documents: texts })).body.unchanged, 2, "a repeat changes nothing");
    }

    const agent = await b.call("POST", `${base}/agent`, { agent: setup.body.agent, collections: map });
    assert.equal(agent.status, 200, JSON.stringify(agent.body));
    assert.equal(agent.body.created, true);

    // A whole repeat finds what the first made.
    assert.deepEqual((await b.call("POST", `${base}/collection`, { name: "FAQ" })).body, { id: "faq-2", created: false });
    assert.deepEqual((await b.call("POST", `${base}/agent`, { agent: setup.body.agent, collections: map })).body, { id: agent.body.id, created: false });
    assert.deepEqual((await b.call("POST", `${base}/rules`, { rules: setup.body.rules.filter((r: any) => r.id === "receipts") })).body.saved, ["receipts"]);

    const state = (await b.call("POST", "/test/state", { address: ADDRESS })).body;
    assert.deepEqual(state.rules.map((r: any) => [r.id, r.enabled]), [["receipts", true]], "an enabled rule stays enabled");
    assert.equal(state.agents.length, 1);
    assert.deepEqual(state.agents[0].collections, ["faq-2"], "the agent reads the collection as it is named here");
    assert.equal(state.agents[0].knowledge, "Hours: 9 to 5.");
    assert.deepEqual(state.documents["faq-2"], ["faq/pricing.md", "faq/refunds.md"]);
    assert.deepEqual(state.documents.faq, [], "the collection that was already here is left alone");
    assert.equal(state.settings.agent, "off", "the agent is not assigned until the address's mail comes here");
  } finally { await a.mf.dispose(); await b.mf.dispose(); }
});

test("B-158 step 3b: a document of a collection the mailbox's agent does not read, or of no mailbox, is refused", async () => {
  const a = server("tools.project.invalid");
  try {
    await a.call("POST", "/test/seed", { address: ADDRESS, documents, rules: [] });
    const internal = (await a.call("POST", "/test/state", { address: ADDRESS })).body.collections.find((x: any) => x.name === "Internal").id;
    assert.equal((await a.call("GET", `${base}/document?collection=${internal}&document=x`)).status, 404);
    assert.equal((await a.call("GET", `/api/transfer/${encodeURIComponent("other@shop.invalid")}/setup`)).status, 404);
    assert.equal((await a.call("POST", `${base}/agent`, { agent: { id: "x", name: "X", instructions: "Y", collections: ["nowhere"] } })).status, 400);
  } finally { await a.mf.dispose(); }
});

test("an agent definition crosses without its id, version or the schema the registry reads itself", () => {
  const sent = { id: "support", version: 7, createdAt: "2026-10-01", name: "Support", instructions: "Answer.", knowledge: "", collections: ["faq", "prices"],
    tools: [{ name: "lookup", description: "Look up", endpoint: "https://t.invalid/mcp", tool: "lookup", inputSchema: "{}", readOnly: true }], replyPolicy: { mode: "draft" } };
  const input = agentInputOf(sent, { faq: "faq-2" });
  assert.deepEqual(input.collections, ["faq-2", "prices"]);
  assert.deepEqual(input.tools, [{ name: "lookup", description: "Look up", endpoint: "https://t.invalid/mcp", tool: "lookup" }]);
  assert.ok(!("id" in input) && !("version" in input));
  assert.ok(sameAgent({ ...sent, id: "other", collections: ["faq-2", "prices"] }, input));
  assert.ok(!sameAgent({ ...sent, instructions: "Different." }, input));
});
