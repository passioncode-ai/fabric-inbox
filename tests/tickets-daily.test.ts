// B-211: the channel-agent standard's daily ticket counts (5.1) of one mail address, as support.tickets_daily.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { ticketsDay, TICKETS_NOT_MEASURED } from "../workers/agents/tickets-daily";
import { ticketsEvent } from "../workers/agents/events";
import { FINAL_LIMIT_MS } from "../workers/agents/ticket-outcome";
import { SKIP_TEXT } from "../workers/agents/prefilter";
import type { AgentRun } from "../workers/agents/run";

const DAY = "2026-11-03";
const NOW = Date.parse("2026-11-05T00:05:00.000Z");
const at = (t: string) => `${DAY}T${t}:00.000Z`;
let n = 0;
/** A run of a message that arrived at `received`; its other times default to a minute later. */
const run = (received: string, over: Partial<AgentRun> = {}): AgentRun => {
  const later = new Date(Date.parse(received) + 60_000).toISOString();
  return { id: "agent-" + String(++n).padStart(32, "0"), mailboxId: "support@acme.example", emailId: "m" + n, sender: "ann@customer.invalid",
    subject: "Question " + n, status: "sent", reason: "", toolCalls: [], agentId: "support", agentVersion: 1,
    createdAt: received, receivedAt: received, updatedAt: later, ...over };
};
const schema = JSON.parse(readFileSync("docs/agents/support-tickets-daily.schema.json", "utf8"));
const validate = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false }).compile(schema);
const modeOf = (r: AgentRun) => (r.agentId === "drafter" ? "draft" as const : "auto" as const);

test("B-211: one address's day: who arrived, who ended and how, who was open at the day's end", () => {
  n = 0;
  const runs = [
    run(at("10:00"), { repliedAt: at("10:02") }),
    run(at("11:00"), { repliedAt: at("13:00") }),
    // Came the evening before, held, answered this morning once the knowledge had it.
    run("2026-11-02T20:00:00.000Z", { attempt: 2, repliedAt: at("09:00") }),
    run(at("20:00"), { status: "held" }),
    run(at("12:00"), { status: "drafted", answeredByPerson: true, escalatedAt: at("14:00") }),
    run(at("12:30"), { status: "drafted", answeredByPerson: true, escalatedAt: at("15:00"), agentId: "drafter" }),
    run(at("12:00"), { handoff: true, repliedAt: at("12:01") }),
    run(at("15:30"), { fallback: true, repliedAt: at("16:00") }),
    // A draft nobody answered: its final mark passes this morning.
    run(new Date(Date.parse(at("08:00")) - FINAL_LIMIT_MS).toISOString(), { status: "drafted" }),
    run(at("09:30"), { status: "skipped", reason: "Duplicate: answered from sales@acme.example" }),
    // Answered after midnight: open at the day's end, in no open state of the standard.
    run(at("23:30"), { repliedAt: "2026-11-04T01:00:00.000Z" }),
    run(at("22:00"), { status: "drafted", answeredByPerson: true, escalatedAt: "2026-11-04T03:00:00.000Z" }),
    run(at("09:00"), { status: "skipped", reason: "Passed to a person: mail from this sender or on this topic is answered by a person, so nothing was sent" }),
    run(at("10:30"), { status: "skipped", reason: SKIP_TEXT.already_answered }),
    run(at("18:00"), { status: "send_failed" }),
    // The next day's message is not this day's.
    run("2026-11-04T08:00:00.000Z"),
  ];
  const v = ticketsDay({ address: "support@acme.example", day: DAY, runs, now: NOW, modeOf });
  assert.deepEqual(v, {
    date: DAY, channel: "mail:acme.example:support", standard: "channel-agent-standard/1",
    arrived: 12, ended: 10,
    openHandedOpen: 1, openQuestionOpen: 1, openAwaitingCustomer: 0, openAwaitingApproval: 1,
    answered: 2, answeredAfterQuestion: 1, toPersonPolicy: 2, toPersonInability: 1, handoffsClosedByPerson: 2,
    referred: 1, answeredElsewhere: 1, noReplyOwed: 0, customerSilent: 0, expiredByDecision: 0,
    expired: 1, unanswered: 2, firstReplyLate: 2, promotions: 0, fallbackTickets: 1, notATicket: 1,
    shareAnswered: 0.3, shareToPerson: 0.3, shareFallback: 0.1, shareUnanswered: 0.3,
    notMeasured: [...TICKETS_NOT_MEASURED],
  });
  assert.ok(validate(v), JSON.stringify(validate.errors));
});

test("B-211: a quiet day still reports, with no shares; nothing about a person leaves", () => {
  n = 0;
  const v = ticketsDay({ address: "Sales+EU@Acme.example", day: DAY, runs: [], now: NOW, modeOf });
  assert.equal(v.channel, "mail:acme.example:sales-eu");
  assert.equal(v.arrived, 0);
  assert.deepEqual([v.shareAnswered, v.shareToPerson, v.shareFallback, v.shareUnanswered], [null, null, null, null]);
  assert.ok(validate(v), JSON.stringify(validate.errors));
  const event = ticketsEvent("sales+eu@acme.example", ticketsDay({ address: "sales+eu@acme.example", day: DAY, runs: [run(at("10:00"))], now: NOW, modeOf }), new Date(NOW).toISOString());
  assert.equal(event.kind, "support.tickets_daily");
  assert.ok(!/customer\.invalid|Question \d/.test(JSON.stringify(event)), "no sender or subject in the event");
  assert.equal(event.text, "Tickets of sales+eu@acme.example on 2026-11-03: 1 arrived, 1 ended, 1 answered by the agent, 0 open.");
});
