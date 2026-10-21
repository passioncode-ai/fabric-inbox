import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { mailChannel, qualityDay, firstReplyAt } from "../workers/agents/quality";
import { qualityEvent } from "../workers/agents/events";
import type { AgentRun } from "../workers/agents/run";

const DAY = "2026-10-18";
const NOW = Date.parse("2026-10-19T00:05:00.000Z");
let n = 0;
const run = (over: Partial<AgentRun>): AgentRun => ({
  id: "agent-" + String(++n).padStart(32, "0"), mailboxId: "support@acme.example", emailId: "m" + n, sender: "ann@customer.invalid",
  subject: "Question " + n, status: "sent", reason: "", toolCalls: [], agentId: "support", agentVersion: 1,
  createdAt: `${DAY}T10:00:00.000Z`, updatedAt: `${DAY}T10:01:00.000Z`, receivedAt: `${DAY}T10:00:00.000Z`,
  modelCalls: { calls: 2, failed: 0, recovered: 0 }, model: "writer", ...over,
});

const schema = JSON.parse(readFileSync("docs/agents/support-quality-daily.schema.json", "utf8"));
const validate = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false }).compile(schema);

test("B-130: one address's day: coverage, first reply percentiles, repeats, autonomy split and the person queue", () => {
  n = 0;
  const runs = [
    run({ repliedAt: `${DAY}T10:02:00.000Z`, sent: { to: "ann@customer.invalid", subject: "Re", body: "Hello", outboxId: "o1" } }),
    // The same person asks the same thing again; the agent sends the same reply again.
    run({ subject: "Re: Question 1", createdAt: `${DAY}T11:00:00.000Z`, receivedAt: `${DAY}T11:00:00.000Z`, repliedAt: `${DAY}T11:10:00.000Z`,
      sent: { to: "ann@customer.invalid", subject: "Re", body: "Hello", outboxId: "o2" }, modelCalls: { calls: 2, failed: 1, recovered: 1 } }),
    run({ status: "sent", handoff: true, sender: "bob@customer.invalid", repliedAt: `${DAY}T12:01:00.000Z`, createdAt: `${DAY}T12:00:00.000Z`, receivedAt: `${DAY}T12:00:00.000Z` }),
    run({ status: "held", sender: "cy@customer.invalid", createdAt: `${DAY}T20:00:00.000Z`, receivedAt: `${DAY}T20:00:00.000Z` }),
    run({ status: "drafted", limited: true, sender: "di@customer.invalid" }),
    run({ status: "drafted", sender: "ed@customer.invalid", escalatedAt: `${DAY}T14:00:00.000Z`, agentId: "drafter" }),
    run({ status: "failed", sender: "fo@customer.invalid" }),
    run({ status: "send_unknown", sender: "gu@customer.invalid" }),
    // From the day before: answered again on this day once the knowledge had it.
    run({ status: "sent", attempt: 2, createdAt: "2026-10-17T09:00:00.000Z", receivedAt: "2026-10-17T09:00:00.000Z", repliedAt: `${DAY}T09:00:00.000Z`, sender: "ha@customer.invalid" }),
  ];
  const v = qualityDay({ address: "support@acme.example", day: DAY, received: 9, runs, now: NOW, modeOf: (r) => (r.agentId === "drafter" ? "draft" : "auto") });
  assert.equal(v.channel, "mail:acme.example:support");
  assert.deepEqual(v.coverage, { coverageBasis: "inbound", turns: 9, delivered: 3, undelivered: 1, firstReplyP50Ms: 120_000, firstReplyP90Ms: 600_000,
    repeatAsk: 1, agentRepeat: 1, followupsAnswered: 1, followupsPending: 1 });
  assert.deepEqual(v.stability, { errors: 1, modelCalls: 16, modelCallsFailed: 1, fallbackTurns: 1, processErrors: null, restarts: null });
  assert.equal(v.autonomy.answered, 2);
  assert.equal(v.autonomy.toPersonPolicy, 2, "the hand-off and the draft of a drafting agent");
  assert.equal(v.autonomy.toPersonInability, 1, "the held one");
  assert.equal(v.autonomy.limitReplies, 1);
  assert.equal(v.autonomy.noSafeDefault, 1, "the escalated draft nobody answered");
  assert.equal(v.autonomy.personQueueWaiting, 3, "held plus the two drafts");
  assert.equal(v.autonomy.personQueueOldestMs, NOW - Date.parse(`${DAY}T10:00:00.000Z`));
  assert.equal(v.autonomy.smalltalk, null);
  assert.deepEqual(v.notMeasured, ["processErrors", "quality", "restarts", "smalltalk"]);
  assert.equal(v.quality.judged, null, "not judged yet: null, never 0");
  assert.ok(validate(v), JSON.stringify(validate.errors));
});

test("B-130: what cannot be measured is null and named, never 0; nothing about a person leaves", () => {
  n = 0;
  const old = run({ modelCalls: undefined, model: "writer" });
  const v = qualityDay({ address: "Sales+EU@Acme.example", day: DAY, received: null, runs: [old], now: NOW, modeOf: () => "auto" });
  assert.equal(v.channel, "mail:acme.example:sales-eu");
  assert.equal(v.coverage.turns, null);
  assert.equal(v.stability.modelCalls, null);
  assert.ok(["turns", "modelCalls", "modelCallsFailed", "fallbackTurns", "quality"].every((f) => v.notMeasured.includes(f)));
  assert.equal(v.coverage.firstReplyP50Ms, null, "no reply that day");
  assert.ok(validate(v), JSON.stringify(validate.errors));
  const event = qualityEvent("sales+eu@acme.example", v, new Date(NOW).toISOString());
  assert.equal(event.kind, "support.quality_daily");
  const text = JSON.stringify(event.data);
  assert.ok(!/customer\.invalid|Question/.test(text), "no sender or subject in the event");
  // Two nesting levels at most under data.value (the Fabric events page).
  const depth = (x: unknown): number => (x && typeof x === "object" ? 1 + Math.max(0, ...Object.values(x).map(depth)) : 0);
  assert.ok(depth(event.data.value) <= 2);
});

test("B-130: the first reply is the waiting reply when it came first", () => {
  n = 0;
  const r = run({ acknowledged: { at: `${DAY}T12:00:00.000Z`, status: "accepted", text: "" }, repliedAt: `${DAY}T15:00:00.000Z` });
  assert.equal(firstReplyAt(r), Date.parse(`${DAY}T12:00:00.000Z`));
  assert.equal(firstReplyAt(run({ status: "held", repliedAt: undefined })), null);
});

test("review 2026-10-21: a run sent before repliedAt existed counts as delivered at its last update", () => {
  n = 0;
  const old = run({ repliedAt: undefined, updatedAt: `${DAY}T10:05:00.000Z`, sent: { to: "ann@customer.invalid", subject: "Re", body: "Hi", outboxId: "o" } });
  assert.equal(firstReplyAt(old), Date.parse(`${DAY}T10:05:00.000Z`));
  const v = qualityDay({ address: "support@acme.example", day: DAY, received: 1, runs: [old], now: NOW, modeOf: () => "auto" });
  assert.equal(v.coverage.delivered, 1);
  assert.equal(v.coverage.firstReplyP50Ms, 5 * 60_000);
  assert.equal(firstReplyAt(run({ status: "drafted", repliedAt: undefined })), null, "a draft is no reply");
});
