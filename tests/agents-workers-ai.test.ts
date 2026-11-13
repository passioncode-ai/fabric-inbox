// B-258 (B-254): reply agents on a server's own Workers AI: a live default model, the reasoning effort Workers AI reads,
// and a check by another vendor before an answer is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AGENT_MODEL, RETIRED_WORKERS_AI_MODELS, WORKERS_AI_CHECK_MODELS, checkersFor, withReasoning, workersAiAgentModel, workersAiCheck } from "../workers/agents/model";

type Call = { model: string; inputs: Record<string, unknown> };
function fakeAi(answer: (model: string) => unknown, calls: Call[] = []): Ai {
  return { run: async (model: string, inputs: Record<string, unknown>) => { calls.push({ model, inputs }); const out = answer(model); if (out instanceof Error) throw out; return out; } } as never;
}
const reply = (content: string) => ({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const input = { message: "Is there a Linux version?", facts: "Downloads: macOS, Windows.", answer: "Yes, it runs on Linux." };

test("B-258: the default is a model Workers AI still serves after 2026-11-20, and a retired id a server names is replaced", () => {
  assert.equal(DEFAULT_AGENT_MODEL, "@cf/qwen/qwen3.8-27b");
  assert.equal(workersAiAgentModel(undefined), DEFAULT_AGENT_MODEL);
  assert.equal(workersAiAgentModel(" "), DEFAULT_AGENT_MODEL);
  for (const retired of ["@cf/moonshotai/kimi-k2.5", "@cf/moonshotai/kimi-k2.6"]) assert.equal(workersAiAgentModel(retired), DEFAULT_AGENT_MODEL);
  assert.equal(workersAiAgentModel("@cf/zai-org/glm-5.3"), "@cf/zai-org/glm-5.3", "a live model a server names is kept");
  assert.equal(RETIRED_WORKERS_AI_MODELS[DEFAULT_AGENT_MODEL], undefined);
  for (const model of WORKERS_AI_CHECK_MODELS) assert.equal(RETIRED_WORKERS_AI_MODELS[model], undefined);
});

test("B-258: the binding adds the model's reasoning effort, and keeps one a call names", async () => {
  const calls: Call[] = [];
  const ai = withReasoning(fakeAi(() => reply("ok"), calls));
  await ai.run(DEFAULT_AGENT_MODEL as never, { messages: [] } as never);
  await ai.run("@cf/deepseek-ai/deepseek-v4.1-flash-1017" as never, { messages: [] } as never);
  await ai.run("@cf/google/gemma-4-26b-a4b-it" as never, { messages: [] } as never);
  await ai.run(DEFAULT_AGENT_MODEL as never, { messages: [], reasoning_effort: "medium" } as never);
  assert.deepEqual(calls.map((c) => c.inputs.reasoning_effort), ["low", "none", undefined, "medium"]);
});

test("B-258: a Workers AI checker is of another vendor than the writer", () => {
  assert.deepEqual(checkersFor(DEFAULT_AGENT_MODEL, WORKERS_AI_CHECK_MODELS), ["@cf/deepseek-ai/deepseek-v4.1-flash-1017", "@cf/google/gemma-4-26b-a4b-it"]);
  assert.deepEqual(checkersFor("@cf/deepseek-ai/deepseek-v4.1-flash-1017", WORKERS_AI_CHECK_MODELS), ["@cf/google/gemma-4-26b-a4b-it", "@cf/qwen/qwen3.8-27b"]);
  assert.equal(checkersFor("qwen/qwen3.8-flash").includes("qwen/qwen3.8-flash"), false, "an OpenRouter id keeps its vendor");
});

test("B-258: the check asks the first checker, then the next when it fails or gives no verdict", async () => {
  const calls: Call[] = [];
  const refused = await workersAiCheck(fakeAi((m) => m.includes("deepseek") ? reply('{"approved": false, "reason": "Linux is not in the facts."}') : reply("x"), calls), DEFAULT_AGENT_MODEL, input);
  assert.deepEqual([refused.approved, refused.model], [false, "@cf/deepseek-ai/deepseek-v4.1-flash-1017"]);
  assert.equal(calls[0]!.inputs.reasoning_effort, "none");
  // A free Workers plan refuses DeepSeek: Gemma answers.
  const next = await workersAiCheck(fakeAi((m) => m.includes("deepseek") ? new Error("paid plan required") : reply('{"approved": true, "reason": "ok"}')), DEFAULT_AGENT_MODEL, input);
  assert.deepEqual([next.approved, next.model, next.usage.length], [true, "@cf/google/gemma-4-26b-a4b-it", 2]);
  // No verdict from any: the runner treats the throw as not approved.
  await assert.rejects(workersAiCheck(fakeAi(() => reply("I think it is fine")), DEFAULT_AGENT_MODEL, input), /no checker answered/);
});

test("B-258: a server without an OpenRouter key gives its runs a checker", async () => {
  const { sharedDeps } = await import("../workers/agents/deps");
  const deps = sharedDeps({ AI: fakeAi(() => reply('{"approved": true, "reason": "ok"}')) } as never, {} as never);
  assert.equal(typeof deps.check, "function");
  const verdict = await deps.check!(DEFAULT_AGENT_MODEL, input);
  assert.equal(verdict.model, "@cf/deepseek-ai/deepseek-v4.1-flash-1017");
});
