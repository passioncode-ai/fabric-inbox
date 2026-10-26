import type { Env } from "../types";
import { scanPromptInjection } from "../lib/ai";
import { allServedDomains } from "../lib/mailbox-store";
import { stripHtmlToText, textToHtml } from "../lib/email-helpers";
import { callMcpTool, toolResultText, type ToolTokens } from "../automation/mcp";
import { openRouterAgentModel, openRouterCheck, openRouterParaphrase, replyReasoning, workersAiModel, workersAiParaphrase } from "./model";
import { legacyAgentId, readAssignment } from "./definition";
import type { RunnerDeps } from "./runner";
import { msg } from "../../shared/i18n";

type Registry = RunnerDeps["registry"];

/** The tool tokens keyed by their secret names (a grant's `tokenRef`); never the values out. */
export function toolTokens(env: Env): ToolTokens {
  try {
    const value = JSON.parse(env.AUTOMATION_TOOL_TOKENS || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new Error(msg("Tool credentials are misconfigured"));
  }
}

/**
 * Whether an address with a mailbox here has an agent that will answer: not Off, and an assigned agent
 * that still exists — or none assigned yet, as a pre-registry mailbox migrates on its first message,
 * unless the agent it was migrated to has been deleted since, which is never re-created (B-93). An
 * address counted as answering when it will not makes every copy that ranks it first wait the claim.
 */
export async function assignmentServes(assignment: ReturnType<typeof readAssignment>, address: string, registry: Pick<Registry, "getAgent" | "agentState">): Promise<boolean> {
  if (assignment === "off") return false;
  if (assignment) return (await registry.getAgent(assignment.id)) !== null;
  return !registry.agentState || (await registry.agentState(legacyAgentId(address))) !== "deleted";
}

/** The production effects of one run, all scoped to the Cloudflare mailbox being answered. */
export function productionDeps(env: Env, mailboxId: string, registry: Registry): RunnerDeps {
  const box = mailboxId.toLowerCase();
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box));
  const settingsKey = `mailboxes/${box}.json`;
  return {
    ...sharedDeps(env, registry),
    mailbox: {
      async settings() {
        const object = await env.BUCKET.get(settingsKey);
        return object ? await object.json<Record<string, unknown>>() : null;
      },
      async saveAssignment(agentId) {
        const object = await env.BUCKET.get(settingsKey);
        if (!object) return;
        const settings = await object.json<Record<string, unknown>>();
        // Never overwrite an assignment the operator made meanwhile.
        if (settings.agent !== undefined) return;
        // B-29: written on the version read, so an address deleted meanwhile is not made again by this write.
        await env.BUCKET.put(settingsKey, JSON.stringify({ ...settings, agent: { id: agentId } }), { onlyIf: { etagMatches: object.etag } });
      },
      async email(id) {
        const email = await stub.getEmail(id);
        if (!email) return null;
        return {
          id: email.id, sender: email.sender ?? "", subject: email.subject ?? "", body: email.body ?? "",
          date: email.date ?? "", thread_id: email.thread_id ?? null, raw_headers: email.raw_headers ?? null,
          folder_id: email.folder_id ?? undefined,
          message_id: email.message_id ?? null, recipient: email.recipient ?? null, cc: email.cc ?? null,
        };
      },
      async thread(threadId) {
        const rows = await stub.recentThreadEmails(threadId, 20);
        return rows.map((m) => ({
          id: String(m.id), sender: String(m.sender ?? ""), recipient: String(m.recipient ?? ""),
          date: String(m.date ?? ""), folder_id: String(m.folder_id ?? ""), body: String(m.body ?? ""),
        }));
      },
      rateLimit: () => stub.checkSendRateLimit(),
      send: (command) => stub.sendMail(command),
      async createDraft(draft) {
        if (await stub.getEmail(draft.id)) return;
        await stub.createEmail("draft", {
          id: draft.id, subject: draft.subject, sender: box, recipient: draft.to.toLowerCase(),
          date: new Date().toISOString(), body: textToHtml(draft.text), in_reply_to: draft.inReplyTo,
          email_references: null, thread_id: draft.threadId,
        }, []);
      },
    },
  };
}

/** Everything a run needs but its mailbox: the same for a Cloudflare address and an account (B-171). */
export function sharedDeps(env: Env, registry: Registry): Omit<RunnerDeps, "mailbox"> {
  return {
    registry,
    async agentServes(address) {
      const object = await env.BUCKET.get(`mailboxes/${address.toLowerCase()}.json`);
      if (!object) return false;
      return assignmentServes(readAssignment(await object.json<Record<string, unknown>>()), address, registry);
    },
    // The prompt and tool outputs are scanned exactly as the model reads them (bug hunt 2026-10-12).
    injection: (text) => scanPromptInjection(env.AI, text, { plain: true }),
    // With a reply-lane key, answers are written on OpenRouter and checked by another vendor before they
    // leave; without one, the server's own Workers AI writes them and nothing checks them.
    ...(env.OPENROUTER_API_KEY ? {
      model: (request) => openRouterAgentModel(env.OPENROUTER_API_KEY!, request, { primary: env.REPLY_MODEL, fallback: env.REPLY_FALLBACK_MODEL,
        reasoning: replyReasoning(env.REPLY_REASONING) }),
      paraphrase: (text) => openRouterParaphrase(env.OPENROUTER_API_KEY!, text, env.REPLY_FALLBACK_MODEL),
      check: (writer, input) => openRouterCheck(env.OPENROUTER_API_KEY!, writer, input),
    } satisfies Pick<RunnerDeps, "model" | "paraphrase" | "check"> : {
      model: (request) => workersAiModel(env.AI, env.AGENT_MODEL, request),
      paraphrase: (text) => workersAiParaphrase(env.AI, env.AGENT_MODEL, text),
    }),
    knowledge: {
      async search(query, collections, limit) {
        if (!env.KNOWLEDGE) throw new Error("knowledge is not configured on this server");
        return env.KNOWLEDGE.getByName("workspace").search(query, collections, limit);
      },
    },
    async callTool(grant, args) {
      const result = await callMcpTool(
        { endpoint: grant.endpoint, tool: grant.tool, arguments: args, tokenRef: grant.tokenRef },
        env.AUTOMATION_MCP_HOSTS ?? "",
        toolTokens(env),
      );
      const text = toolResultText(result);
      if (result.isError) throw new Error(text.slice(0, 300) || "Tool returned an error");
      return text || "(the tool returned no text)";
    },
    htmlToText: stripHtmlToText,
    servedDomains: () => allServedDomains(env),
  };
}
