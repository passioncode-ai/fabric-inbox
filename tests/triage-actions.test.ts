import { test } from "node:test";
import assert from "node:assert/strict";
import { archiveMessages, canAct, discardMessages, doneText, learnedNotice, undoDone, type ActMessage } from "../app/components/inbox/triage-actions";

// Delete/Backspace and ⌘⌫ in the message list (operator, 2026-10-06): archive marks read, discard
// goes to Discarded and learns, both say so with Undo, and Undo puts each message back as it was.
const cf = (id: string, read = false): ActMessage => ({ id: `cf-${id}`, accountId: "cloudflare:hi@shop.example", provider: "cloudflare", providerMessageId: id, read });
const gm = (id: string, read = false): ActMessage => ({ id: `gm-${id}`, accountId: "imap:a1", provider: "imap", providerMessageId: id, read });

function recorder(answers: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const request = async (url: string, body: unknown, method = "POST") => {
    calls.push(`${method} ${url} ${JSON.stringify(body)}`);
    const answer = answers[`${method} ${url}`];
    if (answer instanceof Error) throw answer;
    return answer ?? {};
  };
  return { calls, request };
}

test("archive marks an unread message read, then archives it, for both kinds of account", async () => {
  const { calls, request } = recorder({ "POST /api/accounts/a1/messages/i-1-5/archive": { providerMessageId: "a-1-9" } });
  const done = await archiveMessages([cf("m1"), gm("i-1-5"), cf("m2", true)], request);
  assert.deepEqual(calls, [
    'PUT /api/v1/mailboxes/hi%40shop.example/emails/m1 {"read":true}',
    'POST /api/v1/mailboxes/hi%40shop.example/emails/m1/move {"folderId":"archive"}',
    'POST /api/accounts/a1/messages/i-1-5/read {"read":true}',
    'POST /api/accounts/a1/messages/i-1-5/archive {}',
    'POST /api/v1/mailboxes/hi%40shop.example/emails/m2/move {"folderId":"archive"}',
  ], "a read message is not marked again");
  assert.equal(done.kind, "archive");
  assert.deepEqual(done.items.map((i) => [i.id, i.unread]), [["m1", true], ["a-1-9", true], ["m2", false]], "the id an IMAP move gives is kept for Undo");
  assert.equal(doneText(done), "3 messages archived");
  assert.equal(doneText({ ...done, items: done.items.slice(0, 1) }), "Archived");
});

test("Undo of an archive moves each message back to the inbox and makes it unread again if it was", async () => {
  const { calls, request } = recorder();
  const done = await archiveMessages([cf("m1"), gm("i-1-5", true)], request);
  calls.length = 0;
  const undone = await undoDone(done, request);
  assert.deepEqual(undone, { restored: 2, failed: [] });
  assert.deepEqual(calls, [
    'POST /api/v1/mailboxes/hi%40shop.example/emails/m1/move {"folderId":"inbox"}',
    'PUT /api/v1/mailboxes/hi%40shop.example/emails/m1 {"read":false}',
    'POST /api/accounts/a1/messages/i-1-5/inbox {}',
  ]);
});

test("one message that fails does not stop the others, and is named", async () => {
  const { request } = recorder({ "POST /api/v1/mailboxes/hi%40shop.example/emails/m2/move": new Error("It is no longer here") });
  const done = await archiveMessages([cf("m1", true), cf("m2", true)], request);
  assert.equal(done.items.length, 1);
  assert.deepEqual(done.failed.map((f) => [f.message.providerMessageId, f.error]), [["m2", "It is no longer here"]]);
  assert.equal(doneText(done), "Archived; 1 could not be: It is no longer here");
});

test("discard sends every message in one request, keeps what the server says for Undo, and the first lesson is said once", async () => {
  const { calls, request } = recorder({ "POST /api/discard": {
    moved: 2, failed: [], results: [
      { accountId: "cloudflare:hi@shop.example", providerMessageId: "m1", id: "m1", from: "inbox", unread: true, learnedRuleId: "l-1a2b3c4d" },
      { accountId: "imap:a1", providerMessageId: "i-1-5", id: "x-2-1", from: "inbox", unread: false }],
    learned: [{ ruleId: "l-1a2b3c4d", kind: "list", label: "Weekly Digest", discards: 1, created: true }, { ruleId: "s-00000001", kind: "sender", label: "bob@x.example", discards: 3, created: false }],
  } });
  const done = await discardMessages([cf("m1"), gm("i-1-5", true)], request);
  assert.deepEqual(calls, ['POST /api/discard {"messages":[{"accountId":"cloudflare:hi@shop.example","providerMessageId":"m1"},{"accountId":"imap:a1","providerMessageId":"i-1-5"}]}']);
  assert.deepEqual(done.items.map((i) => i.id), ["m1", "x-2-1"]);
  assert.equal(doneText(done), "2 messages discarded");
  assert.deepEqual(learnedNotice(done), { text: "Future mail from Weekly Digest will go to Discarded.", ruleIds: ["l-1a2b3c4d"] });
  calls.length = 0;
  await undoDone(done, request);
  assert.deepEqual(calls, ['POST /api/discard/restore {"messages":[{"accountId":"cloudflare:hi@shop.example","providerMessageId":"m1","ruleId":"l-1a2b3c4d"}],"read":false,"unlearn":true}',
    'POST /api/discard/restore {"messages":[{"accountId":"imap:a1","providerMessageId":"x-2-1"}],"unlearn":true}'],
    "unread ones come back unread; what each discard taught (and only that) is taken back");
});

test("a discard the server refused entirely throws its reason; a rule it could not save is said", async () => {
  const refused = recorder({ "POST /api/discard": Object.assign(new Error("It is sent mail or a draft"), {}) });
  await assert.rejects(discardMessages([cf("s1")], refused.request), /sent mail/);
  const partly = recorder({ "POST /api/discard": { moved: 1, failed: [], results: [{ accountId: "cloudflare:hi@shop.example", providerMessageId: "m1", id: "m1", from: "inbox", unread: false }], learned: [], ruleError: "The messages were discarded, but nothing was learned: busy" } });
  const done = await discardMessages([cf("m1")], partly.request);
  assert.equal(doneText(done), "Discarded. The messages were discarded, but nothing was learned: busy");
  assert.equal(learnedNotice(done), null);
});

test("what each folder allows: archive from the inbox views, discard from anything but Sent, Drafts and Discarded", () => {
  assert.equal(canAct("archive", "inbox", { archive: true }), null);
  assert.equal(canAct("archive", "starred", undefined), null);
  assert.match(canAct("archive", "archive", undefined)!, /already/);
  assert.match(canAct("archive", "trash", undefined)!, /inbox/);
  assert.match(canAct("archive", "inbox", { archive: false })!, /no Archive folder/);
  assert.equal(canAct("discard", "spam", undefined), null);
  assert.equal(canAct("discard", "archive", undefined), null);
  assert.match(canAct("discard", "sent", undefined)!, /Sent/);
  assert.match(canAct("discard", "discarded", undefined)!, /already/);
});
