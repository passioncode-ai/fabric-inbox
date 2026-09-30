/** Client types for /api/domains (workers/routes/domains.ts, workers/routing/domains.ts). */
export interface TokenPermission { scope: "Account" | "Zone"; name: string; level: "Read" | "Edit"; for: string }

/** One Cloudflare account the server has a token for (workers/routing/domains.ts AccountView). */
export interface CloudflareAccount {
  id: string;
  name: string;
  /** The account this server runs in. */
  server: boolean;
  /** Reached by the server's own token, or by one saved for this account. */
  via: "server" | "account";
  shown: boolean;
  choice: "shown" | "hidden" | null;
  /** null when it could not be read. */
  hasMail: boolean | null;
  domains: number;
  served: number;
  problem?: string;
  relay: { version: string; installedAt: string } | null;
}

export interface DomainSummary {
  domain: string;
  /** Null when the domain is served here but the token cannot see it. */
  zoneId: string | null;
  /** The Cloudflare account the domain is in; null when no token sees it. */
  account: { id: string; name: string; server: boolean } | null;
  served: boolean;
  /** Set in the deployment's DOMAINS, so it cannot be released from the app. */
  fixed: boolean;
  addresses: number;
}

export interface DomainList {
  connected: boolean;
  problem?: string;
  account?: string | null;
  accounts: CloudflareAccount[];
  /** Tokens or accounts that could not be read; the rest is still true. */
  problems?: string[];
  permissions: TokenPermission[];
  /** What a token for one more account needs. */
  accountPermissions: TokenPermission[];
  tokenUrl: string;
  domains: DomainSummary[];
}

export interface RouteAction { type: "forward" | "worker" | "drop"; value?: string }

export interface DomainDetail {
  domain: string;
  zoneId: string;
  account: { id: string; server: boolean };
  served: boolean;
  fixed: boolean;
  routing: { enabled: boolean; status: string };
  foreignMx: string[];
  rules: { id: string; address: string; enabled: boolean; action: RouteAction; toThisServer: boolean }[];
  catchAll: { enabled: boolean; action: RouteAction; toThisServer: boolean } | null;
  catchAllMailbox: string | null;
  sending: { enabled: boolean };
  dmarc: string | null;
  problems: string[];
}

export type StepOutcome = "done" | "already" | "skipped" | "failed";
export interface Step { id: string; label: string; outcome: StepOutcome; detail: string }
export interface StepsResult { domain: string; steps: Step[]; needsConfirmation?: { foreignMx?: string[]; zoneNotVisible?: boolean } }

export interface Destination { id: string; email: string; verified: string | null; status?: string }
