# B-189: the quality judge measured against a person (task packet)

Status: decided 2026-10-27, built in 0.76.0. Board row: B-189 in [the board](../../evidence/backlog.md).

## Why

The daily quality judge (B-132, `workers/agents/judge.ts`) grades a sample of the answers reply agents sent
on six checks (`language`, `addressed`, `policySafe`, `routing`, `actionable`, `continuity`) and whether the
answer helped. Its numbers leave the server as `support.quality_daily`. The judge bench (B-152) compares it
with other models and a reasoning reference, all models: nothing says how often it agrees with a person.
The audit behind B-186 to B-189 (finding 6) asks for a small set of answers graded by a person and the
judge's agreement with it per check.

## Decisions (agent, 2026-10-27; by the audit's ask and the safest reversible option)

1. **What a person grades:** one sent answer on the judge's own rubric (v1): the six checks as `PASS`,
   `FAIL` or `NA`, and `helped` as `yes`, `partly`, `no` or `na`, with an optional note of at most 200
   characters. The grade stays on the run as `personGrade` {rubric, checks, helped, note, by, source, at};
   a later grade replaces it. Only a run that sent an answer can be graded.
2. **Who grades:** a signed-in person (`by` is their email). An agent key may record a grade a person gave
   elsewhere (the operator's words in a chat): it must name where in `source`, and the grade counts as
   `relayed`. A model's own opinion is not a person's grade and has no route.
3. **Blind:** the list of answers to grade never carries the judge's verdict, so the person is not
   anchored by it. It lists sent answers of the last `days` (default 30) not graded yet, the judged ones
   first (only they can be compared), newest first, with the run id, the address, the message id, the agent,
   the subject and the answer as sent. A run whose texts were removed after 30 days (B-130) is not
   listed.
4. **The calibration:** over the window, every run with both a judge verdict and a person's grade of the
   same rubric. Per check: how many pairs, how many agree, the two disagreements (`judgeHigher`: the judge passed
   what the person failed; `judgeLower`: the reverse), how many differ on `NA`, the agreement rate and Cohen's kappa over the
   pairs both marked `PASS` or `FAIL` (null when it is undefined). The same for `helped`. Fewer than 20
   pairs for a check is reported as `small: true`: a number, not yet a verdict.
5. **Where:** routes `GET /api/agent-grades`, `PUT /api/agent-runs/:id/grade`,
   `GET /api/agent-calibration`, workspace keys only; agent tools `list_answers_to_grade`,
   `grade_agent_answer`, `get_judge_calibration`. No screen in this packet: the quality numbers have none
   either (they are read through the agent protocol and the events feed).

## Requirements

| REQ | What | Verified by |
|---|---|---|
| REQ-1 | A grade of a sent run is stored and replaced; a run not sent, or a grade missing a check, is refused | `tests/judge-calibration.test.ts`, `tests/agents-registry.test.ts` B-189 |
| REQ-2 | A key's grade needs `source` and counts as relayed; a person's counts as a person's | `tests/judge-calibration.test.ts` B-189 |
| REQ-3 | The list to grade carries no judge verdict, puts judged runs first and leaves out graded and redacted ones | `tests/agents-registry.test.ts` B-189 |
| REQ-4 | Agreement, the two disagreements, `NA` differences and kappa per check and for `helped`; `small` under 20 pairs | `tests/judge-calibration.test.ts` B-189 |
| REQ-5 | Every route is an agent tool; a mailbox-limited key reaches none of them | `tests/mcp-coverage.test.ts`, `tests/judge-calibration.test.ts` B-189 |

## Not in this packet

A screen for grading in the app; a change of the judge's model or prompt from the numbers (that is a
decision once a check has enough pairs).
