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
