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
  execute(run: Run, email: RuleEmail): Promise<string>;
}
export class ActionRejected extends Error {}
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
  } catch {
    run.status = "failed";
    run.detail =
      msg("Could not read or analyze this message; no action was executed");
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
    run.status = error instanceof ActionRejected ? "failed" : "unknown";
    run.detail =
      error instanceof ActionRejected
        ? error.message
        : msg("Action outcome is uncertain. Check the provider before repeating it.");
  }
  await save();
  return run;
}
