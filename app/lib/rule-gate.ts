import type { Rule } from "../../workers/automation/policy";

/** What a test run reviews: the whole rule but its saved version and whether it is on. */
export function ruleReviewKey(rule: Rule): string {
  return JSON.stringify({ ...rule, version: 0, enabled: false });
}

/**
 * The turn-on gate (FLW-05, kept by S10): a new or edited rule can be turned on only after a test
 * run of exactly its current values. A rule already on and saved unchanged needs none, and nothing
 * gates a pause. `tested` holds every value a test run on this screen succeeded for, so going back
 * to values already tried unlocks it again, as the server's receipt does (B-67, 24 hours).
 * `currentKey` is null when the values cannot be read (bad tool arguments): then it stays locked.
 */
export function enableLocked(
  currentKey: string | null,
  saved: { key: string; enabled: boolean } | null,
  tested: ReadonlySet<string>,
): boolean {
  if (currentKey === null) return true;
  if (saved?.enabled && saved.key === currentKey) return false;
  return !tested.has(currentKey);
}

/**
 * What the On switch of a paused rule's card does: turn it on when its current values were
 * test-run on this screen, else open the editor at its Test run step (S10). The server keeps the
 * same gate; a refusal from it opens the Test run step too.
 */
export function switchOnStep(rule: Rule, tested: ReadonlySet<string>): "turn-on" | "test-run" {
  return tested.has(ruleReviewKey(rule)) ? "turn-on" : "test-run";
}
