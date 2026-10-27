import { test } from "node:test";
import assert from "node:assert/strict";
import { agreementOf, calibrationOf, parseGrade, SMALL_BELOW, type PersonGrade } from "../workers/agents/calibration";
import type { JudgeVerdict } from "../workers/agents/judge";

const all = (mark: string) => ({ language: mark, addressed: mark, policySafe: mark, routing: mark, actionable: mark, continuity: mark });

test("B-189: a grade marks every check and helped; a key's grade names its source and counts as relayed", () => {
  const ok = parseGrade({ checks: all("pass"), helped: "Yes", note: " short " }, "owner@owner.example", 0);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.grade, { rubric: "v1", checks: all("PASS"), helped: "yes", note: "short", by: "owner@owner.example", kind: "person", at: new Date(0).toISOString() });
  assert.equal(parseGrade({ checks: { ...all("PASS"), routing: "MAYBE" }, helped: "yes" }, "owner@owner.example").ok, false);
  assert.equal(parseGrade({ checks: { language: "PASS" }, helped: "yes" }, "owner@owner.example").ok, false, "every check");
  assert.equal(parseGrade({ checks: all("PASS"), helped: "much" }, "owner@owner.example").ok, false);
  assert.equal(parseGrade({ checks: all("PASS"), helped: "yes", note: "x".repeat(201) }, "owner@owner.example").ok, false);
  assert.equal(parseGrade({ checks: all("PASS"), helped: "yes" }, null).ok, false, "nobody signed in");
  assert.equal(parseGrade({ checks: all("PASS"), helped: "yes" }, "key:ops").ok, false, "a key names where the person gave it");
  const relayed = parseGrade({ checks: all("NA"), helped: "na", source: "the owner's chat, 2026-10-27" }, "key:ops");
  assert.ok(relayed.ok && relayed.grade.kind === "relayed" && relayed.grade.source === "the owner's chat, 2026-10-27");
});

test("B-189: agreement counts the pairs, the two disagreements, NA differences and Cohen's kappa", () => {
  const a = agreementOf([["PASS", "PASS"], ["PASS", "FAIL"], ["FAIL", "FAIL"], ["FAIL", "PASS"], ["NA", "PASS"], ["NA", "NA"]], ["PASS", "FAIL"], "NA");
  assert.deepEqual(a, { pairs: 4, agree: 2, judgeHigher: 1, judgeLower: 1, naDiffers: 1, rate: 0.5, kappa: 0, small: true });
  const perfect = agreementOf(Array.from({ length: SMALL_BELOW }, (_, i) => (i % 2 ? ["PASS", "PASS"] : ["FAIL", "FAIL"]) as [string, string]), ["PASS", "FAIL"], "NA");
  assert.equal(perfect.kappa, 1);
  assert.equal(perfect.small, false, `${SMALL_BELOW} pairs is enough`);
  assert.equal(agreementOf([["PASS", "PASS"]], ["PASS", "FAIL"], "NA").kappa, null, "one category on both sides: undefined");
  assert.deepEqual(agreementOf([], ["PASS", "FAIL"], "NA"), { pairs: 0, agree: 0, judgeHigher: 0, judgeLower: 0, naDiffers: 0, rate: null, kappa: null, small: true });
  const helped = agreementOf([["yes", "partly"], ["no", "partly"], ["yes", "yes"]], ["yes", "partly", "no"], "na");
  assert.equal(helped.judgeHigher, 1);
  assert.equal(helped.judgeLower, 1);
});

test("B-189: only runs with a judge verdict and a person's grade of the same rubric are pairs", () => {
  const judgement: JudgeVerdict = { rubric: "v1", model: "qwen/qwen3.8-flash", checks: all("PASS") as JudgeVerdict["checks"], question: true, helped: "yes", note: "" };
  const grade: PersonGrade = { rubric: "v1", checks: all("PASS") as PersonGrade["checks"], helped: "yes", by: "owner@owner.example", kind: "person", at: "" };
  const cal = calibrationOf([{ judgement, personGrade: grade }, { personGrade: { ...grade, kind: "relayed" } }, { judgement, personGrade: { ...grade, rubric: "v0" } }, { judgement }]);
  assert.equal(cal.graded, 1);
  assert.equal(cal.notJudged, 1);
  assert.equal(cal.relayed, 0);
  assert.equal(cal.checks.language.rate, 1);
});

test("B-189: the grading tools are the workspace's: a key limited to some mailboxes reaches none of them", async () => {
  const { TOOLS } = await import("../workers/mcp/tools");
  const { toolFitsScope } = await import("../workers/mcp/scope");
  for (const name of ["list_answers_to_grade", "grade_agent_answer", "get_judge_calibration"]) {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool, name);
    assert.equal(toolFitsScope(tool), false, name);
  }
});
