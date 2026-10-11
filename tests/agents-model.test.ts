import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV3 } from "ai/test";
import { runModel, SUBMIT_NOW } from "../workers/agents/model";
import type { ModelRequest } from "../workers/agents/runner";
import { AgentInputSchema } from "../workers/agents/definition";

/**
 * The model adapter (workers/agents/model.ts) against a scripted language
 * model: every run ends with `submit_answer` when the model is able to, even
 * one that loops on tools or stops with prose — the live failure of 2026-09-29.
 */
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = (unified: string) => ({ unified, raw: unified });
const call = (toolName: string, input: unknown, n: number) =>
  ({ content: [{ type: "tool-call", toolCallId: `c${n}`, toolName, input: JSON.stringify(input) }], finishReason: finish("tool-calls"), usage, warnings: [] });
const prose = (text: string) => ({ content: [{ type: "text", text }], finishReason: finish("stop"), usage, warnings: [] });
const ANSWER = { decision: "draft", intent: "pricing", grounded: true, body: "It is free during the preview.", reason: "" };

function request(searched: string[]): ModelRequest {
  const agent = { ...AgentInputSchema.parse({ name: "Support", instructions: "Answer.", collections: ["faq"] }), id: "support", version: 1, createdAt: "x" };
  return { agent, system: "system", prompt: "{}", tools: [{ name: "search_knowledge", description: "search", run: async (a) => { searched.push(String(a.query)); return "[P1] Pricing — faq/pricing.md\nFree."; } }] };
}

test("a model that stops with prose is given one turn that can only submit", async () => {
  const searched: string[] = [];
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      n++;
      if (n === 1) return call("search_knowledge", { query: "price" }, n) as never;
      if (n === 2) return prose("Let me think about this.") as never;
      assert.deepEqual(options.toolChoice, { type: "tool", toolName: "submit_answer" });
      assert.deepEqual(options.tools?.map((t) => t.name), ["submit_answer"], "only submit_answer is on offer");
      assert.match(JSON.stringify(options.prompt), new RegExp(SUBMIT_NOW.slice(0, 30)));
      return call("submit_answer", ANSWER, n) as never;
    },
  });
  const r = await runModel(model, request(searched));
  assert.deepEqual(r.decision, ANSWER);
  assert.deepEqual(searched, ["price"]);
  assert.equal(n, 3);
});

test("a model that keeps calling tools is made to submit on its last step", async () => {
  const searched: string[] = [];
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      n++;
      // On its last step the model is offered submit_answer alone.
      if (options.tools?.length === 1 && options.tools[0].name === "submit_answer") return call("submit_answer", ANSWER, n) as never;
      return call("search_knowledge", { query: `q${n}` }, n) as never;
    },
  });
  const r = await runModel(model, request(searched));
  assert.deepEqual(r.decision, ANSWER);
  assert.equal(n, 6, "five searches, then submit_answer alone on the sixth step");
  assert.equal(searched.length, 5);
});

test("a model that never submits returns no decision, so the runner can leave the message for a person", async () => {
  const model = new MockLanguageModelV3({ doGenerate: async () => prose("") as never });
  const r = await runModel(model, request([]));
  assert.equal(r.decision, null);
  assert.equal(r.text, "");
});

test("B-85 REQ-1: a granted tool with a schema is offered that schema and called with the model's arguments as they are", async () => {
  const got: Record<string, unknown>[] = [];
  const agent = { ...AgentInputSchema.parse({ name: "Support", instructions: "Answer." }), id: "support", version: 1, createdAt: "x" };
  const schema = { type: "object", properties: { query: { type: "string", description: "What to find" } }, required: ["query"] };
  const req: ModelRequest = { agent, system: "s", prompt: "{}", tools: [
    { name: "nicegram_kb", description: "kb", inputSchema: schema, run: async (a) => { got.push(a); return "{}"; } },
    { name: "legacy_tool", description: "old grant", run: async (a) => { got.push(a); return "{}"; } },
  ] };
  let offered: { name: string; inputSchema?: unknown }[] = [];
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      n++;
      if (n === 1) { offered = (options.tools ?? []) as never; return call("nicegram_kb", { query: "translator" }, n) as never; }
      if (n === 2) return call("legacy_tool", { arguments: { order: "A-1" } }, n) as never;
      return call("submit_answer", ANSWER, n) as never;
    },
  });
  await runModel(model, req);
  const kb = offered.find((t) => t.name === "nicegram_kb")!;
  assert.deepEqual((kb.inputSchema as { properties: unknown }).properties, schema.properties, "the endpoint's own schema");
  const legacy = offered.find((t) => t.name === "legacy_tool")!;
  assert.ok("arguments" in ((legacy.inputSchema as { properties: Record<string, unknown> }).properties), "an older grant keeps the wrapper");
  assert.deepEqual(got, [{ query: "translator" }, { order: "A-1" }]);
});

test("B-85 review: arguments that do not fit the tool's schema never reach the endpoint", async () => {
  const got: unknown[] = [];
  const agent = { ...AgentInputSchema.parse({ name: "Support", instructions: "Answer." }), id: "support", version: 1, createdAt: "x" };
  const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
  const req: ModelRequest = { agent, system: "s", prompt: "{}", tools: [{ name: "nicegram_kb", description: "kb", inputSchema: schema, run: async (a) => { got.push(a); return "{}"; } }] };
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      n++;
      if (n === 1) return call("nicegram_kb", { domain: "everything" }, n) as never;
      return call("submit_answer", ANSWER, n) as never;
    },
  });
  await runModel(model, req);
  assert.deepEqual(got, [], "a call without the required query is refused before the endpoint");
});
