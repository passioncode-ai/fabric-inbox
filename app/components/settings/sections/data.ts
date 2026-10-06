import { useQuery, type QueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { fabric, type AccountList } from "~/services/fabric";
import type { AgentList, ProjectAddresses, RoutingStatus } from "~/services/agents";
import type { Destination, DomainList, Step } from "~/services/domains";
import type { InboxAccount } from "~/components/inbox/model";

/** The server answers the Settings sections read, under one key each, shared across sections. */
export const DOMAINS_KEY = ["domains"];
export const ADDRESSES_KEY = ["project-addresses"];
export const AGENTS_KEY = ["agents"];
export const DESTINATIONS_KEY = ["domain-destinations"];
export const GMAIL_KEY = ["fabric-accounts"];
export const INBOX_ACCOUNTS_KEY = ["settings-inbox-accounts"];
export const detailKey = (domain: string) => ["domain", domain];
export const routingKey = (email: string) => ["routing", email];

export const useDomains = () => useQuery({ queryKey: DOMAINS_KEY, queryFn: () => fabric<DomainList>("/api/domains") });
export const useAddresses = () => useQuery({ queryKey: ADDRESSES_KEY, queryFn: () => fabric<ProjectAddresses>("/api/project-addresses") });
export const useAgents = () => useQuery({ queryKey: AGENTS_KEY, queryFn: () => fabric<AgentList>("/api/agents") });

/** Unread counts and connection state per inbox; a failure only hides the counts. */
export const useInboxAccounts = () => useQuery({
  queryKey: INBOX_ACCOUNTS_KEY, staleTime: 60_000,
  queryFn: () => fabric<{ accounts: InboxAccount[] }>("/api/inbox?limit=1").then((r) => r.accounts),
});

export const useGmailAccounts = () => useQuery({
  queryKey: GMAIL_KEY,
  queryFn: () => fabric<AccountList>("/api/accounts"),
  // Polled only while an account is still on its first sync.
  refetchInterval: (query) => (query.state.data?.accounts.some((a) => a.status === "syncing" || !a.lastSyncAt) ? 15_000 : false),
});

/** One address's routing as last read; `enabled` false only reads what is already known. */
export const useRouting = (email: string, enabled: boolean) => useQuery({
  queryKey: routingKey(email), enabled, staleTime: 60_000,
  queryFn: () => fabric<RoutingStatus>(`/api/project-addresses/${encodeURIComponent(email)}/routing`),
});

/** The destinations of one Cloudflare account; the server's own when none is named. */
export const useDestinations = (enabled: boolean, account?: string) => useQuery({
  queryKey: [...DESTINATIONS_KEY, account ?? "server"], enabled, staleTime: 60_000,
  queryFn: () => fabric<{ destinations: Destination[] }>(`/api/domains/destinations${account ? `?account=${account}` : ""}`).then((r) => r.destinations),
});

/**
 * After a change to addresses or domains, everything it can touch is read again, including each
 * address's routing and the inbox list. A failed action may still have changed something, so this
 * runs after failures too.
 */
export async function refreshMail(client: QueryClient, domain?: string) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ADDRESSES_KEY }), client.invalidateQueries({ queryKey: DOMAINS_KEY }),
    client.invalidateQueries({ queryKey: ["routing"] }), client.invalidateQueries({ queryKey: ["unified-inbox"] }),
    client.invalidateQueries({ queryKey: INBOX_ACCOUNTS_KEY }),
    ...(domain ? [client.invalidateQueries({ queryKey: detailKey(domain) })] : []),
  ]);
}

/**
 * The steps of the last action on each domain, kept above the panels: a domain that starts or
 * stops receiving here keeps its step list when its panel is closed and opened again.
 */
export const StepMemory = createContext<{ get(domain: string): Step[]; set(domain: string, steps: Step[]): void } | null>(null);
export const useStepMemory = () => useContext(StepMemory);

/** "Off", the agent's name, or what an address still carries from an older version. */
export function answererText(agent: ProjectAddresses["addresses"][number]["agent"], agentName: string | null, agents?: AgentList): string {
  if (agent === "off") return "Off — you read it";
  if (agent === "legacy") return "Drafts with its old prompt";
  return agentName ?? agents?.agents.find((a) => a.id === agent.id)?.name ?? "A deleted agent (Off)";
}

export const ROUTING_TEXT: Record<RoutingStatus["state"], string> = {
  verified: "Arriving here",
  missing: "Not arriving here",
  unknown: "Routing unknown",
};
