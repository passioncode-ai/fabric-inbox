// B-209: what this server uses, declared in its fabric-service document under the contract's connections extension
// (fabric-agent-contract DEC-0096, schemas/service-connections-extension.schema.json) so a host's map shows what it
// depends on. Built from the server's own settings only, never by calling the things it names: the document is
// read every minute, and a connection's state here is what its settings say, not a live probe.
import type { Env } from "../types";
import { cloudflareApi } from "../routing/cloudflare-api";
import { DEFAULT_AGENT_MODEL, REPLY_FALLBACK_MODEL, REPLY_MODEL, checkersFor } from "../agents/model";
import { DEFAULT_CATEGORY_MODEL } from "../categories/classify";

export const CONNECTIONS_EXTENSION = "https://fabric.passioncode.ai/agent-contract/extensions/connections/0.1";

/** The injection scan's model (`scanPromptInjection`, workers/lib/ai.ts). */
export const SCAN_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export interface Connection {
  id: string;
  kind: "service" | "model" | "connector" | "store" | "channel";
  target: string;
  state: "ok" | "degraded" | "down" | "unknown";
  purpose?: string;
  reason?: string;
}

type Settings = Pick<Env, "OPENROUTER_API_KEY" | "REPLY_MODEL" | "REPLY_FALLBACK_MODEL" | "AGENT_MODEL" | "CATEGORY_MODEL" | "SPAM_MODEL"
  | "GOOGLE_CLIENT_ID" | "MICROSOFT_CLIENT_ID"> & Partial<Pick<Env, "AGENT_REGISTRY" | "CATEGORIES" | "KNOWLEDGE">>;

export function connectionsOf(env: Settings & Parameters<typeof cloudflareApi>[0]): Connection[] {
  const out: Connection[] = [
    { id: "mailboxes", kind: "store", target: "cloudflare-durable-objects", state: "ok", purpose: "Each mailbox, its automation and the shared stores (accounts, agents, knowledge, categories, ledger)." },
    { id: "files", kind: "store", target: "cloudflare-r2", state: "ok", purpose: "Attachments, the list of addresses and archives." },
    cloudflareApi(env)
      ? { id: "cloudflare", kind: "channel", target: "cloudflare-email", state: "ok", purpose: "Receives and sends the mail of every Cloudflare address." }
      : { id: "cloudflare", kind: "channel", target: "cloudflare-email", state: "degraded", purpose: "Receives and sends the mail of every Cloudflare address.",
        reason: "No Cloudflare token on the server: mail still arrives, but domains, addresses and self-update are off." },
  ];
  if (env.GOOGLE_CLIENT_ID) out.push({ id: "gmail", kind: "channel", target: "gmail", state: "ok", purpose: "Reads and sends the mail of connected Gmail accounts." });
  if (env.MICROSOFT_CLIENT_ID) out.push({ id: "outlook", kind: "channel", target: "outlook", state: "ok", purpose: "Reads and sends the mail of connected Outlook accounts." });
  if (env.AGENT_REGISTRY) {
    if (env.OPENROUTER_API_KEY) {
      const writer = env.REPLY_MODEL || REPLY_MODEL;
      out.push({ id: "model-writer", kind: "model", target: writer, state: "ok", purpose: "Writes the reply agents' answers." });
      out.push({ id: "model-fallback", kind: "model", target: env.REPLY_FALLBACK_MODEL || REPLY_FALLBACK_MODEL, state: "ok", purpose: "Writes an answer when the writer fails." });
      checkersFor(writer).forEach((model, i) =>
        out.push({ id: `model-checker-${i + 1}`, kind: "model", target: model, state: "ok", purpose: "Checks an answer before it is sent (another vendor than the writer)." }));
    } else {
      out.push({ id: "model-writer", kind: "model", target: env.AGENT_MODEL || DEFAULT_AGENT_MODEL, state: "degraded", purpose: "Writes the reply agents' answers.",
        reason: "No OpenRouter key: the server's own Workers AI writes, and no checker approves an answer before it is sent." });
    }
    out.push({ id: "model-scan", kind: "model", target: SCAN_MODEL, state: "ok", purpose: "Looks for text that tries to steer an agent." });
  }
  if (env.CATEGORIES) out.push({ id: "model-categories", kind: "model", target: env.CATEGORY_MODEL || DEFAULT_CATEGORY_MODEL, state: "ok", purpose: "Sorts mail into categories." });
  if (env.KNOWLEDGE) out.push({ id: "knowledge", kind: "store", target: "knowledge", state: "ok", purpose: "The reply agents' own knowledge, searched before an answer." });
  return out;
}
