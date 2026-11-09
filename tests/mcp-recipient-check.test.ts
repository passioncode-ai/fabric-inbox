// B-241: an agent's send to an address of the organization goes only when the organization's recipient check says ok.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineTool, runTool, type Ledger } from "../workers/mcp/protocol";
import { forwardRefusal, guarded, recipientCheckFrom, type RecipientCheck } from "../workers/mcp/recipient-check";
import type { Principal } from "../workers/mcp/keys";

const agent: Principal = { kind: "agent", label: "Agent", level: "mail", send: "send", dailySendLimit: 5, keyId: "k", accounts: null };
const owner: Principal = { kind: "owner", label: "Owner", level: "admin", send: "send", dailySendLimit: null, keyId: null, accounts: null };
const ledger = (over: Partial<Ledger> = {}): Ledger => ({
  issueConfirmation: async () => ({ code: "CODE", expiresAt: 0 }), consumeConfirmation: async () => true,
  reserveSend: async () => ({ ok: true, used: 1, limit: 5 }), refundSend: async () => {}, record: async () => {}, ...over,
});
const api = { request: async () => ({ status: 200, data: {}, contentType: "application/json" }) };

function sender(sent: string[][]) {
  return defineTool({ name: "send_thing", title: "Send", description: "Sends a thing for the test, to the addresses it is given.", level: "mail", sends: true,
    input: { to: z.array(z.string()) }, routes: ["POST /x"], recipients: (a: { to: string[] }) => a.to,
    call: async (a: { to: string[] }) => { sent.push(a.to); return { sent: true }; } } as never);
}
const checker = (verdicts: Record<string, string>, asked: string[] = []): RecipientCheck =>
  ({ domains: async () => ["team.example"], check: async (email) => { asked.push(email); return (verdicts[email] ?? "unknown") as never; } });

test("an agent's send to an address of the organization goes only on ok; another verdict refuses it with its code", async () => {
  const sent: string[][] = [];
  const asked: string[] = [];
  const recipientCheck = checker({ "ann@team.example": "ok", "bob@team.example": "left" }, asked);
  const ok = JSON.parse((await runTool(sender(sent), { to: ["ann@team.example", "client@outside.example"] }, { api, principal: agent, recipientCheck }, ledger())).content[0]!.text);
  assert.equal(ok.sent, true);
  assert.deepEqual(asked, ["ann@team.example"], "an outside address is not the check's");
  const refused = await runTool(sender(sent), { to: ["Bob@Team.example"] }, { api, principal: agent, recipientCheck }, ledger());
  assert.equal(refused.isError, true);
  const body = JSON.parse(refused.content[0]!.text);
  assert.deepEqual([body.code, body.outcome], ["recipient_left", "not_sent"]);
  assert.equal(sent.length, 1, "the refused send never ran");
  let reserved = 0;
  await runTool(sender(sent), { to: ["bob@team.example"] }, { api, principal: agent, recipientCheck }, ledger({ reserveSend: async () => { reserved++; return { ok: true, used: 1, limit: 5 }; } }));
  assert.equal(reserved, 0, "a refused send takes nothing from the key's daily sends");
});

test("domains that cannot be read refuse the send, never let it through unchecked", async () => {
  const sent: string[][] = [];
  const broken: RecipientCheck = { domains: async () => { throw new Error("R2 down"); }, check: async () => "ok" };
  const out = JSON.parse((await runTool(sender(sent), { to: ["ann@team.example"] }, { api, principal: agent, recipientCheck: broken }, ledger())).content[0]!.text);
  assert.equal(out.code, "recipient_unreachable");
  assert.equal(sent.length, 0);
});

test("an unreachable check refuses (fail-closed); the person's own sends and a server without the check are not asked", async () => {
  const sent: string[][] = [];
  const down = JSON.parse((await runTool(sender(sent), { to: ["ann@team.example"] }, { api, principal: agent, recipientCheck: checker({ "ann@team.example": "unreachable" }) }, ledger())).content[0]!.text);
  assert.equal(down.code, "recipient_unreachable");
  assert.match(down.error, /could not be reached/);
  await runTool(sender(sent), { to: ["bob@team.example"] }, { api, principal: owner, recipientCheck: checker({}) }, ledger());
  await runTool(sender(sent), { to: ["bob@team.example"] }, { api, principal: agent, recipientCheck: null }, ledger());
  assert.equal(sent.length, 2);
});

test("the check is configured per server: https only, a token, the guarded domains; its answer is read strictly", async () => {
  const served = async () => ["team.example", "Other.example"];
  assert.equal(recipientCheckFrom({}, served), null, "unset: nothing is checked");
  const base = { RECIPIENT_CHECK_URL: "https://door.example/recipient-check", RECIPIENT_CHECK_TOKEN: "t" };
  assert.deepEqual(await recipientCheckFrom(base, served)!.domains(), ["team.example", "other.example"], "every served domain by default");
  assert.deepEqual(await recipientCheckFrom({ ...base, RECIPIENT_CHECK_DOMAINS: "staff.example" }, served)!.domains(), ["staff.example"]);
  assert.equal(guarded("a@mail.team.example", ["team.example"]), true);
  assert.equal(guarded("a@notteam.example", ["team.example"]), false);
  const seen: { url: string; auth: string | null; redirect?: string }[] = [];
  const fetcher = (answer: unknown, status = 200) => (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    return new Response(JSON.stringify(answer), { status });
  }) as typeof fetch;
  const env = { RECIPIENT_CHECK_URL: "https://door.example/recipient-check", RECIPIENT_CHECK_TOKEN: "t", RECIPIENT_CHECK_DOMAINS: "team.example" };
  assert.equal(await recipientCheckFrom(env, served, fetcher({ verdict: "ok" }))!.check("Ann@Team.example"), "ok");
  assert.equal(seen[0]!.url, "https://door.example/recipient-check?email=ann%40team.example");
  assert.equal(seen[0]!.auth, "Bearer t");
  assert.equal(seen[0]!.redirect, "manual", "a redirect is never followed with the token");
  assert.equal(await recipientCheckFrom({ ...env, RECIPIENT_CHECK_URL: "https://door.example:8443/recipient-check" }, served, fetcher({ verdict: "ok" }))!.check("a@team.example"), "ok");
  assert.equal(seen.at(-1)!.url, "https://door.example:8443/recipient-check?email=a%40team.example", "the port is kept");
  assert.equal(await recipientCheckFrom(env, served, fetcher({ verdict: "ok" }, 302))!.check("a@team.example"), "unreachable");
  assert.equal(await recipientCheckFrom(env, served, fetcher({ verdict: "mismatch" }))!.check("a@team.example"), "mismatch");
  assert.equal(await recipientCheckFrom(env, served, fetcher({ verdict: "maybe" }))!.check("a@team.example"), "unreachable", "an unknown answer is no ok");
  assert.equal(await recipientCheckFrom(env, served, fetcher({ verdict: "ok" }, 401))!.check("a@team.example"), "unreachable");
  assert.equal(await recipientCheckFrom(env, served, (async () => { throw new Error("down"); }) as never)!.check("a@team.example"), "unreachable");
  assert.equal(await recipientCheckFrom({ ...env, RECIPIENT_CHECK_URL: "http://door.example/x" }, served, fetcher({ verdict: "ok" }))!.check("a@team.example"), "unreachable", "plain http is never trusted");
  assert.equal(await recipientCheckFrom({ ...env, RECIPIENT_CHECK_TOKEN: "" }, served, fetcher({ verdict: "ok" }))!.check("a@team.example"), "unreachable", "no token: refused, not sent unchecked");
});

test("a rule's forward goes through the same check: off or outside it goes, ok goes, anything else names the verdict", async () => {
  assert.equal(await forwardRefusal(null, "ann@team.example"), null);
  const guard = checker({ "ann@team.example": "ok", "bob@team.example": "do-not-contact" });
  assert.equal(await forwardRefusal(guard, "client@outside.example"), null);
  assert.equal(await forwardRefusal(guard, "ann@team.example"), null);
  assert.equal(await forwardRefusal(guard, "bob@team.example"), "do-not-contact");
  assert.equal(await forwardRefusal(guard, "new@team.example"), "unknown");
  assert.equal(await forwardRefusal({ domains: async () => { throw new Error("R2 down"); }, check: async () => "ok" }, "ann@team.example"), "unreachable");
});

test("the rule engine refuses a forward the check refused before anything leaves", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../workers/automation/index.ts", import.meta.url), "utf8");
  const execute = source.indexOf("private async execute(");
  const at = source.indexOf("forwardRefusal(recipientCheckFrom(this.env", execute);
  assert.ok(execute > 0 && at > execute && at < source.indexOf("const remote = parseRemoteAccount(run.account);", execute), "checked before either provider sends");
});
