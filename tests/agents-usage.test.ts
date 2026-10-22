import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptOf, unmeasured } from "../workers/agents/usage";
import { usageReport } from "../workers/routes/fabric-service";

/** B-147: one receipt per model call from the provider's own numbers; unknown is null, never 0. */
test("B-147: a receipt sums every step's tokens and OpenRouter's charge; a step without a charge leaves the cost unknown", () => {
  const step = (cost?: number) => ({ providerMetadata: cost === undefined ? {} : { openrouter: { usage: { cost } } } });
  assert.deepEqual(receiptOf("x/m", { totalUsage: { inputTokens: 1200, outputTokens: 80 }, steps: [step(0.0004), step(0.00011)] }),
    { model: "x/m", inputTokens: 1200, outputTokens: 80, costUsd: 0.00051, measured: true });
  assert.equal(receiptOf("x/m", { totalUsage: { inputTokens: 5, outputTokens: 1 }, steps: [step(0.1), step()] }).costUsd, null);
  // Workers AI reports tokens and no charge: measured, unpriced.
  assert.deepEqual(receiptOf("@cf/m", { usage: { inputTokens: 10, outputTokens: 2 } }), { model: "@cf/m", inputTokens: 10, outputTokens: 2, costUsd: null, measured: true });
  // No token count at all: unmeasured, with the 0s the report reads as a lower bound.
  assert.deepEqual(receiptOf("x/m", {}), { model: "x/m", inputTokens: 0, outputTokens: 0, costUsd: null, measured: false });
  assert.deepEqual(unmeasured("x/m"), { model: "x/m", inputTokens: 0, outputTokens: 0, costUsd: null, measured: false });
});

test("B-147: the writer and its fallback each leave a receipt, a failed call an unmeasured one", async () => {
  const { openRouterAgentModel } = await import("../workers/agents/model");
  const decision = { decision: "send" as const, intent: "q", grounded: true, body: "Hi.", reason: "" };
  const run = (answers: Record<string, unknown>) => async (model: { modelId?: string }) => {
    const id = String(model.modelId); const a = answers[id]; if (a instanceof Error) throw a;
    return { ...(a as object), usage: [{ model: id, inputTokens: 100, outputTokens: 10, costUsd: 0.001, measured: true }] } as never;
  };
  let r = await openRouterAgentModel("k", {} as never, {}, run({ "xiaomi/mimo-v2.6-pro": new Error("down"), "deepseek/deepseek-v4.1-flash": { decision, text: "" } }));
  assert.deepEqual(r.usage?.map((u) => [u.model, u.measured, u.costUsd]), [["xiaomi/mimo-v2.6-pro", false, null], ["deepseek/deepseek-v4.1-flash", true, 0.001]]);
  r = await openRouterAgentModel("k", {} as never, {}, run({ "xiaomi/mimo-v2.6-pro": { decision, text: "" } }));
  assert.deepEqual(r.usage?.map((u) => u.model), ["xiaomi/mimo-v2.6-pro"]);
  const both = await openRouterAgentModel("k", {} as never, {}, run({ "xiaomi/mimo-v2.6-pro": new Error("a"), "deepseek/deepseek-v4.1-flash": new Error("b") }))
    .then(() => null, (e: { usage?: { measured: boolean }[] }) => e);
  assert.deepEqual(both?.usage?.map((u) => u.measured), [false, false], "both failed calls are on the error");
});

test("B-147: the report carries tokens and USD where receipts priced them, a lower bound where some did not", () => {
  const row = (model: string, calls: number, unpriced: number, unmeasuredCalls: number, cost: number, tokens = [0, 0]) =>
    ({ day: "2026-10-22", model, calls, unpricedCalls: unpriced, unmeasuredCalls, inputTokens: tokens[0]!, outputTokens: tokens[1]!, costUsd: cost });
  const r = usageReport([row("x/a", 2, 0, 0, 0.003, [2000, 100]), row("y/b", 3, 1, 1, 0.002, [900, 40]), row("z/c", 1, 1, 1, 0)], "default", new Date("2026-10-22T12:00:00Z"));
  const day = r.days[0]!;
  assert.deepEqual(day.byModel.map((m) => [m.model, m.costBasis, m.costUsd]), [["x/a", "provider", 0.003], ["y/b", "mixed", 0.002], ["z/c", "unknown", null]]);
  assert.deepEqual([day.calls, day.unpricedCalls, day.unmeasuredCalls, day.inputTokens, day.outputTokens, day.costUsd], [6, 2, 2, 2900, 140, 0.005]);
});
