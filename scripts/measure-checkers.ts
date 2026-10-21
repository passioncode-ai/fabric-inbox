// B-136: how often each answer checker refuses a correct price answer, and approves a wrong one, on
// synthetic price fixtures; the current check prompt against one that names arithmetic. A measurement,
// not a test: it calls OpenRouter (OPENROUTER_API_KEY from the vault, never typed) and prints a table.
//
//   OPENROUTER_API_KEY=… npx tsx scripts/measure-checkers.ts [runs]
import { generateText } from "ai";
import { openRouter, CHECK_SYSTEM } from "../workers/agents/model";

const FACTS = `Plans (prices in USD, per agent):
- Starter: $20 per agent per month, billed monthly.
- Starter, billed yearly: 20% off the monthly price, paid once a year.
- Team: $45 per agent per month; billed yearly it is $432 per agent per year.
- A workspace has one agent included free on every plan; each further agent is billed.
Refunds: a yearly plan can be refunded within 14 days of payment.`;

interface Case { id: string; message: string; answer: string; correct: boolean }
const CASES: Case[] = [
  { id: "two-agents-year", correct: true, message: "How much is Starter for two agents for a whole year if I pay yearly?",
    answer: "Starter billed yearly is 20% off $20, so $16 per agent per month. One agent is included free, so you pay for one: $16 × 12 = $192 for the year." },
  { id: "pricing-en", correct: true, message: "What does Team cost per month for one extra agent?",
    answer: "Team is $45 per agent per month. Billed yearly it is $432 per agent per year, which works out to $36 a month." },
  { id: "pricing-ru", correct: true, message: "Сколько стоит Starter в месяц и сколько при оплате за год?",
    answer: "Starter стоит $20 за агента в месяц. При оплате за год скидка 20%: $16 в месяц, то есть $192 за агента в год." },
  { id: "three-agents-month", correct: true, message: "We need three agents on Starter, monthly. Total?",
    answer: "One agent is included free, so you pay for two: 2 × $20 = $40 a month." },
  { id: "refund", correct: true, message: "Can I get my money back on a yearly plan?",
    answer: "Yes: a yearly plan can be refunded within 14 days of payment." },
  { id: "wrong-double-discount", correct: false, message: "How much is Starter for one agent for a year, paid yearly?",
    answer: "Starter yearly is 20% off, so $16 a month, and the yearly payment takes another 20% off: $153.60 for the year." },
  { id: "wrong-total", correct: false, message: "Team for two paid agents, yearly?",
    answer: "Team billed yearly is $432 per agent, so two agents cost $964 a year." },
  { id: "wrong-invented", correct: false, message: "Is there a discount for nonprofits?",
    answer: "Yes, nonprofits get 50% off every plan." },
  { id: "wrong-refund", correct: false, message: "Can I get a refund on a yearly plan after a month?",
    answer: "Yes, yearly plans can be refunded within 30 days." },
];

// The prompt before B-136 (2026-10-21), kept to compare against: the production prompt without its arithmetic line.
const BEFORE = CHECK_SYSTEM.split("\n").filter((line) => !line.startsWith("Arithmetic on the facts")).join("\n");

const MODELS = ["qwen/qwen3.8-flash", "deepseek/deepseek-v4.1-flash", "xiaomi/mimo-v2.6-pro"];

async function verdict(model: string, system: string, c: Case): Promise<boolean | null> {
  try {
    const result = await generateText({
      model: openRouter(process.env.OPENROUTER_API_KEY!).chat(model), system, maxOutputTokens: 400,
      providerOptions: { openrouter: { reasoning: { enabled: false } } },
      prompt: `<message>\n${c.message}\n</message>\n\n<facts>\n${FACTS}\n</facts>\n\n<answer>\n${c.answer}\n</answer>`,
    });
    const json = /\{[\s\S]*\}/.exec(result.text)?.[0];
    const v = json ? (JSON.parse(json) as { approved?: unknown }) : null;
    return typeof v?.approved === "boolean" ? v.approved : null;
  } catch { return null; }
}

const runs = Number(process.argv[2] || 4);
if (!process.env.OPENROUTER_API_KEY) { console.error("OPENROUTER_API_KEY is needed (from the vault)."); process.exit(1); }
const rows: string[] = [];
for (const [label, system] of [["before", BEFORE], ["current", CHECK_SYSTEM]] as const) {
  for (const model of MODELS) {
    let falseRefusals = 0, falseApprovals = 0, unread = 0, right = 0, wrong = 0;
    const perCase: string[] = [];
    await Promise.all(CASES.map(async (c) => {
      let ok = 0;
      for (let i = 0; i < runs; i++) {
        const v = await verdict(model, system, c);
        if (v === null) { unread++; continue; }
        if (c.correct) { right++; if (!v) falseRefusals++; else ok++; } else { wrong++; if (v) falseApprovals++; else ok++; }
      }
      perCase.push(`${c.id}:${ok}/${runs}`);
    }));
    rows.push(`| ${label} | ${model} | ${falseRefusals}/${right} | ${falseApprovals}/${wrong} | ${unread} | ${perCase.sort().join(" ")} |`);
    console.error(rows.at(-1));
  }
}
console.log(["| prompt | checker | correct answers refused | wrong answers approved | no verdict | per case (right verdicts) |", "|---|---|---|---|---|---|", ...rows].join("\n"));
