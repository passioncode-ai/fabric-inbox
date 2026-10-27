import type { HumanStep, ToolDef } from "./protocol";

/**
 * B-154 step 4 (DEC-0121, AP-1): every action a person can take in Fabric Inbox and the agent tool that takes it,
 * declared in the well-known document under the contract's actions extension
 * (`service-actions-extension.schema.json`). Generated from the tool list, never kept by hand:
 * - a tool that changes something is an action (`none`: the caller's own act, with its confirmation where it is irreversible);
 * - one that always waits for the owner's approval is `relayed` (every caller of this remote server is T2, so the
 *   owner's approval of B-38 is the decision, docs/app-store/tasks/2026-10-26-agent-parity.md);
 * - one that stands for the person's step (consent, a typed secret) is `human`, once per step it can hand over.
 * Reads are not actions. Answering approvals and switching them off stay off the agent surface (NOT_TOOLS).
 */
export const ACTIONS_EXTENSION = "https://fabric.passioncode.ai/agent-contract/extensions/actions/0.1";

export interface ServiceAction { id: string; title: string; tool: string; gate: "none" | "relayed" | "human"; humanStep?: HumanStep }

export function serviceActions(tools: readonly Pick<ToolDef, "name" | "title" | "readOnly" | "ownerApproval" | "humanSteps">[]): ServiceAction[] {
  const out: ServiceAction[] = [];
  for (const t of tools) {
    const title = t.title.slice(0, 80);
    if (t.humanSteps?.length) {
      t.humanSteps.forEach((step, i) => out.push({ id: i === 0 ? t.name : `${t.name}.${step}`, title, tool: t.name, gate: "human", humanStep: step }));
      continue;
    }
    if (t.readOnly) continue;
    out.push({ id: t.name, title, tool: t.name, gate: t.ownerApproval ? "relayed" : "none" });
  }
  return out;
}
