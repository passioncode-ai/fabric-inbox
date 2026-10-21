---
report:
  id: fabric-inbox/2026-10-21-checker-prices
  title: "Answer checkers on price answers (B-136)"
  kind: benchmark
  project: fabric-inbox
  domains: [llm, ai-agent, correctness]
  as_of: 2026-10-21
  status: active
  valid_until: 2027-01-19
  summary: >-
    The reply lane's answer checker refused correct price answers that carried arithmetic (a yearly
    price divided by 12, a discount applied once, a free agent left out). On nine synthetic price
    cases, four runs each, the current check prompt refused 2 of 15 (qwen) and 3 of 20 (mimo) correct
    answers and gave no verdict 6 times; a prompt that names arithmetic on the facts refused none,
    approved no wrong answer, and always answered, on all three checkers. The prompt ships in 0.24.0.
  sources:
    - name: "scripts/measure-checkers.ts (the cases, the two prompts, the run)"
      url: "../../../scripts/measure-checkers.ts"
      read_at: 2026-10-21
    - name: "Board row B-136 (from finding 4abf16c4 on thread c9a3cf06)"
      path: "docs/evidence/backlog.md"
      read_at: 2026-10-21
  produced_by:
    agent: "fabric-inbox coding agent (Claude Code)"
    task: "B-136"
  supersedes: []
  consumers: [fabric-inbox]
---

# Answer checkers on price answers (B-136)

## Главное

The check prompt, not the checker model, refused correct prices. With arithmetic on the facts named
as allowed (and the checker told to verify it), qwen, deepseek and mimo each made no error in either
direction on the cases below. The model order stays as the estate's model guide sets it (projects
wiki `synthesis/llm-models.md`: for a mimo draft qwen, then deepseek; for a deepseek draft mimo).

## Данные и метод

Nine synthetic cases on one set of synthetic price facts (`scripts/measure-checkers.ts`): five
correct answers (three with arithmetic: yearly discount, yearly price per month, a free agent left
out of a total; one plain price; one refund rule) and four wrong ones (a discount taken twice, a wrong
sum, an invented discount, a wrong refund window). Each case was checked four times by each model,
reasoning off, 400 output tokens, with the production prompt of the time (`current` in the table) and with the prompt that
names arithmetic (`arithmetic`, production since 0.24.0; the script now calls these `before` and `current`). Run 2026-10-21 on the product's OpenRouter key:
`OPENROUTER_API_KEY=… npx tsx scripts/measure-checkers.ts 4`, exit 0.

| prompt | checker | correct answers refused | wrong answers approved | no verdict | per case (right verdicts) |
|---|---|---|---|---|---|
| current | qwen/qwen3.8-flash | 2/15 | 0/16 | 5 | pricing-en:0/4 pricing-ru:4/4 refund:4/4 three-agents-month:3/4 two-agents-year:2/4 wrong-double-discount:4/4 wrong-invented:4/4 wrong-refund:4/4 wrong-total:4/4 |
| current | deepseek/deepseek-v4.1-flash | 0/20 | 0/16 | 0 | pricing-en:4/4 pricing-ru:4/4 refund:4/4 three-agents-month:4/4 two-agents-year:4/4 wrong-double-discount:4/4 wrong-invented:4/4 wrong-refund:4/4 wrong-total:4/4 |
| current | xiaomi/mimo-v2.6-pro | 3/20 | 0/15 | 1 | pricing-en:3/4 pricing-ru:4/4 refund:4/4 three-agents-month:4/4 two-agents-year:2/4 wrong-double-discount:4/4 wrong-invented:4/4 wrong-refund:3/4 wrong-total:4/4 |
| arithmetic | qwen/qwen3.8-flash | 0/20 | 0/16 | 0 | pricing-en:4/4 pricing-ru:4/4 refund:4/4 three-agents-month:4/4 two-agents-year:4/4 wrong-double-discount:4/4 wrong-invented:4/4 wrong-refund:4/4 wrong-total:4/4 |
| arithmetic | deepseek/deepseek-v4.1-flash | 0/20 | 0/16 | 0 | pricing-en:4/4 pricing-ru:4/4 refund:4/4 three-agents-month:4/4 two-agents-year:4/4 wrong-double-discount:4/4 wrong-invented:4/4 wrong-refund:4/4 wrong-total:4/4 |
| arithmetic | xiaomi/mimo-v2.6-pro | 0/20 | 0/16 | 0 | pricing-en:4/4 pricing-ru:4/4 refund:4/4 three-agents-month:4/4 two-agents-year:4/4 wrong-double-discount:4/4 wrong-invented:4/4 wrong-refund:4/4 wrong-total:4/4 |

"No verdict" is an answer without the JSON verdict or a failed call; the runner treats it as not
approved, so it holds a correct answer too.

## Выводы для проекта

- `CHECK_SYSTEM` (`workers/agents/model.ts`) now says that right arithmetic on the facts counts as
  stated and that the checker checks it; a wrong result is still refused (the wrong cases show it).
- No model change: the measurement gives no reason to leave the guide's order.
- Re-measure with real cases of a customer's knowledge when one shares them; this cut is synthetic.

## Источники

- `scripts/measure-checkers.ts` at the commit that adds this report.
- Board finding `4abf16c4` (thread `c9a3cf06`): the symptom on a customer's addresses, 2026-10-19 to 2026-10-21.

## Поправки
