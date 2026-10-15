// save_agent must carry every reply-policy field: a field its schema lacks is dropped without a word
// (2026-10-15: the send guards were lost on the way and an agent was saved to auto-send without them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TOOLS } from "../workers/mcp/tools";
import { ReplyPolicySchema } from "../workers/agents/definition";

test("save_agent's replyPolicy has exactly the fields of the agent's reply policy, and keeps the guards", () => {
  const tool = TOOLS.find((t) => t.name === "save_agent")!;
  const agent = (tool.input as Record<string, z.ZodTypeAny>).agent as z.ZodObject<z.ZodRawShape>;
  const policy = (agent.shape.replyPolicy as z.ZodOptional<z.ZodObject<z.ZodRawShape>>).unwrap();
  assert.deepEqual(Object.keys(policy.shape).sort(), Object.keys(ReplyPolicySchema.shape).sort());
  const parsed = z.object(tool.input).parse({ agentId: "a", expectedVersion: 1, agent: { name: "A", instructions: "x",
    replyPolicy: { mode: "auto", draftFollowUps: true, draftTopics: ["wallet"], requireEvidence: true } } });
  assert.deepEqual(parsed.agent.replyPolicy, { mode: "auto", allowedIntents: [], dailySendLimit: 20, draftFollowUps: true, draftTopics: ["wallet"], requireEvidence: true });
});
