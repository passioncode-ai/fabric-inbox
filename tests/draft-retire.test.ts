// S07 (B-272): the agent's draft goes away once a reply is sent; one reply rule for every path (KIMI-49).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { referenceIds, replyTarget } from "../shared/mail/reply-target";
import { draftsToRetire, isUntouched, outcomeKindFor, repliedIndex, runKeepsWholeDraft, type ThreadRowFacts } from "../workers/agents/retire";
import { answeredRows } from "../app/components/inbox/quotes";
import { ticketOutcomeOf } from "../workers/agents/ticket-outcome";
import { threadRunView } from "../workers/lib/thread-runs";
import type { AgentRun } from "../workers/agents/run";

const thread: ThreadRowFacts[] = [
  { id: "m1", folder_id: "inbox", message_id: "<a@acme.example>", date: "2026-11-14T08:00:00Z" },
  { id: "d1", folder_id: "draft", in_reply_to: "m1", draft_revision: null, date: "2026-11-14T08:01:00Z" },
  { id: "m2", folder_id: "inbox", message_id: "<b@acme.example>", date: "2026-11-14T09:00:00Z" },
  { id: "d2", folder_id: "draft", in_reply_to: "m2", draft_revision: 1, date: "2026-11-14T09:01:00Z" },
  { id: "m3", folder_id: "inbox", message_id: "<c@acme.example>", date: "2026-11-14T10:00:00Z" },
  { id: "d3", folder_id: "draft", in_reply_to: "m3", draft_revision: 2, date: "2026-11-14T10:01:00Z" },
];

test("one resolver: In-Reply-To when it names a message of the thread, else the last References entry that does", () => {
  const known = new Set(["a@acme.example", "b@acme.example"]);
  assert.deepEqual(replyTarget({ inReplyTo: "<B@acme.example>" }, (id) => known.has(id)), { target: "b@acme.example", named: true });
  assert.deepEqual(replyTarget({ inReplyTo: "<gone@acme.example>", references: "<a@acme.example> <gone@acme.example>" }, (id) => known.has(id)),
    { target: "a@acme.example", named: true }, "the last References entry that names a message of the thread");
  assert.deepEqual(replyTarget({ references: '["<a@acme.example>","<b@acme.example>"]' }, (id) => known.has(id)), { target: "b@acme.example", named: true },
    "a sent message's References are stored as JSON");
  assert.deepEqual(replyTarget({}, () => true), { target: null, named: false });
  assert.deepEqual(referenceIds("<x@y.example>, <z@y.example>"), ["x@y.example", "z@y.example"]);
});

test("the same function decides the reader's thread and the server's retirement: one fixture feeds both", () => {
  // A reply naming the thread only in References.
  const sent = { references: "<a@acme.example> <b@acme.example>" };
  const server = repliedIndex(thread, sent);
  const reader = answeredRows([
    { internalId: "m1", rfcMessageId: "<a@acme.example>" }, { internalId: "d1", inReplyTo: "m1", draft: true },
    { internalId: "m2", rfcMessageId: "<b@acme.example>" }, { internalId: "s1", references: sent.references },
  ]);
  assert.equal(server, 2);
  assert.equal(reader[3], 2, "the reader shows the reply under the message the server retires drafts for");
  const src = readFileSync("app/components/inbox/quotes.ts", "utf8");
  assert.match(src, /replyTarget\(/, "the reader uses the shared resolver");
  assert.match(readFileSync("workers/agents/retire.ts", "utf8"), /replyTarget\(/, "the server uses the shared resolver");
});

test("a reply retires the drafts answering the replied-to message or an earlier one, never a later one or the one it came from", () => {
  assert.deepEqual(draftsToRetire(thread, { inReplyTo: "<b@acme.example>" }).map((d) => d.draftId), ["d1", "d2"]);
  assert.deepEqual(draftsToRetire(thread, { inReplyTo: "<b@acme.example>", sourceDraftId: "d2" }).map((d) => d.draftId), ["d1"], "the draft the send came from leaves by the send");
  assert.deepEqual(draftsToRetire(thread, { inReplyTo: "<c@acme.example>" }).map((d) => d.draftId), ["d1", "d2", "d3"]);
  assert.deepEqual(draftsToRetire(thread, { references: "<a@acme.example>" }).map((d) => d.draftId), ["d1"], "References only");
  assert.deepEqual(draftsToRetire(thread, {}), [], "a forward or a new message retires nothing");
  assert.deepEqual(draftsToRetire(thread, { inReplyTo: "<elsewhere@acme.example>" }), [], "no subject guess: a reply to a message not in the thread retires nothing");
  assert.deepEqual(draftsToRetire(thread, { sourceDraftAnswers: "m2" }).map((d) => d.draftId), ["d1", "d2"], "a card send whose chain is empty still names the message");
});

test("untouched is no revision or revision 1; a person's save or a person's copy makes it 2 or more", () => {
  assert.equal(isUntouched(null), true);
  assert.equal(isUntouched(1), true);
  assert.equal(isUntouched(2), false);
  assert.equal(isUntouched(undefined), true);
});

test("which kind a reply gives: an agent's is answered_by_agent; the run's own draft sent as written is approved_by_person", () => {
  assert.equal(outcomeKindFor("agent", null), "answered_by_agent");
  assert.equal(outcomeKindFor("agent", { isRunDraft: true, untouched: true }), "answered_by_agent");
  assert.equal(outcomeKindFor("person", { isRunDraft: true, untouched: true }), "approved_by_person");
  assert.equal(outcomeKindFor("person", { isRunDraft: true, untouched: false }), "answered_by_person");
  assert.equal(outcomeKindFor("person", null), "answered_by_person");
});

test("a draft is deleted only when the run keeps its whole text (KIMI-46)", () => {
  assert.equal(runKeepsWholeDraft({ draftId: "d1", draftText: "Hi", draftTextComplete: true }, "d1"), true);
  assert.equal(runKeepsWholeDraft({ draftId: "d1", draftText: "Hi", draftTextComplete: false }, "d1"), false, "cut text");
  assert.equal(runKeepsWholeDraft({ draftId: "d1" }, "d1"), false, "a run written before this change");
  assert.equal(runKeepsWholeDraft({ draftId: "d1", draftText: "Hi", draftTextComplete: true }, "d9"), false, "another draft");
});

const run = (over: Partial<AgentRun>): AgentRun => ({ id: "agent-" + "a".repeat(32), mailboxId: "help@owner.example", emailId: "m1", sender: "x@acme.example",
  subject: "Hello", status: "drafted", reason: "", toolCalls: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over });

test("ticket outcome reads outcome.kind first, answeredByPerson only for older runs", () => {
  const at = new Date().toISOString();
  assert.equal(ticketOutcomeOf(run({ outcome: { kind: "approved_by_person", at } })), "answered", "the agent's draft sent as written counts as answered by the agent");
  assert.equal(ticketOutcomeOf(run({ outcome: { kind: "answered_by_person", at } })), "closed_by_person");
  assert.equal(ticketOutcomeOf(run({ outcome: { kind: "answered_by_agent", at } })), "answered_elsewhere");
  assert.equal(ticketOutcomeOf(run({ outcome: { kind: "superseded", at } })), "handed_open");
  assert.equal(ticketOutcomeOf(run({ answeredByPerson: true })), "closed_by_person", "an older run");
  assert.equal(ticketOutcomeOf(run({})), "awaiting_approval");
  const quality = readFileSync("workers/agents/quality.ts", "utf8");
  assert.match(quality, /r\.status === "drafted" && !r\.outcome && !r\.answeredByPerson/, "a draft whose conversation ended waits no more");
});

test("the thread carries the run's card facts and its outcome, never its texts or tools", () => {
  const view = threadRunView(run({ draftId: "d1", reason: "Drafted", sources: [{ ref: "c/doc#1", collectionId: "c", title: "Prices", sourceUri: "" }],
    draftText: "secret text", draftTextComplete: true, toolCalls: [{ name: "x", host: "h", ok: true, ms: 1, result: "r" }], grounded: false, limited: true,
    outcome: { kind: "superseded", at: "2026-11-14T00:00:00Z" } }));
  assert.deepEqual(view.sources, [{ ref: "c/doc#1", title: "Prices" }]);
  assert.equal(view.draftKept, true);
  assert.equal(view.grounded, false);
  assert.equal(view.limited, true);
  assert.equal((view as Record<string, unknown>).draftText, undefined);
  assert.equal((view as Record<string, unknown>).toolCalls, undefined);
  assert.equal(view.outcome?.kind, "superseded");
});

test("the outbox payload carries who sent it and the draft it came from, outside the identity hash (R6-3)", () => {
  const src = readFileSync("workers/durableObject/index.ts", "utf8");
  assert.match(src, /submit\(mailboxId, key, \{ request, sentBy, \.\.\.\(command\.sourceDraft \? \{ sourceDraft: command\.sourceDraft \} : \{\}\) \}, identity\)/);
  assert.match(src, /const identity = \{ mailboxId, request: structuredClone\(request\), kind, originalEmailId: command\.originalEmailId, verifyContent: !!command\.verifyContent \};/,
    "the identity is unchanged, so a retry of an older send still matches");
  // R6-5: the outcome first, then the delete.
  const retire = src.slice(src.indexOf("async retireAgentDrafts"), src.indexOf("Sends a draft as it is"));
  assert.ok(retire.indexOf("settleDraftOutcome") < retire.indexOf("deleteUntouchedDraft"), "outcome written before the draft is deleted");
  assert.match(readFileSync("workers/routes/reply-forward.ts", "utf8"), /sentBy: sentByOf\(c\.req\.raw\)/, "the reply route says who sent it");
});
