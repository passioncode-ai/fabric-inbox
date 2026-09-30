import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { NOT_TOOLS, TOOLS } from "../workers/mcp/tools";

/**
 * The rule of AP-5, as a test: every route the app serves is behind an agent tool, or excluded
 * with its reason. A new route fails here until its tool exists (workers/mcp/tools.ts) — and then
 * tests/mcp-docs.test.ts fails until docs/agents/mcp.md is regenerated (`npm run mcp:docs`).
 *
 * The list comes from the running Hono app (`api.routes`), not from reading source, so no way of
 * declaring a route escapes it.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { api } from './workers/api';
      export { EmailMCP } from './workers/mcp/ledger';
      export default { fetch: () => Response.json(api.routes.filter((r) => r.method !== 'ALL').map((r) => r.method + ' ' + r.path)) };
    `,
    resolveDir: process.cwd(), loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:*", "node:*"], target: "es2022",
  alias: { mimetext: "mimetext/browser" }, define: { "import.meta.env.DEV": "false", "import.meta.env.MODE": '"test"' },
});

async function servedRoutes(): Promise<string[]> {
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"] });
  try { return [...new Set((await (await mf.dispatchFetch("http://localhost/")).json()) as string[])].sort(); }
  finally { await mf.dispose(); }
}

test("every route the app serves is behind an agent tool or excluded with a reason (AP-5)", async () => {
  const served = await servedRoutes();
  assert.ok(served.length > 80, `the route list looks incomplete (${served.length})`);
  const covered = new Map<string, string[]>();
  for (const tool of TOOLS) for (const route of tool.routes) covered.set(route, [...(covered.get(route) ?? []), tool.name]);
  const missing = served.filter((r) => !covered.has(r) && !(r in NOT_TOOLS));
  assert.deepEqual(missing, [], `Routes with no agent tool. Add a tool in workers/mcp/tools.ts (or an exclusion with its reason in NOT_TOOLS), then run npm run mcp:docs:\n  ${missing.join("\n  ")}`);
  const stale = [...covered.keys(), ...Object.keys(NOT_TOOLS)].filter((r) => !served.includes(r));
  assert.deepEqual(stale, [], `Tools name routes the app no longer serves:\n  ${stale.join("\n  ")}`);
  const both = Object.keys(NOT_TOOLS).filter((r) => covered.has(r));
  assert.deepEqual(both, [], "a route is either a tool's or excluded, not both");
});

test("tool names are unique, in snake_case, and every tool says what it does", () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool name");
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]{2,47}$/, t.name);
    assert.ok(t.description.length >= 40, `${t.name}: describe what it does and when to use it`);
    assert.ok(t.routes.length > 0, `${t.name}: name the routes it calls`);
    if (t.sends) assert.notEqual(t.level, "read", `${t.name}: a read key never sends`);
    if (t.readOnly) assert.ok(!t.sends && !t.confirm, `${t.name}: a read-only tool neither sends nor confirms`);
  }
});

test("every irreversible route is behind a two-step tool (AP-4)", () => {
  const irreversible = ["DELETE /api/v1/mailboxes/:mailboxId/emails/:id", "DELETE /api/project-addresses/:email", "DELETE /api/v1/mailboxes/:mailboxId",
    "POST /api/domains/:domain/release", "POST /api/spam/empty", "DELETE /api/agents/:id", "DELETE /api/categories/:id", "DELETE /api/projects/:id",
    "DELETE /api/knowledge/collections/:id", "DELETE /api/knowledge/collections/:id/documents/:doc", "POST /api/accounts/:accountId/disconnect", "POST /api/setup/apply"];
  for (const route of irreversible) {
    const tools = TOOLS.filter((t) => t.routes.includes(route));
    assert.ok(tools.length, `${route} has no tool`);
    for (const t of tools) assert.ok(t.confirm, `${t.name} calls ${route} and must take two steps`);
  }
});
