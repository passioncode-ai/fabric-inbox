/** Client view of /api/agents, /api/agent-runs and /api/project-addresses (workers/routes/agents.ts). */
import { englishT, type T } from "../../shared/i18n";

export type ReplyMode = "draft" | "auto";
export interface ToolGrant {
  name: string;
  description: string;
  endpoint: string;
  tool: string;
  tokenRef?: string;
}
export interface AgentInput {
  name: string;
  instructions: string;
  knowledge: string;
  /** Knowledge collections the agent may search (KN-3). */
  collections: string[];
  tools: ToolGrant[];
  replyPolicy: { mode: ReplyMode; allowedIntents: string[]; dailySendLimit: number };
}
export interface Agent extends AgentInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt?: string;
  addresses?: string[];
}
export interface AgentList {
  agents: Agent[];
  templates: Record<string, AgentInput>;
  toolHosts: string[];
}
export type Assignment = { id: string } | "off";
export interface ProjectAddress {
  email: string;
  domain: string;
  name: string;
  agent: Assignment | "legacy";
  agentName: string | null;
  /** Where a copy of each message is forwarded, if anywhere. */
  forwardTo: string | null;
  /** The last forwarding failure, cleared by the next successful forward. */
  deliveryIssue: { target: string; problem: string; count: number; lastAt: string } | null;
}
export interface ProjectAddresses {
  domains: { domain: string; unknownAddressPolicy: string;
    /** The catch-all in effect: the deployment's UNKNOWN_ADDRESS_POLICY wins over the stored choice. */
    catchAll?: { mailbox: string; source: "deployment" | "stored" } | null }[];
  routingConfigured: boolean;
  addresses: ProjectAddress[];
  unknownRecipients: { address: string; domain: string; action: string; count: number; lastSeen: string }[];
}
export interface RoutingStatus {
  state: "verified" | "missing" | "unknown";
  detail: string;
  via?: "rule" | "catch_all";
  /** The problem is the domain's, not the address's rule: Email Routing is off or its records need fixing. */
  domainProblem?: boolean;
}

/** GET /api/project-addresses/check (workers/lib/address-ops.ts checkAddresses, SCN-061). */
export type DomainState = "receiving" | "can_receive" | "needs_fix" | "no_token" | "not_visible" | "unknown" | "unavailable";
export interface NameCheck {
  localPart: string;
  email: string;
  status: "available" | "exists" | "elsewhere" | "invalid" | "restricted";
  detail: string;
  notes: string[];
}
export interface AddressCheck {
  domain: string;
  served: boolean;
  state: DomainState;
  detail: string;
  rule: { canMake: boolean; detail: string };
  sendTestDefault: boolean;
  catchAll: { mailbox: string; source: "deployment" | "stored" } | null;
  names: NameCheck[];
}
export interface StepFix { action: "route_here" | "connect_cloudflare" | "connect_account" | "open_domain"; label: string }
/** One line of what creating an address did (SCN-062). */
export interface AddressStep {
  id: "address" | "rule";
  label: string;
  /** not_receiving: the rule exists but the domain does not route mail here yet (Email Routing off or broken). */
  outcome: "done" | "already" | "skipped" | "failed" | "not_receiving";
  detail: string;
  fix?: StepFix;
}
export interface CreatedAddress { email: string; routing: RoutingStatus | null; steps: AddressStep[]; warning?: string }
export interface BatchResult {
  domain: string;
  created: number;
  failed: number;
  results: ({ email: string; status: number; error?: string } & Partial<CreatedAddress>)[];
  /** The names one request did not start (its Cloudflare budget ran out): send them again to continue. */
  remaining?: string[];
  complete?: boolean;
  note?: string;
}
/** GET /api/project-addresses/:email/test (SCN-062). */
export interface TestStatus {
  subject: string;
  sentAt: string;
  sendStatus: string;
  state: "waiting" | "arrived" | "not_arrived" | "failed";
  detail: string;
  arrivedAt?: string;
  folder?: string;
}
export type AgentRunStatus = "running" | "off" | "skipped" | "drafted" | "sent" | "send_failed" | "send_unknown" | "failed" | "interrupted";
export interface AgentRun {
  id: string;
  mailboxId: string;
  emailId: string;
  sender: string;
  subject: string;
  agentId?: string;
  agentVersion?: number;
  status: AgentRunStatus;
  reason: string;
  intent?: string;
  toolCalls: { name: string; host: string; ok: boolean; ms: number; result: string }[];
  /** Knowledge passages the model was given (KN-4). */
  sources?: { ref: string; collectionId: string; title: string; sourceUri: string }[];
  draftId?: string;
  sent?: { to: string; subject: string; body: string; outboxId: string };
  createdAt: string;
}

/**
 * One word per state, in the product's terms: "Sent" only after the provider accepted. A run's
 * "Sent" is a state, not the Sent folder, hence the context in its key.
 */
export function runStatusText(t: T = englishT): Record<AgentRunStatus, string> {
  return {
    running: t("Working"),
    off: t("Off"),
    skipped: t("Skipped"),
    drafted: t("Draft waiting"),
    sent: t("[run] Sent"),
    send_failed: t("Not sent"),
    send_unknown: t("Outcome unknown"),
    failed: t("Failed"),
    interrupted: t("Interrupted"),
  };
}

export function blankAgent(): AgentInput {
  return { name: "", instructions: "", knowledge: "", collections: [], tools: [], replyPolicy: { mode: "draft", allowedIntents: [], dailySendLimit: 20 } };
}
