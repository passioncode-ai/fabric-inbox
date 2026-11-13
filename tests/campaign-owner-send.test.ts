import { test } from "node:test";
import assert from "node:assert/strict";
import { runTool, toolsFor, type Ledger } from "../workers/mcp/protocol";
import { TOOLS } from "../workers/mcp/tools";
import { grantScope, grantsOfKey, type Grant } from "../workers/mcp/grants";
import type { Principal } from "../workers/mcp/keys";

/**
 * B-246 W5a (docs/app-store/tasks/2026-11-12-inbox-agent-grants.md, R-6): an agent that may prepare campaigns but not send
 * launches one only through the owner's approval, and that approval is bound to the campaign as it was then: its steps,
 * cap and window (its version) and the people still waiting. A change after the approval makes the code invalid.
 */

const launch = TOOLS.find((t) => t.name === "launch_campaign")!;
const sendEmail = TOOLS.find((t) => t.name === "send_email")!;
const drafts: Principal = { kind: "agent", label: "Outreach", level: "mail", send: "drafts", dailySendLimit: 30, keyId: "k-out", accounts: ["cloudflare:hello@owner.example"] };
const sender: Principal = { ...drafts, label: "Sender", send: "send", keyId: "k-send" };

/** A ledger that remembers the codes it issued, with the arguments' hash and whether the owner must approve. */
function memLedger() {
  const codes = new Map<string, { hash: string; owner: boolean; approved: boolean; used: boolean }>();
  let n = 0;
  const ledger: Ledger = {
    issueConfirmation: async (input) => { const code = `C${++n}`; codes.set(code, { hash: input.argsHash, owner: !!input.owner, approved: false, used: false }); return { code, expiresAt: Date.now() + 60_000 }; },
    consumeConfirmation: async ({ code, argsHash }) => {
      const c = codes.get(code);
      if (!c || c.used || c.hash !== argsHash) return false;
      if (c.owner && !c.approved) return "waiting";
      c.used = true; return true;
    },
    reserveSend: async () => ({ ok: true, used: 1, limit: 30 }), refundSend: async () => {}, record: async () => {},
  };
  return { ledger, codes };
}

/** A server with one campaign whose fingerprint the test changes, and a record of launches. */
function server() {
  const state = { fingerprint: "f1", launched: 0 };
  const api = {
    request: async (method: string, path: string) => {
      if (method === "GET" && path === "/api/campaigns/c1")
        return { status: 200, contentType: "application/json", data: { id: "c1", name: "Hello", sender: "hello@owner.example", dailyCap: 30, steps: [{}], counts: { queued: 3 }, fingerprint: state.fingerprint } };
      if (method === "POST" && path === "/api/campaigns/c1/launch") { state.launched++; return { status: 200, contentType: "application/json", data: { state: "running" } }; }
      return { status: 404, contentType: "application/json", data: { error: "no" } };
    },
  };
  return { api, state };
}

const out = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

test("a Drafts only key sees launch_campaign, never send_email", () => {
  const names = toolsFor(drafts, TOOLS).map((t) => t.name);
  assert.ok(names.includes("launch_campaign"));
  assert.ok(!names.includes(sendEmail.name));
});

test("a Drafts only key's launch waits for the owner, and the approval holds only for the campaign as it was", async () => {
  const { api, state } = server();
  const { ledger, codes } = memLedger();
  const ctx = { api, principal: drafts };
  const asked = out(await runTool(launch, { campaignId: "c1" }, ctx, ledger));
  assert.equal(asked.needsApproval, true, "the owner's approval stands in for the send this key may not make");
  assert.equal(codes.get(asked.confirm)!.owner, true);
  assert.equal(out(await runTool(launch, { campaignId: "c1", confirm: asked.confirm }, ctx, ledger)).waitingForApproval, true);
  assert.equal(state.launched, 0);

  codes.get(asked.confirm)!.approved = true;
  state.fingerprint = "f2"; // a recipient added after the approval
  const changed = await runTool(launch, { campaignId: "c1", confirm: asked.confirm }, ctx, ledger);
  assert.equal(changed.isError, true);
  assert.match(out(changed).error, /not valid/);
  assert.equal(state.launched, 0, "a campaign changed after the approval is not launched");

  const again = out(await runTool(launch, { campaignId: "c1" }, ctx, ledger));
  codes.get(again.confirm)!.approved = true;
  const done = out(await runTool(launch, { campaignId: "c1", confirm: again.confirm }, ctx, ledger));
  assert.equal(done.state, "running");
  assert.equal(state.launched, 1);
  assert.equal((await runTool(launch, { campaignId: "c1", confirm: again.confirm }, ctx, ledger)).isError, true, "an approval is used once");
});

test("a key that sends confirms its own launch, still bound to the campaign as it was", async () => {
  const { api, state } = server();
  const { ledger, codes } = memLedger();
  const ctx = { api, principal: sender };
  const asked = out(await runTool(launch, { campaignId: "c1" }, ctx, ledger));
  assert.equal(asked.needsConfirmation, true);
  assert.equal(codes.get(asked.confirm)!.owner, false);
  state.fingerprint = "f2";
  assert.equal((await runTool(launch, { campaignId: "c1", confirm: asked.confirm }, ctx, ledger)).isError, true);
  assert.equal(state.launched, 0);
});

test("under the grants, campaign without send reaches launch through the owner; send on the sender does not", () => {
  const live = (g: Omit<Grant, "holder" | "expiresAt">): Grant => ({ holder: { kind: "key", id: "k" }, expiresAt: null, ...g });
  const prepareOnly = [live({ mailboxes: ["cloudflare:hello@owner.example"], can: ["read", "draft", "campaign"], limits: { sendMode: "drafts", dailySendLimit: 30, ownerApproval: false } })];
  assert.deepEqual(grantScope(launch, prepareOnly), { allowed: true, accounts: ["cloudflare:hello@owner.example"], viaOwner: true });
  const sends = grantsOfKey({ id: "k", level: "mail", send: "send", dailySendLimit: 30, accounts: ["cloudflare:hello@owner.example"], approval: "agent", expiresAt: null });
  assert.deepEqual(grantScope(launch, sends), { allowed: true, accounts: ["cloudflare:hello@owner.example"], viaOwner: false });
  assert.equal(grantScope(sendEmail, prepareOnly).allowed, false, "every other send stays refused");
});
