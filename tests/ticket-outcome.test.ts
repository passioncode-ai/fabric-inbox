// B-199: every message an agent took, in the channel-agent standard's outcomes (section 3), and the four numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FINAL_LIMIT_MS, summarizeOutcomes, ticketOutcomeOf } from "../workers/agents/ticket-outcome";
import { SKIP_TEXT } from "../workers/agents/prefilter";
import type { AgentRun } from "../workers/agents/run";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const DAY = 24 * 3600 * 1000;
let n = 0;
const run = (over: Partial<AgentRun>, ageMs = DAY): AgentRun => {
  const at = new Date(NOW - ageMs).toISOString();
  return { id: "agent-" + String(++n).padStart(32, "0"), mailboxId: "support@acme.example", emailId: "m" + n, sender: "ann@customer.invalid",
    subject: "Question " + n, status: "sent", reason: "", toolCalls: [], createdAt: at, updatedAt: at, receivedAt: at, ...over };
};

test("B-199: each run reads as the standard's outcome", () => {
  const cases: [Partial<AgentRun>, string, number?][] = [
    [{ status: "sent" }, "answered"],
    [{ status: "sent", handoff: true, reason: "Handed to a person: the reply says whom to contact" }, "referred"],
    [{ status: "sent", fallback: true }, "expired"],
    [{ status: "sent", gapClosed: { at: "x", item: null, revision: null } }, "answered_after_question"],
    [{ status: "sent", attempt: 2 }, "answered_after_question"],
    [{ status: "drafted" }, "awaiting_approval"],
    [{ status: "drafted", answeredByPerson: true }, "closed_by_person"],
    [{ status: "drafted" }, "unanswered", FINAL_LIMIT_MS + DAY],
    [{ status: "held" }, "question_open"],
    [{ status: "held", closedAt: "x", closing: { status: "accepted" } }, "expired"],
    [{ status: "held", closedAt: "x", closing: { status: "not_sent" } }, "unanswered"],
    [{ status: "failed" }, "received"],
    [{ status: "send_failed" }, "unanswered"],
    [{ status: "send_unknown" }, "received"],
    [{ status: "skipped", reason: SKIP_TEXT.already_answered }, "answered_elsewhere"],
    [{ status: "skipped", reason: "Passed to a person: mail from this sender or on this topic is answered by a person, so nothing was sent" }, "handed_open"],
    [{ status: "skipped", reason: "Held for review by the safety check: x", injection: true }, "handed_open"],
    [{ status: "skipped", reason: "The agent found nothing to answer" }, "no_reply_owed"],
    [{ status: "skipped", reason: "Duplicate: answered from sales@acme.example" }, "not_a_ticket"],
  ];
  for (const [over, expected, age] of cases) assert.equal(ticketOutcomeOf(run(over, age), NOW), expected, JSON.stringify(over));
});

test("B-199: every prefilter skip but a person's reply is not a ticket", () => {
  for (const [reason, text] of Object.entries(SKIP_TEXT)) {
    const outcome = ticketOutcomeOf(run({ status: "skipped", reason: text }), NOW);
    assert.equal(outcome, reason === "already_answered" ? "answered_elsewhere" : "not_a_ticket", reason);
  }
});

test("B-199: the four numbers are shares of the ended messages; open ones and non-tickets are counted apart", () => {
  const runs = [
    run({ status: "sent" }), run({ status: "sent" }), run({ status: "sent", handoff: true }),
    run({ status: "sent", fallback: true }), run({ status: "drafted", answeredByPerson: true }),
    run({ status: "held" }), run({ status: "skipped", reason: "Bulk or list precedence" }),
  ];
  const s = summarizeOutcomes(runs, NOW);
  assert.equal(s.ended, 5);
  assert.equal(s.open, 1);
  assert.equal(s.arrived, 6);
  assert.equal(s.notATicket, 1);
  assert.deepEqual(s.four, { answered: 0.4, toPerson: 0.4, fallback: 0.2, unanswered: 0.2 });
  assert.equal(s.handoffsClosedByPerson, 1);
  assert.ok(s.notMeasured.includes("customer_silent"), "what the server cannot see is named, never counted as 0");
  assert.deepEqual(summarizeOutcomes([], NOW).four, { answered: null, toPerson: null, fallback: null, unanswered: null });
});

test("B-199: the route and the tool are wired, and list_agent_runs carries each run's outcome", () => {
  const route = readFileSync("workers/routes/agents.ts", "utf8");
  assert.match(route, /agentsRouter\.get\("\/api\/agent-outcomes"/);
  assert.match(route, /ticketOutcome: ticketOutcomeOf\(run, now\)/);
  assert.match(readFileSync("workers/mcp/tools.ts", "utf8"), /name: "get_agent_outcomes"[\s\S]*routes: \["GET \/api\/agent-outcomes"\]/);
});
