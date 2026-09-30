// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	/** When non-empty, the only addresses that may have a mailbox (JSON array var). */
	EMAIL_ADDRESSES?: string[];
	/** JSON map of domain → "reject" | "catch_all:<address>"; unknown domains reject. */
	UNKNOWN_ADDRESS_POLICY?: string;
	AUTOMATION_MCP_HOSTS?: string;
	AUTOMATION_TOOL_TOKENS?: string;
	AUTOMATION_MODEL?: string;
	/** Workers AI model that sorts mail into described categories; defaults to AUTOMATION_MODEL, then llama-4-scout. */
	CATEGORY_MODEL?: string;
	/** Model calls per UTC day for categories (one per message); default 500. Beyond it messages wait for the next day. */
	CATEGORY_DAILY_LIMIT?: string;
	/** Messages the spam model reads per UTC day (SP-2); default 300. Beyond it new mail is not judged by the model. */
	SPAM_DAILY_LIMIT?: string;
	/** Workers AI model for address agents and the chat; defaults to @cf/moonshotai/kimi-k2.5. */
	AGENT_MODEL?: string;
	/** Cloudflare API token for Domains & addresses (secret); permissions in workers/routing/cloudflare-api.ts. */
	CLOUDFLARE_API_TOKEN?: string;
	/** Before 0.3: the same token under its old name; read when CLOUDFLARE_API_TOKEN is absent. */
	CLOUDFLARE_EMAIL_ROUTING_TOKEN?: string;
	/** The account the token manages; optional when every zone it sees is in one account. */
	CLOUDFLARE_ACCOUNT_ID?: string;
	/** The Worker that Email Routing rules point at; defaults to "fabric-inbox". */
	EMAIL_ROUTING_WORKER?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GMAIL_TOKEN_ENCRYPTION_KEY?: string;
	PUBLIC_APP_URL?: string;
	GMAIL_POLL_SECONDS?: string;
	/** Set on the Worker, not in wrangler.jsonc (CF-4): the Access application audience. */
	POLICY_AUD: string;
	/** Set on the Worker: https://<team>.cloudflareaccess.com */
	TEAM_DOMAIN: string;
	/** Set on the Worker: domains always served, commas and/or spaces; more live in R2 config/domains.json. */
	DOMAINS?: string;
}
