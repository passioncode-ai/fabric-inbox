// B-192, B-186, B-187, B-188: what the logs can count while the runs cannot be read. The state-claim kinds of
// an answer (never its words), and one finished-run line with its status, category, abstention and withheld tools.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stateClaims } from "../workers/agents/state-claims";

test("an answer's state claims are named by kind, in English and Russian", () => {
  assert.deepEqual(stateClaims("Your Premium is now active, enjoy."), ["account_state"]);
  assert.deepEqual(stateClaims("The refund has been processed and should arrive in 5 days."), ["refund_done"]);
  assert.deepEqual(stateClaims("We have passed this to our developers."), ["passed_to_team"]);
  assert.deepEqual(stateClaims("Good news: the issue is fixed in the latest version."), ["fixed"]);
  assert.deepEqual(stateClaims("Ваша подписка уже активна."), ["account_state"]);
  assert.deepEqual(stateClaims("Возврат оформлен, деньги придут в течение недели."), ["refund_done"]);
  assert.deepEqual(stateClaims("Мы передали это разработчикам."), ["passed_to_team"]);
  assert.deepEqual(stateClaims("Мы исправили эту ошибку."), ["fixed"]);
  assert.deepEqual(stateClaims("Your subscription is active and the refund was issued; we've escalated it to the support team."),
    ["account_state", "refund_done", "passed_to_team"]);
});

test("instructions and questions are not claims", () => {
  for (const text of [
    "Open Settings → Premium and tap Restore purchase.",
    "To get a refund, request it from the App Store within 14 days.",
    "Is your subscription active on this device?",
    "Если подписка не активна, нажмите «Восстановить покупки».",
    "Hi Ann, it costs 10 EUR.",
  ]) assert.deepEqual(stateClaims(text), [], text);
});

test("the runner logs the kinds with a sent answer and one finished line per run; no words of the mail", () => {
  const runner = readFileSync(new URL("../workers/agents/runner.ts", import.meta.url), "utf8");
  assert.match(runner, /event: "agent_answer_sent".*stateClaims: stateClaims\(reply\.text\)/);
  assert.match(runner, /event: "agent_run_finished", run: run\.id, agent: run\.agentId \?\? null, status,\s+category: run\.category \?\? null, abstained: measured\.abstained, withheld: measured\.withheld, injection: !!run\.injection/);
  assert.match(runner, /event: "agent_tool_withheld", run: run\.id, tool: grant\.name, cause:/);
});
