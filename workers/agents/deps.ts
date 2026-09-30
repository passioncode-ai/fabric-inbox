import type { Env } from "../types";
import { scanPromptInjection } from "../lib/ai";
import { allServedDomains } from "../lib/mailbox-store";
import { stripHtmlToText, textToHtml } from "../lib/email-helpers";
import { callMcpTool, toolResultText } from "../automation/mcp";
import { workersAiModel } from "./model";
import type { RunnerDeps } from "./runner";

type Registry = RunnerDeps["registry"];

function toolTokens(env: Env): Record<string, string> {
  try {
    const value = JSON.parse(env.AUTOMATION_TOOL_TOKENS || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new Error("Tool credentials are misconfigured");
  }
}

/** The production effects of one run, all scoped to the mailbox being answered. */
export function productionDeps(env: Env, mailboxId: string, registry: Registry): RunnerDeps {
  const box = mailboxId.toLowerCase();
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box));
  const settingsKey = `mailboxes/${box}.json`;
  return {
    registry,
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
        await env.BUCKET.put(settingsKey, JSON.stringify({ ...settings, agent: { id: agentId } }));
      },
      async email(id) {
        const email = await stub.getEmail(id);
        if (!email) return null;
        return {
          id: email.id, sender: email.sender ?? "", subject: email.subject ?? "", body: email.body ?? "",
          date: email.date ?? "", thread_id: email.thread_id ?? null, raw_headers: email.raw_headers ?? null,
          folder_id: email.folder_id ?? undefined,
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
    injection: (text) => scanPromptInjection(env.AI, text),
    model: (request) => workersAiModel(env.AI, env.AGENT_MODEL, request),
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
