// B-172: how the spam check judges a labelled set of real messages, the check before B-172 (spam as a
// category beside the workspace's categories) against the one that names the message's kind first, on
// one or more models. A measurement, not a test: it calls Workers AI over Cloudflare's REST API
// (CLOUDFLARE_API_TOKEN with Workers AI access and CLOUDFLARE_ACCOUNT_ID), or with --provider openrouter
// the same open models on OpenRouter (OPENROUTER_API_KEY), keys from the vault, never typed; it prints a table.
//
// The set is the owner's own mail and never enters Git: one JSON object per line with `to`, `sender`,
// `fromShown`, `subject`, `text`, `headers` ({key, value}[]), `label` ("spam", "ham" or "ham_bulk": a
// newsletter of a service the owner uses) and `kind` ("transactional", "person", "bulk", ...). Keep it
// under deployments/<name>/ (git-ignored).
//
//   npx tsx scripts/measure-spam.ts <set.jsonl> [--provider workers-ai|openrouter] [--models a,b] [--variants before,after] [--errors <out.jsonl>] [--concurrency 3]
import fs from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import { classify, DEFAULT_CATEGORY_MODEL, type DescribedCategory } from "../workers/categories/classify";
import { judgeSpam } from "../workers/spam/judge";
import { authResults, spamCheck, tooLittleToJudge, verifiedDomain } from "../shared/mail/spam";

interface Item { n: number; to: string; sender: string; fromShown: string; subject: string; text: string;
  headers: { key: string; value: string }[]; label: "spam" | "ham" | "ham_bulk"; kind: string }
type Verdict = { spam: boolean; source: "rule" | "model" | "skip" | "error"; reason: string; kind?: string };

// Spam as it was asked until B-172: one more described category in the categories' call.
const SPAM_ID = "__spam";
const SPAM_CATEGORY: DescribedCategory = {
  id: SPAM_ID,
  name: "Spam",
  description: [
    "Mail the recipient did not ask for and would not want: phishing or fake account and payment notices,",
    "scams, fake invoices, unsolicited bulk marketing, and cold sales or link-building outreach from strangers.",
    "Not spam: a person writing to them for a real reason (a question, a complaint, a refund, a job, a partnership they may want),",
    "replies, receipts, sign-in codes, account and service notices, and newsletters or updates from a service they use.",
    "Reason in English.",
  ].join(" "),
};
// The category the owner's workspace screens every message for, so "before" asks what production asked.
const REFUND = { id: "refund-requests", name: "Refund requests",
  description: "The sender asks for a refund or their money back, cancels a paid subscription and wants the charge returned, or disputes a charge. Receipts and payment confirmations alone do not belong here." };

// HTTP/1.1 for every OpenRouter call: Node's shared HTTP/2 session was destroyed under load and failed
// most calls with "The session has been destroyed" (2026-10-26), which measures the network, not the model.
const http1 = new Agent({ allowH2: false, connections: 8 });
const fetchHttp1 = ((url: string, init: object) => undiciFetch(url, { ...init, dispatcher: http1 })) as unknown as typeof fetch;

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const path = args[0];
if (!path || !fs.existsSync(path)) { console.error("usage: npx tsx scripts/measure-spam.ts <set.jsonl> [--models a,b] [--variants before,after] [--errors out.jsonl]"); process.exit(1); }
const provider = flag("--provider") ?? "workers-ai";
if (provider === "openrouter" ? !process.env.OPENROUTER_API_KEY : !process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error(provider === "openrouter" ? "OPENROUTER_API_KEY is needed (from the vault)." : "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are needed (from the vault)."); process.exit(1);
}
const models = (flag("--models") ?? (provider === "openrouter" ? "meta-llama/llama-4-scout" : DEFAULT_CATEGORY_MODEL)).split(",");
const variants = (flag("--variants") ?? "before,after").split(",") as ("before" | "after")[];
const errorsPath = flag("--errors");
const items = fs.readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item);
const ownDomains = [...new Set(items.map((i) => i.to.slice(i.to.lastIndexOf("@") + 1)))];
const modelOf = (name: string): LanguageModel => provider === "openrouter"
  ? createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY!, fetch: fetchHttp1 }).chat(name)
  : createWorkersAI({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID!, apiKey: process.env.CLOUDFLARE_API_TOKEN! })(name as never);

async function judge(variant: "before" | "after", model: LanguageModel, item: Item): Promise<Verdict> {
  // A provider's transient failure is asked again (three tries), so the table counts the model, not the network.
  for (let attempt = 1; ; attempt++) {
    const v = await judgeOnce(variant, model, item);
    if (v.source !== "error" || attempt === 3) return v;
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

async function judgeOnce(variant: "before" | "after", model: LanguageModel, item: Item): Promise<Verdict> {
  const rule = spamCheck({ sender: item.sender, headers: item.headers, ownDomains, lists: { blockedSenders: [], blockedDomains: [], allowedSenders: [], allowedDomains: [] }, known: false,
    // "before" is the arrival rules as they were too: the shown name was not read until B-172.
    senderName: variant === "after" ? shownName(item.fromShown) : null });
  if (rule.verdict !== "screen") return { spam: rule.verdict === "spam", source: "rule", reason: rule.reason };
  if (tooLittleToJudge(item.text)) return { spam: false, source: "skip", reason: "too little text" };
  try {
    if (variant === "before") {
      const v = (await classify(model, [REFUND, SPAM_CATEGORY], { sender: item.sender, subject: item.subject, text: item.text, to: item.to }))
        .find((x) => x.id === SPAM_ID)!;
      return { spam: v.match, source: "model", reason: v.reason };
    }
    const name = shownName(item.fromShown);
    const j = await judgeSpam(model, { sender: item.sender, senderName: name || undefined, to: item.to, subject: item.subject, text: item.text,
      verified: verifiedDomain(authResults(item.headers), item.sender) });
    return { spam: j.spam, source: "model", reason: j.reason, kind: j.kind };
  } catch (error) {
    return { spam: false, source: "error", reason: (error as Error).message.slice(0, 200) };
  }
}

function shownName(from: string): string {
  return from.includes("<") ? from.slice(0, from.indexOf("<")).trim().replace(/^"|"$/g, "") : "";
}

async function pool<T, R>(list: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i]); } }));
  return out;
}

const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}%` : "-");
const rows: string[] = ["| variant | model | spam caught | spam missed | ham to Spam (all) | of them transactional or a customer | newsletters to Spam | precision | errors |", "|---|---|---|---|---|---|---|---|---|"];
const errors: unknown[] = [];
for (const variant of variants) for (const name of models) {
  const model = modelOf(name);
  const verdicts = await pool(items, Number(flag("--concurrency") ?? 3), (item) => judge(variant, model, item));
  let tp = 0, fn = 0, fp = 0, fpCritical = 0, fpBulk = 0, failed = 0;
  const spam = items.filter((i) => i.label === "spam").length;
  const ham = items.filter((i) => i.label === "ham").length;
  const bulk = items.filter((i) => i.label === "ham_bulk").length;
  const critical = items.filter((i) => i.kind === "transactional" || i.kind === "person").length;
  items.forEach((item, i) => {
    const v = verdicts[i];
    if (v.source === "error") failed++;
    if (item.label === "spam") v.spam ? tp++ : fn++;
    else if (v.spam) {
      if (item.label === "ham_bulk") fpBulk++; else fp++;
      if (item.kind === "transactional" || item.kind === "person") fpCritical++;
    }
    if (v.spam !== (item.label === "spam")) errors.push({ variant, model: name, n: item.n, label: item.label, kind: item.kind, to: item.to, sender: item.sender, subject: item.subject.slice(0, 80), predicted: v });
  });
  rows.push(`| ${variant} | ${name} | ${tp}/${spam} (${pct(tp, spam)}) | ${fn} | ${fp}/${ham} (${pct(fp, ham)}) | ${fpCritical}/${critical} | ${fpBulk}/${bulk} | ${pct(tp, tp + fp + fpBulk)} | ${failed} |`);
  console.error(`done: ${variant} ${name}`);
}
console.log(rows.join("\n"));
if (errorsPath) fs.writeFileSync(errorsPath, errors.map((e) => JSON.stringify(e)).join("\n") + "\n");
