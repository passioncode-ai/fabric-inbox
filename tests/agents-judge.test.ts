import { test } from "node:test";
import assert from "node:assert/strict";
import { judgesFor, parseVerdict, qualityOf, CHECKS, type JudgeVerdict } from "../workers/agents/judge";

test("B-132: the judge is of another vendor than the writer and the checker, open vendors only", () => {
  assert.deepEqual(judgesFor("xiaomi/mimo-v2.6-pro", "qwen/qwen3.8-flash"), ["deepseek/deepseek-v4.1-flash"]);
  assert.deepEqual(judgesFor("deepseek/deepseek-v4.1-flash", undefined), ["qwen/qwen3.8-flash", "xiaomi/mimo-v2.6-pro"]);
  assert.deepEqual(judgesFor("xiaomi/a", "deepseek/b", ["xiaomi/x", "deepseek/y"]), [], "none left: nothing is judged");
});

test("B-132: a verdict is the rubric's JSON or nothing; the note is cut to 15 words and loses personal data", () => {
  const ok = parseVerdict('Here: {"language":"PASS","addressed":"fail","policySafe":"PASS","routing":"NA","actionable":"PASS","continuity":"PASS","question":true,"helped":"partly","note":"Did not say where to write; ann@customer.invalid one two three four five six seven eight nine ten eleven"}', "deepseek/deepseek-v4.1-flash")!;
  assert.equal(ok.checks.addressed, "FAIL");
  assert.equal(ok.helped, "partly");
  assert.ok(!ok.note.includes("@"));
  assert.ok(ok.note.split(" ").length <= 15);
  assert.equal(parseVerdict('{"language":"MAYBE"}', "m"), null);
  assert.equal(parseVerdict("not json", "m"), null);
  const small = parseVerdict('{"language":"PASS","addressed":"PASS","policySafe":"PASS","routing":"PASS","actionable":"NA","continuity":"PASS","question":false,"helped":"yes","note":""}', "m")!;
  assert.equal(small.helped, "na", "helped counts real questions only");
});

test("B-132: the day's quality family counts helped among questions and pass/fail per check", () => {
  const v = (over: Partial<JudgeVerdict>): JudgeVerdict => ({ rubric: "v1", model: "deepseek/deepseek-v4.1-flash", question: true, helped: "yes", note: "",
    checks: Object.fromEntries(CHECKS.map((c) => [c, "PASS"])) as JudgeVerdict["checks"], ...over });
  const q = qualityOf([v({}), v({ helped: "no", checks: { ...v({}).checks, addressed: "FAIL" } }), v({ question: false, helped: "na", checks: { ...v({}).checks, actionable: "NA" } })])!;
  assert.equal(q.model, "deepseek/deepseek-v4.1-flash");
  assert.deepEqual([q.quality.judged, q.quality.questions, q.quality.helpedYes, q.quality.helpedPartly, q.quality.helpedNo], [3, 2, 1, 0, 1]);
  assert.deepEqual([q.quality.addressedPass, q.quality.addressedFail, q.quality.actionablePass, q.quality.actionableFail], [2, 1, 2, 0]);
  assert.equal(qualityOf([]), null);
});

test("B-152: a bench model that cannot answer with reasoning off is asked again with the least reasoning, and the result says so", async () => {
  const { benchJudge } = await import("../workers/agents/judge");
  const real = globalThis.fetch;
  const bodies: Record<string, any>[] = [];
  const verdict = '{"language":"PASS","addressed":"PASS","policySafe":"PASS","routing":"PASS","actionable":"FAIL","continuity":"PASS","question":true,"helped":"partly","note":"x"}';
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (body.reasoning?.enabled === false)
      return new Response(JSON.stringify({ error: { code: 400, message: "Reasoning is mandatory for this endpoint and cannot be disabled." } }), { status: 400, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id: "r", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: verdict }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0002 } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const input = { message: "How do I?", earlier: "", answer: "Open Settings." };
    const forced = await benchJudge("k", "maker/always-reasons", input, false);
    assert.equal(forced.ok, true);
    assert.equal(forced.reasoning, true);
    assert.equal(forced.checks?.actionable, "FAIL");
    assert.deepEqual(bodies.map((b) => b.reasoning), [{ enabled: false }, { effort: "low" }]);
    bodies.length = 0;
    const plain = await benchJudge("k", "maker/plain", input, true);
    assert.equal(plain.reasoning, true);
    assert.deepEqual(bodies.map((b) => b.reasoning), [{ enabled: true }], "the reference reasons from the start, once");
  } finally { globalThis.fetch = real; }
});
