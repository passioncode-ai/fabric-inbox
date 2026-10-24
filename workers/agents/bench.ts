// B-152: a comparison of judge models over one address's sent answers, asked by the support quality
// team. Every model grades the same answers with the production rubric (judge.ts); a stronger model
// with reasoning on grades them too, as the reference. A line carries hashes, marks, cost and time:
// never a word of the mail, an address of a person or a note.
import type { AgentRun } from "./run";
import type { BenchResult } from "./judge";

/** The models the team named on 2026-10-24 (board request judge.bench). */
export const BENCH_MODELS = ["qwen/qwen3.8-flash", "deepseek/deepseek-v4.1-flash", "anthropic/claude-haiku-5.5", "z-ai/glm-5.3-flash",
  "minimax/minimax-m3.1-flash", "xiaomi/mimo-v2.6-pro", "google/gemini-3.8-flash"];
export const BENCH_REFERENCE = "anthropic/claude-opus-5.5";
/** At most this many answers per comparison, newest first; each costs one call per model. */
export const BENCH_RUNS_MAX = 200;
export const BENCH_RUNS_DEFAULT = 60;
/** Calls made by one request: one wave, so a request ends within the reference's timeout. */
export const BENCH_SLICE = 6;

export interface BenchLine {
  turn: string;
  channel: string;
  drafter: string | null;
  prod: { model: string; checks: Record<string, string>; helped: string } | null;
  model: string;
  reference: boolean;
  ok: boolean;
  checks: Record<string, string> | null;
  helped: string | null;
  costUsd: number | null;
  ms: number;
  error?: string;
}

/** The answers a comparison grades: sent, with their text kept, inside the window, newest first. */
export function benchRuns(runs: AgentRun[], since: string, max: number): AgentRun[] {
  return runs.filter((r) => r.status === "sent" && r.sent?.body && !r.redacted && r.createdAt >= since)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, max);
}

/** A run's stable, unlinkable name in the lines: the first 16 hex of SHA-256 over address and run id. */
export async function turnHash(address: string, runId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${address}\n${runId}`));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function benchLine(turn: string, address: string, run: AgentRun, model: string, reference: boolean, result: BenchResult): BenchLine {
  const prod = run.judgement ? { model: run.judgement.model, checks: { ...run.judgement.checks }, helped: run.judgement.helped } : null;
  return { turn, channel: `mail:${address}`, drafter: run.model ?? null, prod, model, reference, ok: result.ok, checks: result.checks,
    helped: result.helped, costUsd: result.costUsd, ms: result.ms, ...(result.error ? { error: result.error } : {}) };
}
