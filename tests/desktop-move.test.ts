import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMover, describe } = require("../desktop/move.cjs");

// B-158 M1 step 3d (SCN-094): the app's move of an address between two servers it holds, driven against two fake
// servers that answer the transfer routes the way workers/routes/transfer.ts does (rows paged by cursor, files named
// by rows, ids, check, hold, route, a test message).
const ADDRESS = "support@shop.invalid";
const base = `/api/transfer/${encodeURIComponent(ADDRESS)}`;

function fakePair(opts: { emails?: number; testArrives?: boolean; dropFile?: boolean; otherAccount?: boolean } = {}) {
  const calls: string[] = [];
  const src = { emails: Array.from({ length: opts.emails ?? 5 }, (_, i) => ({ id: `m${i}`, body_key: `bodies/m${i}` })), attachments: [] as any[], folders: [{ id: "inbox" }],
    sends: 0, held: false };
  const dst = { emails: new Map<string, any>(), attachments: new Map<string, any>(), folders: new Map<string, any>(), files: new Set<string>(), routed: false, tested: false, opened: false };
  const page = (rows: any[], after: number, limit: number) => {
    const slice = rows.slice(after, after + limit);
    return { rows: slice, next: after + limit < rows.length ? after + limit : null };
  };
  const ok = (body: unknown) => ({ status: 200, body });
  const from = {
    async get(path: string) {
      calls.push(`from GET ${path.replace(base, "")}`);
      const u = new URL(path, "http://x");
      if (u.pathname === base) return ok({ settings: { fromName: "Shop" }, counts: { emails: src.emails.length, attachments: 0 }, blockers: { sends: src.sends, incoming: 0 } });
      if (u.pathname === `${base}/rows`) {
        const table = u.searchParams.get("table") as "emails" | "folders" | "attachments";
        const p = page(src[table], Number(u.searchParams.get("after")), Number(u.searchParams.get("limit")));
        return ok({ ...p, files: table === "emails" ? p.rows.map((r: any) => r.body_key) : [] });
      }
      if (u.pathname === `${base}/file`) return opts.dropFile && u.searchParams.get("key") === "bodies/m1" ? { status: 404, body: { error: "missing", missing: true } } : ok({ data: "eA==", contentType: "text/html" });
      if (u.pathname === `${base}/setup`) return ok({ rules: [], agent: { id: "support", name: "Support" }, collections: [] });
      if (u.pathname === `${base}/labels`) return u.searchParams.get("table") ? ok({ rows: [], next: null }) : ok({ categories: [] });
      if (u.pathname === `${base}/ids`) return ok({ emails: src.emails.map((e) => e.id), attachments: [] });
      return { status: 404, body: { error: "no route" } };
    },
    async send(method: string, path: string, body: any) {
      calls.push(`from ${method} ${path.replace(base, "")}`);
      if (path === `${base}/hold`) { src.held = !body.release; return ok({ held: src.held }); }
      return { status: 404, body: { error: "no route" } };
    },
  };
  const to = {
    async get(path: string) {
      calls.push(`to GET ${path.replace(base, "")}`);
      if (path.endsWith("/test")) return ok({ state: dst.tested && opts.testArrives !== false ? "arrived" : "waiting" });
      if (path === `${base}/route`) return ok({ routed: dst.routed, here: opts.otherAccount ? null : dst.routed });
      return { status: 404, body: { error: "no route" } };
    },
    async send(method: string, path: string, body: any) {
      calls.push(`to ${method} ${path.replace(base, "")}`);
      if (path === `${base}/open`) { dst.opened = true; return ok({ created: true }); }
      if (path === `${base}/rows`) { for (const r of body.rows) (dst as any)[body.table].set(r.id, r); return ok({ written: body.rows.length }); }
      if (path === `${base}/file`) { dst.files.add(body.key); return ok({ written: true }); }
      if (path === `${base}/agent`) return ok({ id: "support", created: true });
      if (path === `${base}/check`) {
        const missing = body.emails.filter((id: string) => !dst.emails.has(id));
        return ok({ complete: !missing.length, counts: { emails: missing.length, attachments: 0 } });
      }
      if (path === `${base}/route`) { dst.routed = true; return ok({ routed: true }); }
      if (path === `${base}/unroute`) { dst.routed = false; return ok({ routed: false }); }
      if (path.endsWith("/test")) { dst.tested = true; return ok({}); }
      if (path.endsWith("/agent")) return ok({ ok: true });
      return { status: 404, body: { error: "no route" } };
    },
  };
  let stored: any = null;
  const journal = { read: async () => (stored ? structuredClone(stored) : null), write: async (s: any) => { stored = structuredClone(s); }, clear: async () => { stored = null; } };
  let clock = 0;
  const mover = (over: Record<string, unknown> = {}) => createMover({ address: ADDRESS, from, to, journal, now: () => clock, sleep: async (ms: number) => { clock += ms; },
    pollMs: 1000, settleMs: 10_000, testMs: 5_000, ...over });
  return { calls, src, dst, journal, mover, from, to, stored: () => stored };
}

test("SCN-094: a whole move copies, checks, holds, routes and tests, in that order", async () => {
  const f = fakePair({ emails: 250 });
  const state = await f.mover().run();
  assert.equal(state.stage, "done", JSON.stringify(state.error));
  assert.equal(f.dst.emails.size, 250);
  assert.equal(f.dst.files.size, 250, "every file a row names");
  assert.ok(f.src.held && f.dst.routed);
  const at = (needle: string) => f.calls.findIndex((c) => c.includes(needle));
  assert.ok(at("POST /check") < at("POST /hold"), "the counts are checked before the sending server changes");
  assert.ok(at("POST /hold") < at("POST /route"), "held before the mail moves");
  assert.ok(at("POST /route") < at("/test"), "tested after it moves");
  assert.equal(describe(state).agentId, "support");
  assert.equal((await f.mover().run()).stage, "done", "a finished move is not run again");
});

test("SCN-094: a move cut midway continues from where it stopped and copies nothing twice", async () => {
  const f = fakePair({ emails: 250 });
  const realGet = f.from.get;
  let pages = 0;
  f.from.get = async (path: string) => {
    if (path.includes("/rows?table=emails") && ++pages === 2) throw new Error("connection lost");
    return realGet(path);
  };
  const cut = await f.mover().run();
  assert.equal(cut.error.code, "unreachable");
  assert.equal(cut.stage, "copy");
  f.from.get = realGet;
  const writesBefore = f.calls.filter((c) => c === "to POST /rows").length;
  const done = await f.mover().run();
  assert.equal(done.stage, "done", JSON.stringify(done.error));
  const emailPages = f.calls.filter((c) => c.startsWith("from GET /rows?table=emails")).length;
  assert.ok(emailPages <= 2 + 3 + 1, `the resumed copy starts at its cursor (${emailPages} email pages read)`);
  assert.ok(writesBefore >= 2 && f.dst.emails.size === 250);
});

test("SCN-094: the test message that does not arrive offers the way back, which puts the mail and the hold back", async () => {
  const f = fakePair({ testArrives: false });
  const state = await f.mover().run();
  assert.deepEqual([state.stage, state.error.code], ["test", "not_arrived"]);
  assert.ok(f.dst.routed && f.src.held);
  const back = await f.mover().putBack();
  assert.equal(back.stage, "back");
  assert.ok(!f.dst.routed && !f.src.held);
  const at = (needle: string) => f.calls.findIndex((c) => c.includes(needle));
  assert.ok(at("POST /unroute") < f.calls.lastIndexOf("from POST /hold"), "the rule goes back before the hold is lifted");
});

test("SCN-094: sends still in flight wait, then hand the choice to the person; Wait Longer goes on", async () => {
  const f = fakePair();
  f.src.sends = 1;
  const state = await f.mover().run();
  assert.deepEqual([state.stage, state.error.code], ["settle", "still_busy"]);
  assert.ok(!f.dst.routed, "nothing is routed while the sending server is busy");
  f.src.sends = 0;
  assert.equal((await f.mover().waitLonger()).stage, "done");
});

test("SCN-094: counts that do not match stop the move before the sending server changes", async () => {
  const f = fakePair({ emails: 3 });
  const realSend = f.to.send;
  f.to.send = async (method: string, path: string, body: any) => (path.endsWith("/rows") && body.table === "emails" ? { status: 200, body: { written: 0 } } : realSend(method, path, body));
  const state = await f.mover().run();
  assert.deepEqual([state.stage, state.error.code], ["precheck", "counts"]);
  assert.ok(!f.calls.some((c) => c.includes("POST /hold")), "the sending server is not held");
});

test("SCN-094: a file the sending server no longer stores is counted, and the move goes on", async () => {
  const f = fakePair({ dropFile: true });
  const state = await f.mover().run();
  assert.equal(state.stage, "done");
  assert.equal(describe(state).missingFiles, 1);
});

test("SCN-094: a server that cannot take the address's mail (another Cloudflare account) stops the move before the hold, and Cancel is open", async () => {
  const f = fakePair({ otherAccount: true });
  const state = await f.mover().run();
  assert.deepEqual([state.stage, state.error.code], ["precheck", "cannot_route"]);
  assert.ok(!f.calls.some((c) => c.includes("POST /hold")), "the sending server is not held");
  assert.deepEqual([describe(state).held, describe(state).routed], [false, false]);
});
