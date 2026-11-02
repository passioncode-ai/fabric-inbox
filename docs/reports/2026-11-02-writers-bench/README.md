---
report: fabric-inbox/2026-11-02-writers-bench
project: fabric-inbox
date: 2026-11-02
row: B-174
---

# Writers compared on a week of a support address's mail (B-174)

**Question.** Does another writer model help the support address's customers more than the current one, without
answers that break policy? The voice-of-customer agent's rule for a switch: at least 10 more points of "helped" and
no more `policySafe` failures (board thread `a8a46b34`, message `4b547703`).

**Method.** The 24 messages the support address's reply agent ran on from 2026-10-27 to 2026-11-02 (UTC) were
replayed through `preview_agent_answer` (0.83.0, `model` per preview) on the server as deployed at `e7ce955`: the
same agent, knowledge, checker and policy, nothing sent. Each answer that would have been sent was graded blind by
the production judge rubric v1 (`workers/agents/judge.ts` `benchJudge`, reasoning off) with
`deepseek/deepseek-v4.1-flash`, a vendor other than both writers'. The judge saw the message and the answer, never the
writer. Mail text stayed on the operator's machine; this report holds counts only.

| Writer | Messages | Would send | Held | Skipped | Graded | Helped | Partly | No | `addressed` fail | `routing` fail | `policySafe` fail |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `xiaomi/mimo-v2.6-pro` (today's) | 24 | 9 | 8 | 7 | 9 | 0 | 3 | 6 | 5 | 6 | 0 |
| `anthropic/claude-haiku-5.5` | 24 | 8 | 6 | 10 | 8 | 0 | 6 | 2 | 2 | 2 | 0 |

- The two writers would send on the same 8 messages; `mimo` sends on one more.
- Grading cost USD 0.0019 for 17 verdicts. The writers' cost per preview is not in the preview's answer (its run
  omits `spent`), so it is unknown here, not zero.

**Reading.** Neither writer helped a customer fully (0 of 9, 0 of 8), so the switch rule's "10 more points of
helped" is not met. Haiku's answers miss the question and send the person elsewhere less often (`addressed` 2 of 8
against 5 of 9, `routing` 2 of 8 against 6 of 9) and are graded "partly" twice as often. With 8 and 9 graded
answers, the difference is a direction, not a result. What holds most answers back is the same for both: the
knowledge abstains (B-186), not the writer.

**Limits.** One judge model, not calibrated against a person (B-189); a week, one address; previews run against
today's knowledge, not the knowledge each message met.

**Next.** No writer change. Read again after B-186's restatement has a week of live mail (2026-11-09), and once a
person has graded 20 answers (B-189) so the judge can be trusted.
