import { test } from "node:test";
import assert from "node:assert/strict";
import { processRun } from "../workers/automation/engine";
import { RuleSchema, type Run } from "../workers/automation/policy";
const rule = RuleSchema.parse({
  id: "r",
  version: 1,
  name: "r",
  enabled: true,
  mode: "automatic",
  conditions: {},
  action: { type: "archive" },
});
function setup() {
  let effects = 0;
  let current = { ...rule };
  const writes: string[] = [];
  const run: Run = {
    id: "a",
    key: "k",
    account: "a@example.com",
    emailId: "e",
    subject: "x",
    rule: structuredClone(rule),
    status: "pending",
    createdAt: "",
    updatedAt: "",
  };
  const deps = {
    start: async (r: Run) => {
      writes.push("running");
      return true;
    },
    save: async (r: Run) => {
      writes.push(r.status);
    },
    currentRule: async () => current,
    email: async () => ({
      id: "e",
      sender: "x@example.com",
      subject: "x",
      body: "x",
      date: "",
    }),
    analyze: async () => ({ matches: true, summary: "x", draft: "x" }),
    claimDaily: async (_r: Run) => {
      writes.push("claim");
      return true;
    },
    execute: async () => {
      effects++;
      return "Archived";
    },
  };
  return {
    run,
    deps,
    writes,
    get effects() {
      return effects;
    },
    setRule: (r: typeof rule) => {
      current = r;
    },
  };
}
test("every processing pass counts as an attempt", async () => {
  const s = setup();
  s.run.rule.mode = "approval";
  s.setRule({ ...rule, mode: "approval" });
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "waiting_approval");
  assert.equal(s.run.attempts, 1);
  s.run.status = "pending";
  s.run.approved = true;
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "succeeded");
  assert.equal(s.run.attempts, 2);
});
test("a run cancelled before it starts is not counted as an attempt", async () => {
  const s = setup();
  s.setRule({ ...rule, enabled: false });
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "cancelled");
  assert.equal(s.run.attempts, undefined);
});
test("persist intent before effect and terminal replay does not execute", async () => {
  const s = setup();
  await processRun(s.run, s.deps);
  assert.deepEqual(s.writes, ["running", "succeeded"]);
  await processRun(s.run, s.deps);
  assert.equal(s.effects, 1);
});
test("approval mode waits; changed rule cancels approved action", async () => {
  const s = setup();
  s.run.rule.mode = "approval";
  s.setRule({ ...rule, mode: "approval" });
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "waiting_approval");
  assert.equal(s.effects, 0);
  s.run.status = "pending";
  s.run.approved = true;
  s.setRule({ ...rule, version: 2 });
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "cancelled");
  assert.equal(s.effects, 0);
});
test("pause during analysis is rechecked before external action", async () => {
  const s = setup();
  s.deps.analyze = async () => {
    s.setRule({ ...rule, enabled: false });
    return { matches: true, summary: "", draft: "" };
  };
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "cancelled");
  assert.equal(s.effects, 0);
});
test("transport exception is unknown and cannot be blindly repeated", async () => {
  const s = setup();
  let calls = 0;
  s.deps.execute = async () => {
    calls++;
    throw Error("timeout");
  };
  await processRun(s.run, s.deps);
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "unknown");
  assert.equal(calls, 1);
});
test("B-141: an AI condition that fails is logged and tried again, then fails after three attempts; nothing is executed", async () => {
  const s = setup();
  s.deps.analyze = async () => {
    throw Error("bad response");
  };
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => { logged.push(line); };
  try {
    await processRun(s.run, s.deps);
    assert.equal(s.run.status, "pending", "tried again, not silently failed");
    assert.ok(s.run.retryAt && Date.parse(s.run.retryAt) > Date.now() + 50_000, "after a minute");
    assert.match(s.run.detail ?? "", /attempt 1 of 3/);
    await processRun(s.run, s.deps);
    assert.equal(s.run.status, "pending");
    assert.ok(Date.parse(s.run.retryAt!) > Date.now() + 4 * 60_000, "then after five minutes");
    await processRun(s.run, s.deps);
    assert.equal(s.run.status, "failed");
    assert.equal(s.run.attempts, 3);
    assert.match(s.run.detail ?? "", /after 3 attempts/);
  } finally { console.warn = warn; }
  assert.equal(s.effects, 0);
  const events = logged.map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.event, e.attempt, e.retry]), [["automation_analysis_failed", 1, true], ["automation_analysis_failed", 2, true], ["automation_analysis_failed", 3, false]]);
  assert.equal(events[0].error, "bad response");
  assert.ok(!JSON.stringify(events).includes("x@example.com"), "no message data in the log");
});
test("an already running record is not replayed", async () => {
  const s = setup();
  s.run.status = "running";
  await processRun(s.run, s.deps);
  assert.equal(s.effects, 0);
});

test("cancelled durable claim prevents stale queued snapshot executing", async () => {
  const s = setup();
  s.deps.start = async () => false;
  await processRun(s.run, s.deps);
  assert.equal(s.effects, 0);
});

test("approval is bound to the exact message and resolved proposal", async () => {
  const s = setup();
  const approvedRule = {
    ...rule,
    mode: "approval" as const,
    action: {
      type: "mcp" as const,
      endpoint: "https://tools.example.com/mcp",
      tool: "record",
      arguments: { body: "{{email.body}}" },
      location: "cloud" as const,
    },
  };
  s.setRule(approvedRule);
  s.run.rule = approvedRule;
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "waiting_approval");
  assert.deepEqual(s.run.proposal?.action, {
    ...approvedRule.action,
    arguments: { body: "x" },
  });
  s.run.status = "pending";
  s.run.approved = true;
  s.deps.email = async () => ({
    id: "e",
    sender: "x@example.com",
    subject: "x",
    body: "changed",
    date: "",
  });
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "cancelled");
  assert.equal(s.effects, 0);
});
test("known rejection before execution remains failed rather than unknown", async () => {
  const { ActionRejected } = await import("../workers/automation/engine");
  const s = setup();
  s.deps.execute = async () => {
    throw new ActionRejected("No attachments supported");
  };
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "failed");
  assert.equal(s.run.detail, "No attachments supported");
});

test("B-05: the daily limit is taken only after every condition, the AI condition included, matched", async () => {
  const s = setup();
  s.run.counted = false;
  s.deps.analyze = async () => ({ matches: false, summary: "", draft: "" });
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "skipped");
  assert.ok(!s.writes.includes("claim"), "a message the AI condition turns away costs no action");
});
test("B-05: past the daily limit the run is skipped with the reason and nothing is executed", async () => {
  const s = setup();
  s.run.counted = false;
  s.deps.claimDaily = async () => false;
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "skipped");
  assert.match(s.run.detail ?? "", /Daily rule limit reached/);
  assert.equal(s.effects, 0);
});
test("B-05: an approval run takes the limit once, when it is proposed, not again when approved", async () => {
  const s = setup();
  s.run.counted = false;
  s.run.rule.mode = "approval";
  s.setRule({ ...rule, mode: "approval" });
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "waiting_approval");
  s.run.status = "pending";
  s.run.approved = true;
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "succeeded");
  assert.equal(s.writes.filter((w) => w === "claim").length, 1);
});
test("B-05: a run stored before B-05 (no counted field) took its count when queued and is not asked again", async () => {
  const s = setup();
  await processRun(s.run, s.deps);
  assert.equal(s.run.status, "succeeded");
  assert.ok(!s.writes.includes("claim"));
});
