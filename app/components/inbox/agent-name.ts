import { useQuery } from "@tanstack/react-query";
import { fabric } from "~/services/fabric";
import { useMe } from "~/lib/me";

/** The query that reads a reply agent's name (`GET /api/agents/:id`), shared by the card, the sent cell and the run panel. */
export const agentNameKey = (agentId: string | undefined) => ["agent-name", agentId] as const;

/** What a person reads for an agent: its name, else its id (a member, a removed agent, a read that failed). */
export const agentLabel = (agentId: string | undefined, name: string | undefined) => (name?.trim() ? name.trim() : agentId);

/**
 * S06, A-26: a reply agent by the name its settings give it, wherever the mail window names it (the draft card, the
 * sent cell, the run panel): read once and kept for five minutes, falling back to its id. A member is never asked for
 * it (agents are an administrator's, `workers/lib/member-gate.ts`), so a member reads the id.
 */
export function useAgentName(agentId: string | undefined): string | undefined {
  const me = useMe();
  const member = me.data?.role === "member";
  const named = useQuery({
    queryKey: agentNameKey(agentId), enabled: !!agentId && !member && !me.isPending, staleTime: 300_000, retry: false,
    queryFn: () => fabric<{ name?: string }>(`/api/agents/${encodeURIComponent(agentId!)}`),
  });
  return agentLabel(agentId, member ? undefined : named.data?.name);
}
