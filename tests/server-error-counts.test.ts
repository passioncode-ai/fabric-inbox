// B-203: the server's own error counts per UTC day, class and code (docs/app-store/tasks/2026-11-04-server-error-counts.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { countError, errorCode, errorDay, routeGroup } from "../workers/lib/error-counts";

test("B-203: only a code of the fixed shape is counted; a message, an address or a path is other", () => {
  assert.equal(errorCode("held_retry_failed"), "held_retry_failed");
  assert.equal(errorCode("TRANSPORT_OUTCOME_UNKNOWN"), "transport_outcome_unknown");
  assert.equal(errorCode("E_RATE-LIMIT.EXCEEDED"), "e_rate_limit_exceeded");
  for (const bad of ["owner@acme.example", "/api/agents", "Connection reset by peer", "x".repeat(49), "", null, 7, "1abc"])
    assert.equal(errorCode(bad), "other", String(bad));
  assert.equal(routeGroup("/api/agents/support/evals"), "agents");
  assert.equal(routeGroup("/api/v1/mailboxes/a@acme.example/emails"), "v1_mailboxes");
  assert.equal(routeGroup("/settings/agents"), "page");
});

test("B-203: the day read is a UTC date of the last 14 days, yesterday by default", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  assert.equal(errorDay(undefined, now), "2026-11-03");
  assert.equal(errorDay("2026-11-04", now), "2026-11-04");
  assert.equal(errorDay("2026-10-21", now), "2026-10-21");
  for (const bad of ["2026-10-20", "2026-11-05", "yesterday", "2026-13-01"]) assert.equal(errorDay(bad, now), null, bad);
});

test("B-203: counting never throws and never waits on the request: a ledger that fails is one log line", async () => {
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => { warned.push(line); };
  try {
    const kept: Promise<unknown>[] = [];
    await countError({ EMAIL_MCP: { getByName: () => ({ countError: async () => { throw new Error("down"); } }) } }, "http", "agents", (p) => kept.push(p));
    assert.equal(kept.length, 1, "handed to waitUntil");
    assert.equal(JSON.parse(warned[0]).event, "error_count_failed");
    await countError({}, "alarm", "x"); // no ledger bound: nothing, no throw
  } finally { console.warn = original; }
});

test("B-203: the ledger counts per day, class and code, answers a day's counts largest first and keeps 14 days", async () => {
  const bundle = await build({
    stdin: { contents: `
      import { EmailMCP } from './workers/mcp/ledger';
      export { EmailMCP };
      export default { async fetch(request, env) {
        const c = await request.json(); const l = env.EMAIL_MCP.getByName('workspace');
        if (c.op === 'count') { for (const [cls, code, at] of c.items) await l.countError(cls, code, at); return Response.json(true); }
        return Response.json(await l.errorCounts(c.day));
      } };`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
  });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { EMAIL_MCP: { className: "EmailMCP", useSQLite: true } } });
  const call = async (body: unknown) => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(body) })).json();
  try {
    const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
    await call({ op: "count", items: [["http", "agents", at("2026-11-03")], ["send", "transport_outcome_unknown", at("2026-11-03")],
      ["send", "transport_outcome_unknown", at("2026-11-03")], ["alarm", "held_retry_failed", at("2026-11-02")]] });
    assert.deepEqual(await call({ day: "2026-11-03" }), { "send.transport_outcome_unknown": 2, "http.agents": 1 });
    assert.deepEqual(await call({ day: "2026-11-02" }), { "alarm.held_retry_failed": 1 });
    // A count 15 days later drops the days past 14.
    await call({ op: "count", items: [["http", "agents", at("2026-11-17")]] });
    assert.deepEqual(await call({ day: "2026-11-02" }), {});
    assert.deepEqual(await call({ day: "2026-11-03" }), { "send.transport_outcome_unknown": 2, "http.agents": 1 });
  } finally { await mf.dispose(); }
});

test("B-203: every answer 5xx is counted by its route group, and every planned catch counts its class", () => {
  const app = readFileSync("workers/app.ts", "utf8");
  assert.match(app, /if \(c\.res\.status >= 500\) void countError\(c\.env, "http", routeGroup/);
  assert.match(app, /app\.onError\(/);
  assert.match(readFileSync("workers/index.ts", "utf8"), /await countError\(env, "incoming"/);
  assert.match(readFileSync("workers/durableObject/index.ts", "utf8"), /ended: \(code\) => \{ void countError\(this\.env, "send", code\); \}/);
  assert.match(readFileSync("workers/agents/registry.ts", "utf8"), /run\.status === "failed"\) void countError\(this\.env, "agent", run\.failure/);
  const counted = (file: string) => (readFileSync(file, "utf8").match(/countLog\(this\.env, "(alarm|sync)"/g) ?? []).length;
  assert.deepEqual([counted("workers/agents/registry.ts"), counted("workers/providers/accounts-do.ts"), counted("workers/categories/store.ts"), counted("workers/campaigns/store.ts"), counted("workers/automation/index.ts")], [10, 8, 3, 1, 1]);
});
