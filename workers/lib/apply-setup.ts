import type { Env } from "../types";
import type { ApplyResult, Setup } from "../../shared/setup";
import { addServedDomains, createMailbox, readSettings, setCatchAll, settingsKey } from "./mailbox-store";

/**
 * Applies a setup (shared/setup.ts): serves its domains, creates missing
 * mailboxes, updates forwarding and agent on existing ones, sets catch-alls.
 * Idempotent and never deletes. Used by /api/setup/apply and by connecting a
 * domain (workers/routing/domains.ts).
 */
export async function applySetup(env: Env, setup: Setup): Promise<ApplyResult> {
  const domainsAdded = await addServedDomains(env, setup.domains);
  const registry = env.AGENT_REGISTRY?.getByName("workspace");
  const result: ApplyResult = { domainsAdded, catchAllSet: [], mailboxes: [] };
  for (const box of setup.mailboxes) {
    let agentProblem: string | undefined;
    if (box.agent && box.agent !== "off") {
      const exists = registry ? await registry.getAgent(box.agent.id).catch(() => null) : null;
      if (!exists) agentProblem = `agent "${box.agent.id}" does not exist here; left as it was`;
    }
    const forwarding = box.forwardTo ? { enabled: true, email: box.forwardTo } : undefined;
    const current = await readSettings(env.BUCKET, box.address);
    if (!current) {
      const created = await createMailbox(env, box.address, box.name ?? box.address.split("@")[0], {
        agent: agentProblem ? "off" : box.agent ?? "off",
        ...(forwarding ? { forwarding } : {}),
      });
      result.mailboxes.push(created.status === "created"
        ? { address: box.address, outcome: "created", ...(agentProblem ? { reason: agentProblem } : {}) }
        : created.status === "exists"
          ? { address: box.address, outcome: "unchanged" }
          : { address: box.address, outcome: "refused", reason: created.reason });
      continue;
    }
    // An existing mailbox keeps its name and everything the setup does not name.
    const next: Record<string, unknown> = { ...current };
    if (forwarding) next.forwarding = forwarding;
    if (box.agent && !agentProblem) next.agent = box.agent;
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    if (changed) await env.BUCKET.put(settingsKey(box.address), JSON.stringify(next));
    result.mailboxes.push({ address: box.address, outcome: changed ? "updated" : "unchanged", ...(agentProblem ? { reason: agentProblem } : {}) });
  }
  const catchAllReady = setup.catchAll.filter((c) => result.mailboxes.some((m) => m.address === c.mailbox && m.outcome !== "refused"));
  result.catchAllSet = await setCatchAll(env.BUCKET, catchAllReady);
  return result;
}
