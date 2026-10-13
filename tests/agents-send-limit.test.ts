// The per-agent send limit is optional (operator, 2026-10-13: agents on this machine have no limits
// unless he sets one): null means no cap. Left out, it stays 20, so a new agent elsewhere is capped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ReplyPolicySchema } from "../workers/agents/definition";
import { decide } from "../workers/agents/policy";
import { policySummary } from "../app/components/settings/sections/add-address-model";

test("null is no limit; left out it is 20; a number stays 1–200", () => {
  assert.equal(ReplyPolicySchema.parse({ dailySendLimit: null }).dailySendLimit, null);
  assert.equal(ReplyPolicySchema.parse({}).dailySendLimit, 20);
  assert.equal(ReplyPolicySchema.parse({ dailySendLimit: 200 }).dailySendLimit, 200);
  assert.throws(() => ReplyPolicySchema.parse({ dailySendLimit: 0 }));
});

test("with no limit, an allowed grounded answer is sent however many went out today", () => {
  const policy = ReplyPolicySchema.parse({ mode: "auto", dailySendLimit: null });
  const out = decide(policy, { decision: "send", grounded: true, intent: "question", body: "Hi" } as never, { sentToday: 10_000 } as never);
  assert.equal(out.action, "send");
  const capped = decide(ReplyPolicySchema.parse({ mode: "auto", dailySendLimit: 3 }), { decision: "send", grounded: true, intent: "question", body: "Hi" } as never, { sentToday: 3 } as never);
  assert.equal(capped.action, "draft");
});

test("the settings say so, and the field is empty for no limit", () => {
  assert.match(policySummary({ replyPolicy: { mode: "auto", allowedIntents: [], dailySendLimit: null } } as never), /no daily limit/);
  const ui = readFileSync("app/components/settings/sections/AgentsSection.tsx", "utf8");
  assert.match(ui, /value=\{policy\.dailySendLimit \?\? ""\}/);
  assert.match(ui, /e\.target\.value\.trim\(\) === "" \? null :/);
  const tools = readFileSync("workers/mcp/tools.ts", "utf8");
  assert.match(tools, /dailySendLimit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)\.nullable\(\)\.default\(20\)/);
});
