// B-205 step 2: the server's operations per hour, folded on read into ops.digest (docs/app-store/tasks/2026-11-04-server-error-counts.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { capNames, closedDay, closedHour, foldDay, foldHour, MAX_NAMED_OPS, OVERFLOW_OP } from "../workers/lib/ops-digest";

const row = (hour: string, op: string, ok: number, failed: number, unknown = 0) => ({ hour, op, ok, failed, unknown });

test("B-205: an hour folds with Fabric's rise rule, against the hour before only", () => {
  const h = foldHour("2026-11-04T10", [row("2026-11-04T10", "send.accepted", 4, 0), row("2026-11-04T10", "http.agents", 0, 12)], [{ op: "http.agents", ok: 0, failed: 5, unknown: 0 }]);
  assert.deepEqual([h.schema, h.from, h.to], ["ops.digest.hourly@1", "2026-11-04T10:00:00.000Z", "2026-11-04T11:00:00.000Z"]);
  assert.deepEqual(h.ops.map((c) => c.op), ["http.agents", "send.accepted"], "by name, without the hour key");
  assert.deepEqual(h.total, { ok: 4, failed: 12, unknown: 0 });
  assert.deepEqual(h.risen, [{ op: "http.agents", failed: 12, previous: 5 }]);
  assert.equal(foldHour("2026-11-04T10", [row("2026-11-04T10", "x.y", 0, 9)], []).risen.length, 0, "under 10 is never a rise");
});

test("B-205: a day folds its hours, each against the one just before, the first against the day before's last", () => {
  const rows = [row("2026-11-04T00", "http.agents", 0, 11), row("2026-11-04T01", "http.agents", 0, 30), row("2026-11-04T05", "http.agents", 0, 10), row("2026-11-05T00", "http.agents", 0, 99)];
  const d = foldDay("2026-11-04", rows, [{ op: "http.agents", ok: 0, failed: 20, unknown: 0 }]);
  assert.deepEqual([d!.schema, d!.day, d!.hours, d!.total.failed], ["ops.digest.daily@1", "2026-11-04", 3, 51], "only the day's own hours");
  // 00: 11 vs 20 the day before: no; 01: 30 vs 11: rise; 05: 10 after a gap: rise.
  assert.deepEqual(d!.risen, [{ op: "http.agents", hours: 2, failed: 40 }]);
  assert.equal(foldDay("2026-11-03", rows), null, "a day with nothing counted has no digest: the contract's hours is 1 to 24");
});

test("B-205: only a closed hour or day of the last 14 days is read", () => {
  const now = Date.parse("2026-11-04T12:30:00Z");
  assert.equal(closedHour("2026-11-04T11", now), "2026-11-04T11");
  for (const bad of ["2026-11-04T12", "2026-10-20T10", "2026-11-04", "x"]) assert.equal(closedHour(bad, now), null, bad);
  assert.equal(closedDay(undefined, now), "2026-11-03");
  for (const bad of ["2026-11-04", "2026-10-20", "2026-13-01"]) assert.equal(closedDay(bad, now), null, bad);
});

test("B-205: the ledger counts each operation per hour and outcome, an error also as a failed op, and keeps 14 days", async () => {
  const bundle = await build({
    stdin: { contents: `
      import { EmailMCP } from './workers/mcp/ledger';
      export { EmailMCP };
      export default { async fetch(request, env) {
        const c = await request.json(); const l = env.EMAIL_MCP.getByName('workspace');
        if (c.op === 'count') { for (const [op, outcome, at] of c.items) await l.countOp(op, outcome, at); return Response.json(true); }
        if (c.op === 'error') { await l.countError(c.cls, c.code, c.at); return Response.json(true); }
        return Response.json(await l.opsHours(c.prefix));
      } };`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
  });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { EMAIL_MCP: { className: "EmailMCP", useSQLite: true } } });
  const call = async (body: unknown) => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify(body) })).json();
  try {
    const at = (iso: string) => Date.parse(iso);
    await call({ op: "count", items: [["send.accepted", "ok", at("2026-11-04T10:05:00Z")], ["send.accepted", "ok", at("2026-11-04T10:50:00Z")],
      ["agent.sent", "ok", at("2026-11-04T11:01:00Z")]] });
    await call({ op: "error", cls: "send", code: "transport_outcome_unknown", at: at("2026-11-04T10:30:00Z") });
    assert.deepEqual(await call({ prefix: "2026-11-04T10" }), [
      { hour: "2026-11-04T10", op: "send.accepted", ok: 2, failed: 0, unknown: 0 },
      { hour: "2026-11-04T10", op: "send.transport_outcome_unknown", ok: 0, failed: 1, unknown: 0 }]);
    assert.equal((await call({ prefix: "2026-11-04" }) as unknown[]).length, 3, "a day reads all its hours");
    await call({ op: "count", items: [["agent.sent", "ok", at("2026-11-19T10:00:00Z")]] });
    assert.deepEqual(await call({ prefix: "2026-11-04" }), [], "15 days later the hours are gone");
  } finally { await mf.dispose(); }
});

test("B-205: successes are counted only for received messages, ended runs and accepted sends, never on a request's path", () => {
  assert.match(readFileSync("workers/index.ts", "utf8"), /void countOk\(env, "incoming", "received"/);
  assert.match(readFileSync("workers/agents/registry.ts", "utf8"), /void countOk\(this\.env, "agent", run\.status\)/);
  assert.match(readFileSync("workers/durableObject/index.ts", "utf8"), /accepted: \(\) => \{ void countOk\(this\.env, "send", "accepted"\); \}/);
  assert.doesNotMatch(readFileSync("workers/app.ts", "utf8"), /countOk/, "a request is counted only when it fails");
  assert.match(readFileSync("workers/routes/server-errors.ts", "utf8"), /digest \? c\.json\(digest\) : c\.json\(\{ error: msg\("Nothing was counted on \{day\}"/, "an empty day answers 404");
});

test("B-212: a second row of one hour and operation is folded once, the first kept (DEC-0153 OD-5)", () => {
  const rows = [row("2026-11-04T01", "x", 1, 2), row("2026-11-04T01", "x", 1, 2), row("2026-11-04T02", "x", 0, 3)];
  assert.deepEqual(foldDay("2026-11-04", rows)!.total, { ok: 1, failed: 5, unknown: 0 });
});


test("B-213: past 4095 names in a day the rest are summed under ops_overflow in their hour, counts kept (OD-3)", () => {
  const rows = Array.from({ length: MAX_NAMED_OPS + 3 }, (_, i) => ({ hour: i % 2 ? "2026-11-03T10" : "2026-11-03T11", op: `op.${String(i).padStart(5, "0")}`, ok: 1, failed: 0, unknown: 0 }));
  const capped = capNames(rows);
  assert.equal(new Set(capped.map((r) => r.op)).size, MAX_NAMED_OPS + 1);
  assert.deepEqual(capped.filter((r) => r.op === OVERFLOW_OP).map((r) => [r.hour, r.ok]).sort(), [["2026-11-03T10", 2], ["2026-11-03T11", 1]]);
  const day = foldDay("2026-11-03", rows)!;
  assert.equal(day.ops.length, MAX_NAMED_OPS + 1, "the day's line holds 4096 operations");
  assert.equal(day.total.ok, MAX_NAMED_OPS + 3);
  const small = rows.slice(0, 10);
  assert.equal(capNames(small), small, "within the limit: as they were");
});
