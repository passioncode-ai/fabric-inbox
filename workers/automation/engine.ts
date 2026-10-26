import {
  matchesRule,
  emailDigest,
  toolArguments,
  type Analysis,
  type Rule,
  type RuleEmail,
  type Run,
} from "./policy";
import { msg } from "../../shared/i18n";
export interface RunDependencies {
  save(run: Run): Promise<void>;
  start(run: Run): Promise<boolean>;
  currentRule(id: string): Promise<Rule | undefined>;
  email(id: string): Promise<RuleEmail>;
  analyze(rule: Rule, email: RuleEmail): Promise<Analysis>;
  /**
   * B-05: takes one action from the rule's daily limit, false when today's is used up. Called once a
   * run's every condition (the AI condition included) matched, so a message the AI condition turns
   * away costs nothing. Only a run stored with `counted: false` is asked, and once: a run stored before
   * B-05 took its count when it was queued.
   */
  claimDaily(run: Run): Promise<boolean>;
  execute(run: Run, email: RuleEmail): Promise<string>;
  /**
   * B-178: where the run's message stands with the arrival safety check: `pending` until it is checked, `held`
   * until a person releases it, else `clear`. Absent: no check here.
   */
  safety?(run: Run): Promise<"pending" | "held" | "kept" | "clear">;
  /**
   * A-6: writes the run only while it is still pending in storage (in one transaction), so a run dismissed while
   * this one awaited another object is never written back as pending. False: it changed meanwhile, leave it.
   */
  saveIfPending?(run: Run): Promise<boolean>;
}

/** B-178: a rule waits this long for a message's safety check, then acts as before (the check never came). */
export const SAFETY_WAIT_MS = 15 * 60_000;
/** B-178: a rule waits this long for a held message to be released, then gives it up. */
export const HELD_WAIT_MS = 7 * 86_400_000;
export class ActionRejected extends Error {}
/**
 * B-15: what an account refuses before anything is handed over or changed. The accounts object's
 * errors cross RPC as their message (the code), not their class, so the code is matched; anything
 * else (a lost connection, a provider outage) stays an uncertain outcome.
 */
const KNOWN_REFUSALS = new Set(["send_rate_limited", "message_not_found", "not_supported", "account_not_found", "invalid_message",
  "invalid_address", "invalid_attachment", "invalid_header", "message_too_large", "sender_mismatch", "idempotency_conflict",
  "recipient_rejected", "sender_rejected", "message_rejected", "smtputf8_unsupported",
  // Gmail's own refusals: nothing was sent or changed (B-15 (3)).
  "gmail_api_disabled", "insufficient_scope", "reconnect_required", "rate_limited", "provider_auth_failed"]);
export async function refusalsKnown<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    const code = (error as Error)?.message ?? "";
    if (KNOWN_REFUSALS.has(code)) throw new ActionRejected(msg("The account refused it ({code}); nothing was done", { code }));
    throw error;
  }
}
/**
 * B-141: reading or analysing a message (the AI condition) is tried this many times, ANALYSIS_RETRY_MS[n]
 * apart, before the run fails; nothing was executed, so trying again is safe.
 */
export const MAX_ANALYSIS_ATTEMPTS = 3;
export const ANALYSIS_RETRY_MS = [60_000, 5 * 60_000];
/** Persist running before crossing any effect boundary. Interrupted runs are never replayed blindly. */
export async function processRun(
  run: Run,
  deps: RunDependencies,
): Promise<Run> {
  if (run.status !== "pending") return run;
  const save = async () => {
    run.updatedAt = new Date().toISOString();
    await deps.save(run);
  };
  const current = await deps.currentRule(run.rule.id);
  if (!current?.enabled || current.version !== run.rule.version) {
    run.status = "cancelled";
    run.detail = msg("Rule paused or changed");
    await save();
    return run;
  }
  // B-178: a rule never reads or acts on a message held from agents; it waits for the check, then for a release.
  if (deps.safety) {
    const state = await deps.safety(run).catch(() => "pending" as const);
    const age = Date.now() - (Date.parse(run.createdAt) || Date.now());
    // The safety call awaited another object: a dismiss in the meantime wins (A-6).
    const saveWaiting = async () => {
      run.updatedAt = new Date().toISOString();
      if (deps.saveIfPending) return deps.saveIfPending(run);
      await deps.save(run);
      return true;
    };
    // A person kept it held (A-11): the rule gives up now, not after seven days of looking.
    if (state === "kept" || (state === "held" && age >= HELD_WAIT_MS)) {
      run.status = "skipped";
      run.detail = state === "kept" ? msg("Kept held by a person after the safety check") : msg("Held for review by the safety check and never released");
      delete run.retryAt;
      await saveWaiting();
      return run;
    }
    if (state === "held" || (state === "pending" && age < SAFETY_WAIT_MS)) {
      run.retryAt = new Date(Date.now() + (state === "held" ? 10 * 60_000 : 60_000)).toISOString();
      run.detail = state === "held" ? msg("Held for review by the safety check") : msg("Waiting for the safety check");
      await saveWaiting();
      return run;
    }
  }
  run.attempts = (run.attempts ?? 0) + 1;
  if (!(await deps.start(run))) return run;
  run.status = "running";
  let email: RuleEmail;
  try {
    email = await deps.email(run.emailId);
    if (!matchesRule(current, email)) {
      run.status = "skipped";
      run.detail = msg("Conditions did not match");
      await save();
      return run;
    }
    const digest = await emailDigest(email);
    if (run.proposal && run.proposal.emailDigest !== digest) {
      run.status = "cancelled";
      run.detail = msg("Message changed after the action was prepared");
      await save();
      return run;
    }
    if (!run.proposal)
      run.proposal = {
        emailDigest: digest,
        action:
          current.action.type === "mcp"
            ? {
                ...current.action,
                arguments: toolArguments(current.action.arguments, email),
              }
            : structuredClone(current.action),
      };
    if (!run.analysis) run.analysis = await deps.analyze(current, email);
    if (!run.analysis.matches) {
      run.status = "skipped";
      run.detail = msg("AI condition did not match");
      await save();
      return run;
    }
    if (run.counted === false) {
      if (!(await deps.claimDaily(run))) {
        run.status = "skipped";
        run.detail = msg("Daily rule limit reached");
        await save();
        return run;
      }
      run.counted = true;
    }
    if (current.mode === "approval" && !run.approved) {
      run.status = "waiting_approval";
      await save();
      return run;
    }
    if (current.action.type === "mcp" && current.action.location === "device") {
      run.status = "waiting_device";
      run.detail = msg("Local tool runner is not connected");
      await save();
      return run;
    }
  } catch (error) {
    const attempts = run.attempts ?? 1;
    const retry = attempts < MAX_ANALYSIS_ATTEMPTS;
    // Codes and the error's own words, never the message or its analysis.
    console.warn(JSON.stringify({ event: "automation_analysis_failed", rule: run.rule.id, version: run.rule.version, attempt: attempts, retry,
      error: String(error instanceof Error ? error.message : error).slice(0, 200) }));
    if (retry) {
      run.status = "pending";
      run.retryAt = new Date(Date.now() + ANALYSIS_RETRY_MS[Math.min(attempts, ANALYSIS_RETRY_MS.length) - 1]!).toISOString();
      run.detail = msg("Could not read or analyze this message (attempt {attempt} of {max}); it is tried again", { attempt: attempts, max: MAX_ANALYSIS_ATTEMPTS });
    } else {
      run.status = "failed";
      delete run.retryAt;
      run.detail = msg("Could not read or analyze this message after {max} attempts; no action was executed", { max: MAX_ANALYSIS_ATTEMPTS });
    }
    await save();
    return run;
  }
  // Pause/permission changes can arrive while the model is running. Revalidate immediately before effect.
  const latest = await deps.currentRule(run.rule.id);
  if (!latest?.enabled || latest.version !== run.rule.version) {
    run.status = "cancelled";
    run.detail = msg("Rule paused or changed");
    await save();
    return run;
  }
  try {
    run.detail = await deps.execute(run, email);
    run.status = "succeeded";
  } catch (error) {
    // The reason stays in the log (codes and the error's own words, never arguments or tokens):
    // without it an uncertain run gave no clue why (2026-10-10: every tool call failed silently).
    console.error(JSON.stringify({ event: "automation_action_failed", rule: run.rule.id, version: run.rule.version,
      action: run.rule.action.type, refused: error instanceof ActionRejected, error: String(error instanceof Error ? error.message : error).slice(0, 200) }));
    run.status = error instanceof ActionRejected ? "failed" : "unknown";
    run.detail =
      error instanceof ActionRejected
        ? error.message
        : msg("Action outcome is uncertain. Check the provider before repeating it.");
  }
  await save();
  return run;
}
