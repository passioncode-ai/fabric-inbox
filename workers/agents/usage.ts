/**
 * B-147: one receipt per model call, from the numbers the provider returned (fabric-service usage,
 * DEC-0021): the tokens the AI SDK reports and OpenRouter's own charge (usage accounting). A cost the
 * provider did not report is null, never 0; a call whose tokens were not reported is unmeasured.
 * A receipt names no prompt, answer, sender or address.
 */
export interface UsageReceipt {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD as the provider charged it, or null when it reported none (Workers AI, a failed call). */
  costUsd: number | null;
  /** False when the provider gave no token count (a failed or aborted call). */
  measured: boolean;
  /** B-163: which part of the run made the call; absent on receipts written before 0.71.0. */
  role?: "writer" | "checker";
}

/** B-163: what a set of calls used: tokens summed, cost summed only when every call reported one (else null). */
export interface Spent {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** USD the provider charged for every call here, or null when one or more reported no charge. */
  costUsd: number | null;
  /** False when one or more calls reported no token count, so the tokens are a lower bound. */
  measured: boolean;
}

/** B-163: a run's spend, the writer and the checker apart; null parts made no call. */
export interface RunSpent { writer: Spent | null; checker: Spent | null; total: Spent }

/** Tags each receipt with the part of the run that made it. */
export const asRole = (receipts: UsageReceipt[], role: "writer" | "checker"): UsageReceipt[] => receipts.map((r) => ({ ...r, role }));

/** Sums receipts; an empty list is null. */
export function sumReceipts(receipts: UsageReceipt[]): Spent | null {
  if (!receipts.length) return null;
  const priced = receipts.every((r) => r.costUsd !== null);
  return {
    calls: receipts.length,
    inputTokens: receipts.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: receipts.reduce((a, r) => a + r.outputTokens, 0),
    costUsd: priced ? Number(receipts.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(8)) : null,
    measured: receipts.every((r) => r.measured),
  };
}

/**
 * B-163: a run's spend from its receipts. A receipt written before roles were recorded is the checker's
 * when its model is the run's checker, else the writer's (the checker is always of another vendor).
 * A run that made model calls but holds no receipts (before 0.29.0) spent an unknown amount: null.
 */
export function runSpent(run: { usage?: UsageReceipt[]; checkedBy?: string; modelCalls?: { calls: number } }): RunSpent | null {
  const receipts = run.usage ?? [];
  if (!receipts.length) return null;
  const roleOf = (r: UsageReceipt) => r.role ?? (run.checkedBy && r.model === run.checkedBy ? "checker" : "writer");
  return {
    writer: sumReceipts(receipts.filter((r) => roleOf(r) === "writer")),
    checker: sumReceipts(receipts.filter((r) => roleOf(r) === "checker")),
    total: sumReceipts(receipts)!,
  };
}

/** At most this many receipts on one run (writer, fallback, final turn, checkers). */
export const MAX_RECEIPTS = 8;

interface StepLike { usage?: { inputTokens?: number; outputTokens?: number }; providerMetadata?: Record<string, unknown> }
interface ResultLike extends StepLike { totalUsage?: { inputTokens?: number; outputTokens?: number }; steps?: StepLike[] }

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);

/** OpenRouter's charge for one step (providerMetadata.openrouter.usage.cost), or null. */
function costOf(step: StepLike): number | null {
  const meta = step.providerMetadata?.openrouter as { usage?: { cost?: unknown } } | undefined;
  const cost = meta?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** A receipt from a finished generateText result: tokens over every step, cost summed when every step reported one. */
export function receiptOf(model: string, result: ResultLike): UsageReceipt {
  const total = result.totalUsage ?? result.usage;
  const input = count(total?.inputTokens);
  const output = count(total?.outputTokens);
  const steps = result.steps?.length ? result.steps : [result];
  const costs = steps.map(costOf);
  const costUsd = costs.every((c) => c !== null) ? Number(costs.reduce((a, b) => a! + b!, 0)!.toFixed(8)) : null;
  return { model: model.slice(0, 128), inputTokens: input ?? 0, outputTokens: output ?? 0, costUsd, measured: input !== null && output !== null };
}

/** A call that failed before it answered: it happened, but nothing about it was reported. */
export const unmeasured = (model: string): UsageReceipt => ({ model: model.slice(0, 128), inputTokens: 0, outputTokens: 0, costUsd: null, measured: false });
