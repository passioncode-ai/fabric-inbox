import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import Automation, { runCheckable } from "../app/routes/automation";

/**
 * AUD-B11-12 / SCN-020: "Check status" on an automation run whose outcome is unknown. The production
 * AutomationDO, MailboxDO and automation router run in workerd; the Gmail/IMAP/Outlook accounts
 * object is a recorded fake that answers receipts and messages the way the real one does over RPC
 * (the code is the error's message). The subclasses only seed rows and count real mailbox effects.
 */
const bundle = await build({
  stdin: {
    contents: `
      import { DurableObject } from 'cloudflare:workers';
      import { AutomationDO, automationRouter } from './workers/automation/index';
      import { MailboxDO } from './workers/durableObject/index';
      const forbidden = () => { throw new Error('External mail and AI are forbidden in this test'); };
      export class TestMailbox extends MailboxDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}, EMAIL:{send:forbidden}}); }
        async moveEmail(id, folder) { await this.bump(); return super.moveEmail(id, folder); }
        async updateEmail(id, changes) { await this.bump(); return super.updateEmail(id, changes); }
        async createEmail(...args) { if (!this.seeding) await this.bump(); return super.createEmail(...args); }
        async sendMail(command) { await this.bump(); return super.sendMail(command); }
        async bump() { await this.ctx.storage.put('test:effects', (await this.ctx.storage.get('test:effects') || 0) + 1); }
        async seedEmail(folder, email) { this.seeding = true; try { return await super.createEmail(folder, email, []); } finally { this.seeding = false; } }
        async seedOutbox(mailbox, key, status) {
          const now = Date.now();
          this.ctx.storage.sql.exec("INSERT INTO outbox(id, mailbox_id, idempotency_key, payload_hash, status, created_at, updated_at) VALUES(?, ?, ?, 'h', ?, ?, ?)", 'ob-' + key, mailbox.toLowerCase(), key, status, now, now);
        }
        async outboxCount() { return [...this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM outbox')][0].n; }
        async effectCount() { return await this.ctx.storage.get('test:effects') || 0; }
      }
      export class TestAutomation extends AutomationDO {
        constructor(ctx, env) { super(ctx, {...env, AI:{run:forbidden}}); }
        async alarm() {}
        async seedRun(run) { await this.ctx.storage.put('run:' + run.id, run); }
        async readRun(id) { return this.ctx.storage.get('run:' + id); }
      }
      // The accounts object as the automation sees it: receipts by key, messages by id, and the
      // codes it throws (DO RPC keeps an error's message, not its class).
      export class FakeAccounts extends DurableObject {
        async put(key, value) { await this.ctx.storage.put(key, value); }
        async calls() { return await this.ctx.storage.get('calls') || []; }
        async note(call) { await this.ctx.storage.put('calls', [...await this.calls(), call]); }
        async getSendReceipt(account, key) { await this.note('send:' + key); const r = await this.ctx.storage.get('send:' + account + ':' + key); if (!r) throw new Error('receipt_not_found'); return r; }
        async getDraftReceipt(account, key) { await this.note('draft:' + key); const r = await this.ctx.storage.get('draft:' + account + ':' + key); if (!r) throw new Error('receipt_not_found'); return r; }
        async getMessage(account, id) { await this.note('message:' + id); const m = await this.ctx.storage.get('message:' + account + ':' + id); if (m === 'down') throw new Error('gmail_unavailable'); if (!m) throw new Error('message_not_found'); return m; }
        async send() { await this.note('SEND'); throw new Error('a check must never send'); }
        async createDraft() { await this.note('CREATE_DRAFT'); throw new Error('a check must never save a draft'); }
        async archive() { await this.note('ARCHIVE'); throw new Error('a check must never archive'); }
        async setRead() { await this.note('SET_READ'); throw new Error('a check must never mark read'); }
      }
      export default {
        async fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname.startsWith('/api/automation/')) return automationRouter.fetch(request, env, ctx);
          const command = await request.json();
          const account = command.account || 'me@example.invalid';
          const automation = env.AUTOMATIONS.getByName(account);
          const mailbox = env.MAILBOX.getByName(account);
          const accounts = env.GMAIL_ACCOUNTS.getByName('workspace');
          let result = {};
          switch (command.op) {
            case 'run': await automation.seedRun(command.run); break;
            case 'email': await mailbox.seedEmail(command.folder || 'inbox', command.email); break;
            case 'outbox': await mailbox.seedOutbox(account, command.key, command.status); break;
            case 'accounts': await accounts.put(command.key, command.value); break;
            case 'check': try { result = await automation.checkRun(command.id); } catch (e) { result = { thrown: e.message }; } break;
            case 'state': result = { run: await automation.readRun(command.id), effects: await mailbox.effectCount(), outbox: await mailbox.outboxCount(), calls: await accounts.calls() }; break;
            default: throw new Error('Unknown test command');
          }
          return Response.json(result);
        }
      };
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  external: ["cloudflare:workers"],
  target: "es2022",
});

async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      MAILBOX: { className: "TestMailbox", useSQLite: true },
      AUTOMATIONS: { className: "TestAutomation", useSQLite: true },
      GMAIL_ACCOUNTS: { className: "FakeAccounts", useSQLite: true },
    },
    r2Buckets: ["BUCKET"],
    outboundService: () => new Response("External network disabled for tests", { status: 503 }),
  });
  async function command(op: string, fields: Record<string, unknown> = {}): Promise<any> {
    const response = await mf.dispatchFetch("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...fields }),
    });
    assert.equal(response.status, 200, `Test command ${op} failed: ${response.status} ${await response.clone().text()}`);
    return response.json();
  }
  return { mf, command };
}

const CF = "me@example.invalid";
const REMOTE = "gmail:g1";
function run(id: string, action: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id,
    key: "k-" + id,
    account: CF,
    emailId: "message-1",
    subject: "Invoice",
    rule: { id: "rule-1", version: 1, name: "Invoices", enabled: true, mode: "automatic", conditions: {}, action, dailyLimit: 5 },
    status: "unknown",
    createdAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T10:00:00.000Z",
    attempts: 1,
    detail: "Action outcome is uncertain. Check the provider before repeating it.",
    ...over,
  };
}
const message = (over: Record<string, unknown> = {}) => ({
  id: "message-1", sender: "vendor@example.invalid", recipient: CF, subject: "Invoice", body: "Details", date: "2026-10-07T09:00:00.000Z", thread_id: "message-1", ...over,
});

test("AUD-B11-12: a Cloudflare archive/mark-read run is settled by the message's own state, with no mailbox effect", async () => {
  const f = await fixture();
  try {
    await f.command("email", { email: message() });
    await f.command("email", { folder: "archive", email: message({ id: "message-2" }) });
    await f.command("run", { run: run("a-not", { type: "archive" }) });
    await f.command("run", { run: run("a-done", { type: "archive" }, { emailId: "message-2" }) });
    await f.command("run", { run: run("r-not", { type: "mark_read" }) });
    await f.command("run", { run: run("gone", { type: "archive" }, { emailId: "missing" }) });

    const done = await f.command("check", { id: "a-done" });
    assert.equal(done.outcome, "done");
    assert.equal(done.run.status, "succeeded");
    assert.equal(done.run.detail, "Checked: the message is archived.");
    assert.ok(done.run.checkedAt);

    const notDone = await f.command("check", { id: "a-not" });
    assert.equal(notDone.outcome, "not_done");
    assert.equal(notDone.run.status, "failed", "proven not done is the only state that allows doing it again by hand");
    assert.equal(notDone.run.detail, "Checked: the message is not archived.");

    const unread = await f.command("check", { id: "r-not" });
    assert.equal(unread.outcome, "not_done");
    assert.equal(unread.run.detail, "Checked: the message is not marked read.");

    const missing = await f.command("check", { id: "gone" });
    assert.equal(missing.outcome, "unresolved");
    assert.equal(missing.run.status, "unknown", "nothing proven: the run stays unknown");
    assert.equal(missing.run.detail, "Action outcome is uncertain. Check the provider before repeating it.", "the original uncertainty stays visible");
    assert.ok(missing.run.checkedAt);

    const state = await f.command("state", { id: "a-not" });
    assert.equal(state.effects, 0, "checking never moves or marks a message");
    assert.equal(state.run.status, "failed", "the settled status is stored, not only returned");
  } finally {
    await f.mf.dispose();
  }
});

test("AUD-B11-12: a Cloudflare forward is settled by its outbox entry under the run's key, and the check sends nothing", async () => {
  const f = await fixture();
  try {
    await f.command("email", { email: message() });
    const cases: [string, string | null, string, string, string][] = [
      ["f-none", null, "not_done", "failed", "Checked: nothing reached the outbox, so nothing was sent."],
      ["f-accepted", "accepted", "done", "succeeded", "Checked: the email provider accepted the forward."],
      ["f-failed", "failed", "not_done", "failed", "Checked: the email provider refused the forward, so nothing was sent."],
      ["f-unknown", "unknown", "unresolved", "unknown", "Checked: the outbox does not know whether the email provider took the forward. Look in Sent before repeating it."],
      ["f-pending", "pending", "unresolved", "unknown", "Checked: the forward is still in the outbox. Check again in a minute."],
      ["f-sending", "sending", "unresolved", "unknown", "Checked: the forward is still in the outbox. Check again in a minute."],
    ];
    for (const [id, status] of cases) {
      await f.command("run", { run: run(id, { type: "forward", to: "team@example.invalid" }) });
      if (status) await f.command("outbox", { key: "rule-" + id, status });
    }
    for (const [id, , outcome, runStatus, detail] of cases) {
      const result = await f.command("check", { id });
      assert.equal(result.outcome, outcome, id);
      assert.equal(result.detail, detail, id);
      assert.equal(result.run.status, runStatus, id);
    }
    const state = await f.command("state", { id: "f-none" });
    assert.equal(state.outbox, 5, "the check wrote no outbox entry");
    assert.equal(state.effects, 0, "the check called no send");
  } finally {
    await f.mf.dispose();
  }
});

test("AUD-B11-12: a Cloudflare draft run is settled by the draft its key names", async () => {
  const f = await fixture();
  try {
    await f.command("run", { run: run("d-saved", { type: "draft" }) });
    await f.command("run", { run: run("d-missing", { type: "draft" }) });
    await f.command("email", { folder: "draft", email: message({ id: "rule-d-saved", subject: "Re: Invoice" }) });
    const saved = await f.command("check", { id: "d-saved" });
    assert.deepEqual([saved.outcome, saved.run.status, saved.detail], ["done", "succeeded", "Checked: the draft is saved."]);
    const missing = await f.command("check", { id: "d-missing" });
    assert.deepEqual([missing.outcome, missing.run.status, missing.detail], ["not_done", "failed", "Checked: no draft was saved."]);
    assert.equal((await f.command("state", { id: "d-missing" })).effects, 0, "the check saved no draft");
  } finally {
    await f.mf.dispose();
  }
});

test("AUD-B11-12: a Gmail/IMAP/Outlook run is settled by the provider's receipt under the run's key; the cached copy proves only 'done'", async () => {
  const f = await fixture();
  try {
    const remote = (id: string, action: Record<string, unknown>) => run(id, action, { account: REMOTE });
    await f.command("run", { account: REMOTE, run: remote("s-accepted", { type: "forward", to: "t@example.invalid" }) });
    await f.command("run", { account: REMOTE, run: remote("s-unknown", { type: "forward", to: "t@example.invalid" }) });
    await f.command("run", { account: REMOTE, run: remote("s-none", { type: "forward", to: "t@example.invalid" }) });
    await f.command("run", { account: REMOTE, run: remote("dr-accepted", { type: "draft" }) });
    await f.command("run", { account: REMOTE, run: remote("dr-none", { type: "draft" }) });
    await f.command("run", { account: REMOTE, run: remote("ar-done", { type: "archive" }) });
    await f.command("run", { account: REMOTE, run: { ...remote("rd-lag", { type: "mark_read" }), emailId: "message-2" } });
    await f.command("run", { account: REMOTE, run: { ...remote("ar-gone", { type: "archive" }), emailId: "message-9" } });
    await f.command("run", { account: REMOTE, run: { ...remote("ar-down", { type: "archive" }), emailId: "message-3" } });
    await f.command("accounts", { account: REMOTE, key: "send:g1:rule-s-accepted", value: { status: "accepted", idempotencyKey: "rule-s-accepted" } });
    await f.command("accounts", { account: REMOTE, key: "send:g1:rule-s-unknown", value: { status: "unknown", idempotencyKey: "rule-s-unknown", error: "send_outcome_unknown" } });
    await f.command("accounts", { account: REMOTE, key: "draft:g1:rule-dr-accepted", value: { status: "accepted", idempotencyKey: "rule-dr-accepted" } });
    await f.command("accounts", { account: REMOTE, key: "message:g1:message-1", value: { archived: true, read: false } });
    await f.command("accounts", { account: REMOTE, key: "message:g1:message-2", value: { archived: false, read: false } });
    await f.command("accounts", { account: REMOTE, key: "message:g1:message-3", value: "down" });

    const expect: [string, string, string, string][] = [
      ["s-accepted", "done", "succeeded", "Checked: the provider accepted the forward."],
      ["s-unknown", "unresolved", "unknown", "Checked: the provider was handed the forward, but its answer was lost. Look in the account's Sent folder before repeating it."],
      ["s-none", "not_done", "failed", "Checked: nothing was handed to the provider, so nothing was sent."],
      ["dr-accepted", "done", "succeeded", "Checked: the provider saved the draft."],
      ["dr-none", "not_done", "failed", "Checked: nothing was handed to the provider, so no draft was saved."],
      ["ar-done", "done", "succeeded", "Checked: the message is archived."],
      ["rd-lag", "unresolved", "unknown", "Checked: the copy on this server does not show the change yet. Look in the account itself before repeating the action."],
      ["ar-gone", "unresolved", "unknown", "Checked: the message is no longer on this server. Look in the account itself before repeating the action."],
    ];
    for (const [id, outcome, status, detail] of expect) {
      const result = await f.command("check", { account: REMOTE, id });
      assert.equal(result.outcome, outcome, id);
      assert.equal(result.run.status, status, id);
      assert.equal(result.detail, detail, id);
    }
    const down = await f.command("check", { account: REMOTE, id: "ar-down" });
    assert.equal(down.thrown, "gmail_unavailable", "a read that fails is an error, never a verdict");
    const state = await f.command("state", { account: REMOTE, id: "ar-down" });
    assert.equal(state.run.status, "unknown");
    assert.equal(state.run.checkedAt, undefined, "a failed check records nothing");
    assert.deepEqual(state.calls.filter((c: string) => /^[A-Z_]+$/.test(c)), [], "no send, draft, archive or mark-read reached the provider");
    assert.ok(state.calls.includes("send:rule-s-accepted") && state.calls.includes("draft:rule-dr-accepted"), "receipts are read by the run's own key");
  } finally {
    await f.mf.dispose();
  }
});

test("AUD-B11-12: a tool call cannot be checked and stays unknown; only an unknown run can be checked", async () => {
  const f = await fixture();
  try {
    await f.command("run", { run: run("tool", { type: "mcp", endpoint: "https://tools.example.invalid/mcp", tool: "file", arguments: {}, location: "cloud" }) });
    await f.command("run", { run: run("finished", { type: "archive" }, { status: "succeeded", detail: "Archived" }) });
    const tool = await f.command("check", { id: "tool" });
    assert.equal(tool.outcome, "not_checkable");
    assert.equal(tool.run.status, "unknown");
    assert.equal(tool.detail, "A tool call leaves no receipt on this server. Check the tool's own service before repeating it.");
    assert.equal((await f.command("check", { id: "finished" })).thrown, "run_not_uncertain");
    assert.equal((await f.command("check", { id: "nope" })).thrown, "run_not_found");
    // A settled run cannot be checked again: the second check is refused, the first verdict stands.
    await f.command("email", { email: message() });
    await f.command("run", { run: run("twice", { type: "mark_read" }) });
    assert.equal((await f.command("check", { id: "twice" })).run.status, "failed");
    assert.equal((await f.command("check", { id: "twice" })).thrown, "run_not_uncertain");
  } finally {
    await f.mf.dispose();
  }
});

test("AUD-B11-12: POST /api/automation/:account/runs/:id/check answers 200, 404, 409 and 502 with sentences", async () => {
  const f = await fixture();
  try {
    await f.command("email", { email: message() });
    await f.command("run", { run: run("ok", { type: "mark_read" }) });
    await f.command("run", { run: run("done", { type: "archive" }, { status: "succeeded" }) });
    await f.command("run", { account: REMOTE, run: run("down", { type: "archive" }, { account: REMOTE, emailId: "message-3" }) });
    await f.command("accounts", { key: "message:g1:message-3", value: "down" });
    const post = (account: string, id: string) =>
      f.mf.dispatchFetch(`http://localhost/api/automation/${encodeURIComponent(account)}/runs/${id}/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const ok = await post(CF, "ok");
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { outcome: string }).outcome, "not_done");
    const missing = await post(CF, "nope");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "This run is not in the history" });
    const settled = await post(CF, "done");
    assert.equal(settled.status, 409);
    assert.deepEqual(await settled.json(), { error: "Only a run whose outcome is unknown can be checked" });
    const down = await post(REMOTE, "down");
    assert.equal(down.status, 502);
    assert.deepEqual(await down.json(), { error: "The outcome could not be checked right now. Try again." });
  } finally {
    await f.mf.dispose();
  }
});

test("AUD-B11-12: the run card offers Check status only for an uncertain run whose action leaves a record", () => {
  const base = { rule: { action: { type: "forward", to: "t@example.invalid" } } } as Parameters<typeof runCheckable>[0];
  assert.equal(runCheckable({ ...base, status: "unknown" }), true);
  for (const status of ["succeeded", "failed", "pending", "waiting_approval", "waiting_device", "cancelled", "skipped", "running"] as const)
    assert.equal(runCheckable({ ...base, status }), false, status);
  const tool = { status: "unknown", rule: { action: { type: "mcp" } } } as unknown as Parameters<typeof runCheckable>[0];
  assert.equal(runCheckable(tool), false, "a tool call leaves no receipt to check");
  // The action that ran is the proposal's, which the rule's later edits do not change.
  assert.equal(runCheckable({ ...tool, proposal: { action: { type: "archive" }, emailDigest: "d" } } as Parameters<typeof runCheckable>[0]), true);
});

/** The Rules and history screen rendered with the server's answers already in the cache. */
function renderRuns(account: string, runs: unknown[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["rules", account], []);
  client.setQueryData(["runs", account], runs);
  const router = createMemoryRouter([{ path: "/automation/:account", element: createElement(Automation) }], {
    initialEntries: ["/automation/" + encodeURIComponent(account)],
  });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
}

test("AUD-B11-12: an uncertain run card shows its uncertainty, attempts, when it was last checked and a Check status button (SCN-020 step 1)", () => {
  const html = renderRuns(CF, [run("u1", { type: "forward", to: "t@example.invalid" }, { checkedAt: "2026-10-07T11:00:00.000Z", attempts: 2 })]);
  assert.match(html, /Action outcome is uncertain\. Check the provider before repeating it\./);
  assert.match(html, /2 attempts/);
  assert.match(html, /Last checked /);
  assert.match(html, />Check status</);
});

test("AUD-B11-12: a tool-call run says it cannot be checked here and offers no button; a settled run offers none", () => {
  const tool = renderRuns(CF, [run("t1", { type: "mcp", endpoint: "https://tools.example.invalid/mcp", tool: "file", arguments: {}, location: "cloud" })]);
  assert.match(tool, /A tool call leaves no receipt on this server\./);
  assert.doesNotMatch(tool, />Check status</);
  const settled = renderRuns(CF, [run("s1", { type: "archive" }, { status: "succeeded", detail: "Checked: the message is archived." })]);
  assert.doesNotMatch(settled, />Check status</);
  assert.doesNotMatch(settled, /Last checked/);
});
