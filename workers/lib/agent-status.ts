/**
 * B-138 (operator, 2026-10-21): the reply status of conversations on addresses with a reply agent
 * (who answered last, or why nobody did) on the list, in a filter and for agents. Shown per address
 * as the person chooses: the address's choice, else its domain's, else the workspace's; off until
 * someone turns it on. One R2 object holds the choices, written on its etag so two changes never
 * lose one.
 */
import type { Env } from "../types";
import type { InboxMessage } from "../../shared/mail/inbox";
import { agentState, agentStatusOn, DEFAULT_AGENT_STATUS, type AgentState, type AgentStatusSettings, type ThreadFacts } from "../../shared/mail/agent-state";
import { bodyForUpdate } from "./r2-json";
import { readAllSettings } from "./mailbox-store";
import { runIdFor, type AgentRun } from "../agents/run";

export const AGENT_STATUS_KEY = "config/agent-status.json";
const ADDRESS = /^[^\s@]{1,64}@[a-z0-9.-]{1,253}$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;

function normalise(value: unknown): AgentStatusSettings {
  const v = (value ?? {}) as Partial<AgentStatusSettings>;
  const pick = (o: unknown, ok: RegExp) => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {})
    .filter(([k, b]) => typeof b === "boolean" && ok.test(k.toLowerCase())).map(([k, b]) => [k.toLowerCase(), b as boolean]).slice(0, 5000));
  return { enabled: v.enabled === true, domains: pick(v.domains, DOMAIN), addresses: pick(v.addresses, ADDRESS) };
}

export async function readAgentStatus(bucket: R2Bucket): Promise<AgentStatusSettings> {
  const object = await bucket.get(AGENT_STATUS_KEY);
  return object ? normalise(await object.json().catch(() => null)) : { ...DEFAULT_AGENT_STATUS, domains: {}, addresses: {} };
}

export class AgentStatusConflict extends Error {}
export class AgentStatusInvalid extends Error {}

/** A change: `enabled` for the workspace; a domain or an address set on or off, or null to follow the level above. */
export interface AgentStatusChange { enabled?: boolean; domains?: Record<string, boolean | null>; addresses?: Record<string, boolean | null> }

export async function changeAgentStatus(bucket: R2Bucket, change: AgentStatusChange): Promise<AgentStatusSettings> {
  const check = (o: Record<string, boolean | null> | undefined, ok: RegExp, what: string) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (!ok.test(k.toLowerCase())) throw new AgentStatusInvalid(`Not ${what}: ${k.slice(0, 80)}`);
      if (v !== null && typeof v !== "boolean") throw new AgentStatusInvalid(`${k.slice(0, 80)}: on, off or null`);
    }
  };
  check(change.domains, DOMAIN, "a domain");
  check(change.addresses, ADDRESS, "an address");
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(AGENT_STATUS_KEY);
    const next = object ? normalise(await bodyForUpdate(object)) : normalise(null);
    if (typeof change.enabled === "boolean") next.enabled = change.enabled;
    for (const [level, values] of [["domains", change.domains], ["addresses", change.addresses]] as const) {
      for (const [k, v] of Object.entries(values ?? {})) {
        if (v === null) delete next[level][k.toLowerCase()]; else next[level][k.toLowerCase()] = v;
      }
    }
    const written = await bucket.put(AGENT_STATUS_KEY, JSON.stringify(next), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return next;
  }
  throw new AgentStatusConflict("The reply status settings changed several times at once; try again");
}

type RunsByIds = (ids: string[]) => Promise<AgentRun[]>;
const box = (env: Env, address: string) => env.MAILBOX.get(env.MAILBOX.idFromName(address));

/** Each conversation's state from its facts and the run on its last message that came in. */
async function statesOf(address: string, facts: ThreadFacts[], runsByIds: RunsByIds | null): Promise<Map<string, { state: AgentState; facts: ThreadFacts }>> {
  const inbound = facts.filter((f) => f.lastInbound);
  const ids = await Promise.all(inbound.map((f) => runIdFor(address, f.lastInbound!.id)));
  // No registry, or one that cannot answer: states are read without the agent's run (never a guess at it).
  const runs = runsByIds && ids.length ? await runsByIds(ids).catch(() => [] as AgentRun[]) : [];
  const byId = new Map(runs.map((r) => [r.id, r.status]));
  const out = new Map<string, { state: AgentState; facts: ThreadFacts }>();
  inbound.forEach((f, i) => {
    const state = agentState(f, byId.get(ids[i]!));
    if (state) out.set(f.threadId, { state, facts: f });
  });
  return out;
}

const registryOf = (env: Env): RunsByIds | null => (env.AGENT_REGISTRY ? (ids) => env.AGENT_REGISTRY.getByName("workspace").runsByIds(ids) : null);

/**
 * Marks each Cloudflare message on a page of the feed with its conversation's state, for the
 * addresses where the status is on. A mailbox or setting that cannot be read leaves its messages
 * unmarked; the feed itself never fails for it.
 */
export async function attachAgentStates(env: Env, page: InboxMessage[]): Promise<void> {
  const cloudflare = page.filter((m) => m.accountId.startsWith("cloudflare:"));
  if (!cloudflare.length) return;
  const settings = await readAgentStatus(env.BUCKET).catch(() => null);
  if (!settings) return;
  const byAddress = new Map<string, InboxMessage[]>();
  for (const m of cloudflare) {
    const address = m.accountId.slice("cloudflare:".length);
    if (agentStatusOn(settings, address)) byAddress.set(address, [...(byAddress.get(address) ?? []), m]);
  }
  await Promise.all([...byAddress.entries()].map(async ([address, messages]) => {
    try {
      const keys = [...new Set(messages.map((m) => m.threadId || m.providerMessageId))];
      const states = await statesOf(address, await box(env, address).agentThreads({ threadIds: keys }), registryOf(env));
      for (const m of messages) {
        const found = states.get(m.threadId || m.providerMessageId);
        if (found) m.agentState = found.state;
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "agent_state_unreadable", error: (error as Error)?.message?.slice(0, 200) }));
    }
  }));
}

export interface AgentThreadsAnswer {
  messages: InboxMessage[];
  /** Conversations per state across the addresses looked at, before the `states` filter. */
  counts: Partial<Record<AgentState, number>>;
  addresses: string[];
  issues: { accountId: string; error: string }[];
}

/**
 * The conversations of the addresses where the status is on (or the one named), each as its last
 * message that came in with its state, newest first; `states` keeps only those. Each address looks at
 * its `perAddress` most recent conversations.
 */
export async function listAgentThreads(env: Env, options: { states?: AgentState[]; address?: string; limit?: number; perAddress?: number; ownDomains?: string[] } = {}): Promise<AgentThreadsAnswer> {
  const settings = await readAgentStatus(env.BUCKET);
  const all = (await readAllSettings(env.BUCKET)).map(({ email }) => email.toLowerCase());
  const named = options.address?.trim().toLowerCase();
  const addresses = named ? all.filter((a) => a === named) : all.filter((a) => agentStatusOn(settings, a));
  const limit = Math.min(200, Math.max(1, options.limit ?? 100));
  const wanted = options.states?.length ? new Set(options.states) : null;
  const counts: Partial<Record<AgentState, number>> = {};
  const issues: AgentThreadsAnswer["issues"] = [];
  const messages: InboxMessage[] = [];
  await Promise.all(addresses.map(async (address) => {
    try {
      const facts = await box(env, address).agentThreads({ limit: options.perAddress ?? 200 });
      const states = await statesOf(address, facts, registryOf(env));
      const keep = new Map<string, AgentState>();
      for (const { state, facts: f } of states.values()) {
        counts[state] = (counts[state] ?? 0) + 1;
        if (!wanted || wanted.has(state)) keep.set(f.lastInbound!.id, state);
      }
      if (!keep.size) return;
      const found = await box(env, address).inboxMessagesByIds(address, [...keep.keys()].slice(0, 100), options.ownDomains ?? []);
      for (const m of found as InboxMessage[]) messages.push({ ...m, agentState: keep.get(m.providerMessageId) });
    } catch (error) {
      issues.push({ accountId: `cloudflare:${address}`, error: (error as Error)?.message?.slice(0, 200) || "unreadable" });
    }
  }));
  messages.sort((a, b) => (b.timestamp ?? Date.parse(b.date)) - (a.timestamp ?? Date.parse(a.date)));
  return { messages: messages.slice(0, limit), counts, addresses, issues };
}
