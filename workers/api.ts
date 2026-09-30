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
import { cloudflareAccountsRouter } from "./routes/cloudflare-accounts";
import { knowledgeRouter } from "./routes/knowledge";
import { categoriesRouter } from "./routes/categories";
import { spamRouter } from "./routes/spam";
import { agentKeysRouter } from "./routes/agent-keys";
import type { Env } from "./types";

export const api = new Hono<{ Bindings: Env }>();
api.route("/", automationRouter);
api.route("/", accountsRouter);
api.route("/", inboxRouter);
api.route("/", agentsRouter);
api.route("/", setupRouter);
api.route("/", domainsRouter);
api.route("/", cloudflareAccountsRouter);
api.route("/", knowledgeRouter);
api.route("/", categoriesRouter);
api.route("/", spamRouter);
api.route("/", agentKeysRouter);
api.route("/", mailboxApi);
