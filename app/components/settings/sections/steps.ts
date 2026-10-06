import type { Step } from "../../../services/domains";
import { englishT, type T } from "../../../../shared/i18n";

/**
 * One sentence for what a domain action did, for the toast and the result line; the step list
 * beside it carries the detail. A failed step says how to continue: running it again picks up
 * where it stopped. In the language of `t` (English by default, so a sentence thrown as an error
 * is still found by `t.text()`); the step's own words come from the server. Plain module: the
 * tests load it directly.
 */
export function stepsSummary(domain: string, steps: readonly Step[], t: T = englishT): string {
  const failed = steps.find((s) => s.outcome === "failed");
  if (failed) {
    return t("{domain}: not finished — {step}. {detail} Running it again continues from there.",
      { domain, step: t.text(failed.label), detail: t.text(failed.detail) });
  }
  if (!steps.length) return t("{domain}: nothing to do.", { domain });
  const done = steps.filter((s) => s.outcome === "done").length;
  return done
    ? t.plural(done, { one: "{domain}: done, {n} step changed.", other: "{domain}: done, {n} steps changed." }, { domain })
    : t("{domain}: already so, nothing changed.", { domain });
}

/** A summary that reports a failed step is shown as an error, the rest as a result. */
export const stepsFailed = (steps: readonly Step[]) => steps.some((s) => s.outcome === "failed");
