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
