// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet, decodeJwt } from "jose";
import { createRequestHandler } from "react-router";
import { withSecurityHeaders } from "./lib/security-headers";
import { handleIncomingEmail } from "./index";
import { api } from "./api";
import { handleMcp } from "./mcp/handler";
import { fabricServiceRouter } from "./routes/fabric-service";
import { handleRelayForwarded, handleRelayIncoming, RELAY_FORWARDED, RELAY_INCOMING } from "./relay/ingress";
import { identityMayUse, MCP_PATH, type AccessClaims } from "./mcp/keys";
import { audienceFor, serviceAudience } from "./mcp/service-access";
import { membersCached, MembersError, standingOf, type Standing } from "./lib/members";
import { memberBody, memberGate } from "./lib/member-gate";
import { inProcessApi } from "./mcp/handler";
import { scopedApi } from "./mcp/scope";
import { ApiError } from "./mcp/protocol";
import { msg } from "../shared/i18n";
export { AutomationDO } from "./automation";
export { GmailAccountsDO } from "./providers/accounts-do";
export { AgentRegistryDO } from "./agents/registry";
export { KnowledgeDO } from "./knowledge/store";
export { CategoriesDO } from "./categories/store";
export { CampaignsDO } from "./campaigns/store";
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
const app = new Hono<{ Bindings: Env; Variables: { access?: AccessClaims; standing?: Standing } }>();

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
		// B-150: the fabric-service routes have an Access application of their own; its token is
		// accepted on those routes only (workers/mcp/service-access.ts).
		// The path the router matches (decoded as Hono decodes it), never the raw one: N-1.
		const pathname = c.req.path;
		const audience = await audienceFor(pathname, decodeJwt(token).aud, POLICY_AUD, () => serviceAudience(c.env.BUCKET));
		const { payload } = await jwtVerify(token, accessKeySet(certsUrl), {
			issuer,
			audience,
		});
		c.set("access", payload as AccessClaims);
		// An agent's service token opens the agent protocol only; its level is checked there.
		// Everywhere else it would act with the owner's full rights.
		if (!identityMayUse(payload as AccessClaims, pathname))
			return c.text("An agent key can only use the agent protocol at /mcp", 403);
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model: Access says who may pass; the list of people (B-149, the next middleware)
	// says what each reaches. With nobody listed, everyone Access lets in is an administrator.
	return next();
});

// B-149: a person's role on a shared server. Access says who may pass; config/members.json says
// what they reach. With no list every person is an administrator, as before (workers/lib/members.ts).
app.use("*", async (c, next) => {
	if (import.meta.env.DEV) return next();
	const email = c.get("access")?.email;
	if (typeof email !== "string" || !email) return next(); // an agent key: its own checks
	let standing: Standing;
	try {
		standing = standingOf(await membersCached(c.env.BUCKET), email);
	} catch (error) {
		console.error(JSON.stringify({ event: "members_unreadable", error: (error as Error).message.slice(0, 200) }));
		return c.text(error instanceof MembersError ? error.message : "The server's list of people cannot be read; try again in a moment.", 503);
	}
	c.set("standing", standing);
	if (standing.role === "admin") return next();
	const url = new URL(c.req.url);
	// Gated on the path the router matches: "/%61pi/members" is routed as "/api/members", so judging
	// the raw "/%61pi/..." as a page let a member reach every route, /mcp included (N-1).
	const path = c.req.path;
	const isApi = path.startsWith("/api/");
	const refuse = (text: string) => (isApi ? c.json({ error: text }, 403) : c.text(text, 403));
	if (standing.role === "none")
		return refuse(msg("{email} is not on this server's list of people. Ask its administrator to add you.", { email: standing.email }));
	const gate = memberGate(c.req.method, path, standing.accounts);
	if (gate === "pass") return next();
	if (gate === "refuse") return refuse(msg("Only an administrator of this server can do that. You reach your own mailboxes."));
	const inProcess = inProcessApi(url.origin, c.env, c.executionCtx as ExecutionContext);
	if (gate === "body") {
		// Answered here, before the same-origin boundary below, so it is held to that rule here too.
		const origin = c.req.header("origin");
		if (origin && origin !== url.origin) return c.json({ error: "Cross-origin request refused" }, 403);
		const narrowed = memberBody(`${c.req.method} ${path}`, await c.req.json().catch(() => null), standing.accounts);
		if ("refuse" in narrowed) return refuse(msg("Only an administrator of this server can do that. You reach your own mailboxes."));
		const answer = await inProcess.request(c.req.method as "POST", path, { body: narrowed.body });
		return c.json(answer.data as object, answer.status as 200);
	}
	// The feed and the safety check's routes: answered for the member's mailboxes only, as for an agent key limited to them.
	try {
		const scoped = scopedApi(inProcess, standing.accounts, "person");
		const reads = c.req.method === "GET" || c.req.method === "HEAD";
		if (!reads) {
			const origin = c.req.header("origin");
			if (origin && origin !== url.origin) return c.json({ error: "Cross-origin request refused" }, 403);
		}
		const answer = await scoped.request(reads ? "GET" : (c.req.method as "POST"), path,
			{ query: Object.fromEntries(url.searchParams), ...(reads ? {} : { body: await c.req.json().catch(() => null) }) });
		return c.json(answer.data as object, answer.status as 200);
	} catch (error) {
		if (error instanceof ApiError) return c.json({ error: error.message }, error.status as 403);
		throw error;
	}
});

// The agent protocol (docs/agents/mcp.md). Before the API routes and the React Router catch-all.
// fabric-service/0.1 (B-87 part 4): read routes for a host on the operator's computer, each checking the key.
app.route("/", fabricServiceRouter);

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
