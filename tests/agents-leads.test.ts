// B-237 gap 8: the lead hand-off to a sales agent (workers/agents/leads.ts, runner.ts, registry.ts pollLeads).
import { test } from "node:test";
import assert from "node:assert/strict";
import { leadAction, leadKey, parseStatus, parseSubmit, submitArguments } from "../workers/agents/leads";

test("a conversation's key is a digest, the same for every message of it, with no address in it", async () => {
  const a = await leadKey("Sales@Acme.example", "<thread-1@mail.example>");
  assert.equal(a, await leadKey("sales@acme.example", "<thread-1@mail.example>"));
  assert.notEqual(a, await leadKey("sales@acme.example", "<thread-2@mail.example>"));
  assert.match(a, /^mail-[0-9a-f]{32}$/);
});

test("the submit carries the source, the mail channel, consent and an opaque handle; the summary is cut to 500", () => {
  const args = submitArguments("mail-1", `Wants   ads\n${"x".repeat(600)}`, "ru");
  assert.equal(args.source, "fabric-inbox");
  assert.equal(args.channel, "mail");
  assert.equal(args.consent, true);
  assert.equal(args.caller_key, "mail-1");
  assert.equal(args.contact_handle, "mail-1");
  assert.equal(args.language, "ru");
  assert.equal(String(args.summary).length, 500);
  assert.ok(String(args.summary).startsWith("Wants ads x"));
  assert.equal("language" in submitArguments("mail-1", "s", null), false);
});

test("submit and status answers are read; anything else is null", () => {
  assert.deepEqual(parseSubmit('{"lead_id":"L1","state":"received","stage":"new"}'), { leadId: "L1", state: "received" });
  assert.equal(parseSubmit("not json"), null);
  assert.equal(parseSubmit('{"state":"received"}'), null);
  const withReply = parseStatus('{"stage":"qualified","answered":false,"reply":{"id":"r1","text":"Hello, here are our terms.","language":"en"}}')!;
  assert.deepEqual(withReply.reply, { id: "r1", text: "Hello, here are our terms." });
  assert.equal(leadAction(withReply), "deliver");
  assert.equal(leadAction(parseStatus('{"stage":"won","answered":true,"reply":null}')!), "close");
  assert.equal(leadAction(parseStatus('{"stage":"lost","reply":null}')!), "close");
  assert.equal(leadAction(parseStatus('{"stage":"qualifying","reply":{"id":"r2","text":"  "}}')!), "wait", "an empty reply is not delivered");
  assert.equal(parseStatus('{"reply":null}'), null);
});
