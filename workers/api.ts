/**
 * The app's JSON API as one Hono app: every route the web app and the agent protocol call.
 * `workers/app.ts` mounts it behind Access and the same-origin boundary; the agent protocol
 * (`workers/mcp/`) calls it in-process, after its own check of the caller's level.
 */
import { Hono } from "hono";
import { app as mailboxApi } from "./index";
import { automationRouter } from "./automation";
import { accountsRouter } from "./routes/accounts";
import { inboxRouter } from "./routes/inbox";
import { agentsRouter } from "./routes/agents";
import { setupRouter } from "./routes/setup";
import { domainsRouter } from "./routes/domains";
import { serverUpdateRouter } from "./routes/server-update";
import { cloudflareAccountsRouter } from "./routes/cloudflare-accounts";
import { knowledgeRouter } from "./routes/knowledge";
import { categoriesRouter } from "./routes/categories";
import { campaignsRouter } from "./routes/campaigns";
import { spamRouter } from "./routes/spam";
import { safetyRouter } from "./routes/safety";
import { discardRouter } from "./routes/discard";
import { agentKeysRouter } from "./routes/agent-keys";
import { gmailSetupRouter } from "./routes/gmail-setup";
import { credentialKeyRouter } from "./routes/credential-key";
import { microsoftSetupRouter } from "./routes/microsoft-setup";
import { membersRouter } from "./routes/members";
import type { Env } from "./types";
import { BUILD_HEADER, BUILD_ID } from "../shared/build";

export const api = new Hono<{ Bindings: Env }>();
// Every answer names the build that gave it, so a page older than the server can say so (P3-13).
api.use("*", async (c, next) => {
  await next();
  c.header(BUILD_HEADER, BUILD_ID);
});
api.route("/", automationRouter);
api.route("/", accountsRouter);
api.route("/", inboxRouter);
api.route("/", agentsRouter);
api.route("/", setupRouter);
api.route("/", domainsRouter);
api.route("/", serverUpdateRouter);
api.route("/", cloudflareAccountsRouter);
api.route("/", knowledgeRouter);
api.route("/", campaignsRouter);
api.route("/", categoriesRouter);
api.route("/", spamRouter);
api.route("/", safetyRouter);
api.route("/", discardRouter);
api.route("/", agentKeysRouter);
api.route("/", gmailSetupRouter);
api.route("/", credentialKeyRouter);
api.route("/", microsoftSetupRouter);
api.route("/", membersRouter);
api.route("/", mailboxApi);
