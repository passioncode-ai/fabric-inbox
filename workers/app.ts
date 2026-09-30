// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { withSecurityHeaders } from "./lib/security-headers";
import { handleIncomingEmail } from "./index";
import { api } from "./api";
import { handleMcp } from "./mcp/handler";
import { handleRelayForwarded, handleRelayIncoming, RELAY_FORWARDED, RELAY_INCOMING } from "./relay/ingress";
import { identityMayUse, MCP_PATH, type AccessClaims } from "./mcp/keys";
export { AutomationDO } from "./automation";
export { GmailAccountsDO } from "./providers/accounts-do";
export { AgentRegistryDO } from "./agents/registry";
export { KnowledgeDO } from "./knowledge/store";
export { CategoriesDO } from "./categories/store";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp/ledger";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

// One key set per Access team, cached by jose across requests (it refetches on
// an unknown key id). Creating it per request refetched the certs every time.
const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function accessKeySet(certsUrl: URL) {
	let set = accessKeySets.get(certsUrl.href);
	if (!set) accessKeySets.set(certsUrl.href, (set = createRemoteJWKSet(certsUrl)));
	return set;
}

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env; Variables: { access?: AccessClaims } }>();

// No page of this app may be framed by another site (clickjacking on Approve,
// Send or Disconnect), and served files are never content-sniffed.
app.use("*", async (c, next) => {
	await next();
	c.res = withSecurityHeaders(c.res);
});

// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	// Skip validation in development
	if (import.meta.env.DEV) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const { payload } = await jwtVerify(token, accessKeySet(certsUrl), {
			issuer,
			audience: POLICY_AUD,
		});
		c.set("access", payload as AccessClaims);
		// An agent's service token opens the agent protocol only; its level is checked there.
		// Everywhere else it would act with the owner's full rights.
		if (!identityMayUse(payload as AccessClaims, new URL(c.req.url).pathname))
			return c.text("An agent key can only use the agent protocol at /mcp", 403);
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model note: once a teammate passes the shared Cloudflare
	// Access policy, they can access all mailboxes in this app by design.
	return next();
});

// The agent protocol (docs/agents/mcp.md). Before the API routes and the React Router catch-all.
app.all(MCP_PATH, (c) => handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext, c.get("access") ?? null));

// Mail carried by a relay in another Cloudflare account (workers/relay/): its own identity, checked there.
app.all(RELAY_INCOMING, (c) => handleRelayIncoming(c.req.raw, c.env, c.executionCtx as ExecutionContext, c.get("access") ?? null));
app.all(RELAY_FORWARDED, (c) => handleRelayForwarded(c.req.raw, c.env, c.get("access") ?? null));

// Same-origin mutation boundary; remote mail HTML cannot activate automation.
app.use("/api/*", async (c,next) => {
 if (!["GET","HEAD","OPTIONS"].includes(c.req.method)) {
  const origin=c.req.header("origin");
  if (origin && origin!==new URL(c.req.url).origin) return c.json({error:"Cross-origin request refused"},403);
 }
 await next();
});
app.route("/", api);

// Agent WebSocket routing - must be before React Router catch-all. A browser
// sends Origin on a WebSocket upgrade; another site must not open the chat
// socket with the operator's Access cookie.
app.all("/agents/*", async (c) => {
	const origin = c.req.header("origin");
	if (origin && origin !== new URL(c.req.url).origin) return c.text("Cross-origin request refused", 403);
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(event: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
		// Rejects unknown recipients permanently and rethrows processing failures.
		await handleIncomingEmail(event, env, ctx);
	},
};
