// B-208: a mailbox's support work per month, counts only (workers/lib/support-months.ts, MailboxDO.supportThreads).
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { byAgent, foldMonths } from "../workers/lib/support-months";

test("B-208: threads fold into their first message's month, with the first answer's sender and the median wait", () => {
  const months = foldMonths([
    { firstIn: "2026-10-01T10:00:00.000Z", firstReply: "2026-10-01T10:30:00.000Z", replyKey: "agent-run-1" },
    { firstIn: "2026-10-02T10:00:00.000Z", firstReply: "2026-10-02T12:00:00.000Z", replyKey: null },
    { firstIn: "2026-10-03T10:00:00.000Z", firstReply: "2026-10-03T10:10:00.000Z", replyKey: "manual-1" },
    { firstIn: "2026-10-31T23:00:00.000Z", firstReply: null, replyKey: null },
    { firstIn: "2026-11-01T00:00:00.000Z", firstReply: "2026-10-31T00:00:00.000Z", replyKey: "agent-x" },
    { firstIn: "not a date", firstReply: null, replyKey: null },
  ]);
  assert.deepEqual(months, [
    { month: "2026-10", threads: 4, answeredByAgent: 1, answeredByPerson: 2, unanswered: 1, medianFirstReplyMinutes: 30 },
    { month: "2026-11", threads: 1, answeredByAgent: 0, answeredByPerson: 0, unanswered: 1, medianFirstReplyMinutes: null },
  ], "a reply dated before the thread is no answer to it");
  assert.equal(byAgent("agent-1:closing"), true);
  assert.equal(byAgent("routing-test-1"), false);
  assert.deepEqual(foldMonths([]), []);
});

test("B-208: a real mailbox reads each thread's first message and first answer, skipping an agent's holding reply, spam and drafts", async () => {
  const bundle = await build({ stdin: { contents: `
    import { MailboxDO } from './workers/durableObject/index';
    export class TestBox extends MailboxDO { async sql(q, ...a) { return this.ctx.storage.sql.exec(q, ...a).toArray(); } }
    export default { async fetch(request, env) {
      const box = env.MAILBOX.getByName('support@acme.example');
      const { op } = await request.json();
      if (op === 'seed') {
        const mail = (id, folder, date, thread) => box.createEmail(folder, { id, sender: 'person@mail.example', recipient: 'support@acme.example', subject: 'Fixture', body: 'x', date, thread_id: thread }, []);
        await mail('in-1', 'inbox', '2026-10-01T10:00:00.000Z', 't1');
        await mail('wait-1', 'sent', '2026-10-01T10:01:00.000Z', 't1');
        await mail('out-1', 'sent', '2026-10-01T11:00:00.000Z', 't1');
        await mail('in-2', 'archive', '2026-10-05T09:00:00.000Z', 't2');
        await mail('out-2', 'sent', '2026-10-05T09:20:00.000Z', 't2');
        await mail('in-3', 'inbox', '2026-11-02T09:00:00.000Z', null);
        await mail('spam-1', 'spam', '2026-11-02T09:00:00.000Z', 't9');
        const now = Date.now();
        const row = (id, key) => box.sql("INSERT INTO outbox (id, mailbox_id, idempotency_key, payload_hash, status, created_at, updated_at) VALUES (?, 'support@acme.example', ?, 'h', 'accepted', ?, ?)", id, key, now, now);
        await row('wait-1', 'agent-run-1:waiting'); await row('out-1', 'agent-run-1'); await row('out-2', 'manual-2');
        return Response.json(true);
      }
      return Response.json(await box.supportThreads());
    }};`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022" });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestBox", useSQLite: true } }, r2Buckets: ["BUCKET"] });
  const call = async (op: string) => (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ op }) })).json() as Promise<any>;
  try {
    await call("seed");
    const rows = (await call("threads")).sort((a: any, b: any) => (a.firstIn < b.firstIn ? -1 : 1));
    assert.deepEqual(rows, [
      { firstIn: "2026-10-01T10:00:00.000Z", firstReply: "2026-10-01T11:00:00.000Z", replyKey: "agent-run-1" },
      { firstIn: "2026-10-05T09:00:00.000Z", firstReply: "2026-10-05T09:20:00.000Z", replyKey: "manual-2" },
      { firstIn: "2026-11-02T09:00:00.000Z", firstReply: null, replyKey: null },
    ]);
    assert.deepEqual(foldMonths(rows).map((m) => [m.month, m.threads, m.answeredByAgent, m.answeredByPerson, m.medianFirstReplyMinutes]),
      [["2026-10", 2, 1, 1, 40], ["2026-11", 1, 0, 0, null]]);
  } finally { await mf.dispose(); }
});
