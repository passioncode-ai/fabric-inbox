import type { Step } from "../../../services/domains";

/**
 * One sentence for what a domain action did, for the toast and the result line; the step list
 * beside it carries the detail. A failed step says how to continue: running it again picks up
 * where it stopped. Plain module: the tests load it directly.
 */
export function stepsSummary(domain: string, steps: readonly Step[]): string {
  const failed = steps.find((s) => s.outcome === "failed");
  if (failed) return `${domain}: not finished — ${failed.label}. ${failed.detail} Running it again continues from there.`;
  if (!steps.length) return `${domain}: nothing to do.`;
  const done = steps.filter((s) => s.outcome === "done").length;
  return done
    ? `${domain}: done, ${done} step${done === 1 ? "" : "s"} changed.`
    : `${domain}: already so, nothing changed.`;
}

/** A summary that reports a failed step is shown as an error, the rest as a result. */
export const stepsFailed = (steps: readonly Step[]) => steps.some((s) => s.outcome === "failed");
