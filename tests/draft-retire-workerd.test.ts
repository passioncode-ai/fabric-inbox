import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// S07 (B-272) in workerd: the production MailboxDO sends replies through its outbox, and the accepted reply's `project`
// step retires the conversation's waiting agent drafts. The reply agents' registry is a stub that keeps the runs and
// answers `settleDraftOutcome` as the real one does (first outcome wins, only for the run's own draft).
const bundle = await build({
  stdin: {
    contents: `
      import { MailboxDO } from './workers/durableObject/index';
      import { runIdFor } from './workers/agents/run';
      const forbidden = () => { throw new Error('External AI is forbidden in this test'); };
      let failNext = false;
      const email = { send: async () => { if (failNext) { failNext = false; throw new Error('network'); } return { messageId: 'sent-' + crypto.randomUUID() + '@owner.example' }; } };
      const runs = new Map();
      const calls = [];
      const registry = { getByName: () => ({
        settleDraftOutcome: async (id, outcome, draftId) => {
          calls.push({ id, kind: outcome.kind, draftId, edited: !!outcome.edited });
          const run = runs.get(id);
          if (!run || (run.draftId !== draftId && run.personDraftId !== draftId && !(run.priorDrafts || []).some((d) => d.id === draftId))) return null;
          if (run.outcome) return { run, settled: false };
          run.outcome = outcome;
          return { run, settled: true };
        },
      }) };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, { ...env, AI: { run: forbidden }, EMAIL: email, AGENT_REGISTRY: registry }); }
        async seed(rows) {
          for (const r of rows)
            this.ctx.storage.sql.exec("INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, thread_id, message_id, in_reply_to, draft_revision) VALUES (?, ?, 'Hello', ?, ?, ?, ?, 't1', ?, ?, ?)",
              r.id, r.folder, r.folder === 'draft' ? 'help@owner.example' : 'maya@acme.example', r.folder === 'draft' ? 'maya@acme.example' : 'help@owner.example',
              r.date, '<p>' + r.id + '</p>', r.messageId ?? null, r.inReplyTo ?? null, r.revision ?? null);
        }
        outboxRows() { return this.ctx.storage.sql.exec("SELECT * FROM outbox").toArray(); }
        ids() { return this.ctx.storage.sql.exec("SELECT id FROM emails WHERE folder_id = 'draft' ORDER BY id").toArray().map((r) => r.id); }
      }
      export default {
        async fetch(request, env) {
          const c = await request.json();
          const box = env.MAILBOX.get(env.MAILBOX.idFromName('help@owner.example'));
          if (c.op === 'setup') {
            runs.clear(); calls.length = 0;
            for (const r of c.runs) runs.set(await runIdFor('help@owner.example', r.emailId), { ...r });
            await box.seed(c.rows);
            return Response.json(true);
          }
          if (c.op === 'reply') { failNext = !!c.fail; return Response.json(await box.sendMail({ mailboxId: 'help@owner.example', idempotencyKey: c.key, kind: c.kind || 'reply',
            originalEmailId: c.original, sentBy: c.sentBy, request: { to: ['maya@acme.example'], from: 'help@owner.example', subject: 'Re: Hello', text: 'Thanks', html: '<p>Thanks</p>' } })); }
          if (c.op === 'sendDraft') return Response.json(await box.sendDraft({ mailboxId: 'help@owner.example', draftId: c.draftId, idempotencyKey: c.key, from: 'help@owner.example' }));
          if (c.op === 'state') {
            const out = {};
            for (const [id, r] of runs) out[r.emailId] = r.outcome ?? null;
            return Response.json({ drafts: await box.ids(), outcomes: out, calls, outbox: await box.outboxRows() });
          }
          return new Response('unknown op', { status: 400 });
        }
      };
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], target: "es2022",
});

async function fixture() {
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-09-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { MAILBOX: { className: "TestMailbox", useSQLite: true } }, r2Buckets: ["BUCKET"],
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  const call = async (op: string, fields: Record<string, unknown> = {}): Promise<any> => {
    const r = await mf.dispatchFetch("http://localhost/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, ...fields }) });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  return { mf, call };
}

const at = (m: number) => new Date(Date.UTC(2026, 10, 14, 8, m)).toISOString();
// m1, m2, m3 came in; d1 untouched answers m1, d2 edited answers m2, d3 untouched answers m3 (later than m2).
const rows = [
  { id: "m1", folder: "inbox", date: at(0), messageId: "a@acme.example" },
  { id: "d1", folder: "draft", date: at(1), inReplyTo: "m1" },
  { id: "m2", folder: "inbox", date: at(2), messageId: "b@acme.example" },
  { id: "d2", folder: "draft", date: at(3), inReplyTo: "m2", revision: 2 },
  { id: "m3", folder: "inbox", date: at(4), messageId: "c@acme.example" },
  { id: "d3", folder: "draft", date: at(5), inReplyTo: "m3", revision: 1 },
];
const runs = [
  { emailId: "m1", draftId: "d1", draftText: "d1", draftTextComplete: true },
  { emailId: "m2", draftId: "d2", draftText: "d2", draftTextComplete: true },
  { emailId: "m3", draftId: "d3", draftText: "d3", draftTextComplete: true },
];

test("S07: an accepted reply deletes an untouched draft (its text on the run), keeps an edited one and one answering a later message", async () => {
  const { mf, call } = await fixture();
  try {
    await call("setup", { rows, runs });
    const sent = await call("reply", { key: "k1", original: "m2" });
    assert.equal(sent.status, "accepted");
    const state = await call("state");
    assert.deepEqual(state.drafts, ["d2", "d3"], "d1 retired; d2 is the person's; d3 answers a later message");
    assert.equal(state.outcomes.m1.kind, "answered_by_person");
    assert.equal(state.outcomes.m2.kind, "answered_by_person");
    assert.equal(state.outcomes.m2.edited, true, "the edited draft is kept and says so");
    assert.equal(state.outcomes.m3, null, "a draft answering a later message stays");
    // Idempotent by run: a second reply changes no outcome.
    await call("reply", { key: "k2", original: "m2", sentBy: "agent" });
    const again = await call("state");
    assert.equal(again.outcomes.m1.kind, "answered_by_person", "the first accepted reply decided");
  } finally { await mf.dispose(); }
});

test("S07: a forward and an uncertain send retire nothing; an agent's reply is answered_by_agent", async () => {
  const { mf, call } = await fixture();
  try {
    await call("setup", { rows, runs });
    await call("reply", { key: "f1", original: "m2", kind: "forward" });
    assert.deepEqual((await call("state")).drafts, ["d1", "d2", "d3"], "a forward is not a reply");
    const unknown = await call("reply", { key: "u1", original: "m2", fail: true });
    assert.equal(unknown.status, "unknown");
    assert.deepEqual((await call("state")).drafts, ["d1", "d2", "d3"], "an uncertain send retires nothing until it is accepted");
    await call("reply", { key: "a1", original: "m3", sentBy: "agent" });
    const state = await call("state");
    assert.deepEqual(state.drafts, ["d2"]);
    assert.equal(state.outcomes.m3.kind, "answered_by_agent");
  } finally { await mf.dispose(); }
});

test("S06/S07: sending the agent's draft as written is approved_by_person and leaves by the send; a run without the whole text keeps its draft", async () => {
  const { mf, call } = await fixture();
  try {
    await call("setup", { rows, runs: [runs[0], runs[1], { emailId: "m3", draftId: "d3", draftText: "d3", draftTextComplete: false }] });
    const sent = await call("sendDraft", { draftId: "d1", key: "card-1" });
    assert.equal(sent.status, "accepted");
    let state = await call("state");
    assert.equal(state.outcomes.m1.kind, "approved_by_person");
    assert.deepEqual(state.drafts, ["d2", "d3"], "the card's draft left by the send");
    assert.ok(!state.calls.some((c: { draftId: string; kind: string }) => c.draftId === "d1" && c.kind !== "approved_by_person"), "never retired as well");
    await call("reply", { key: "k3", original: "m3" });
    state = await call("state");
    assert.deepEqual(state.drafts, ["d2", "d3"], "a run that does not keep the whole text keeps its draft (KIMI-46)");
    assert.equal(state.outcomes.m3.kind, "answered_by_person", "the outcome is still written");
  } finally { await mf.dispose(); }
});

test("K-1: an accepted card send carries its thread, so it settles its own run and retires an earlier untouched sibling", async () => {
  const { mf, call } = await fixture();
  try {
    await call("setup", { rows, runs });
    const sent = await call("sendDraft", { draftId: "d3", key: "card-k1" });
    assert.equal(sent.status, "accepted");
    const state = await call("state");
    assert.equal(state.outcomes.m3.kind, "approved_by_person", "the card's own run is settled");
    assert.deepEqual(state.drafts, ["d2"], "d3 left by the send, d1 (untouched, earlier) retired, d2 (edited) kept");
    assert.equal(state.outcomes.m1.kind, "answered_by_person");
  } finally { await mf.dispose(); }
});

test("K-6: sending a person's edited draft from the card is answered_by_person without the edited mark (it was sent, not kept)", async () => {
  const { mf, call } = await fixture();
  try {
    await call("setup", { rows, runs });
    assert.equal((await call("sendDraft", { draftId: "d2", key: "card-k6" })).status, "accepted");
    const state = await call("state");
    assert.equal(state.outcomes.m2.kind, "answered_by_person");
    assert.equal(state.outcomes.m2.edited, undefined, "edited marks only a draft kept in Drafts");
  } finally { await mf.dispose(); }
});

test("K-5: an earlier attempt's untouched draft is retired with the current one; one whose text the run did not keep stays", async () => {
  const { mf, call } = await fixture();
  try {
    const multi = [
      { id: "m1", folder: "inbox", date: at(0), messageId: "a@acme.example" },
      { id: "d1", folder: "draft", date: at(1), inReplyTo: "m1" },
      { id: "d1b", folder: "draft", date: at(2), inReplyTo: "m1" },
      { id: "d1c", folder: "draft", date: at(3), inReplyTo: "m1" },
      { id: "m2", folder: "inbox", date: at(4), messageId: "b@acme.example" },
    ];
    await call("setup", { rows: multi, runs: [{ emailId: "m1", draftId: "d1c", draftText: "third", draftTextComplete: true,
      priorDrafts: [{ id: "d1", text: "first", complete: true }, { id: "d1b", text: "", complete: false }] }] });
    await call("reply", { key: "k-multi", original: "m2" });
    const state = await call("state");
    assert.deepEqual(state.drafts, ["d1b"], "d1 and d1c retired; d1b's text was not kept, so it stays");
    assert.equal(state.outcomes.m1.kind, "answered_by_person");
  } finally { await mf.dispose(); }
});
