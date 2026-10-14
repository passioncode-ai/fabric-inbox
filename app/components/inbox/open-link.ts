import type { InboxMessage } from "./model";
export { messageLink } from "../../../shared/mail/open-link";

const PROVIDERS = new Set(["cloudflare", "gmail", "imap", "outlook"]);
const RUN = /^agent-[0-9a-f]{32}$/;

/**
 * The message a link asks the reader to open (B-119), enough to read it, reply to it and show its
 * agent run; null for a link that names no message this inbox can open.
 */
export function openFromLink(params: URLSearchParams): InboxMessage | null {
  const open = params.get("open") ?? "";
  const bar = open.indexOf("|");
  if (bar < 1) return null;
  const accountId = open.slice(0, bar), providerMessageId = open.slice(bar + 1);
  const provider = accountId.slice(0, accountId.indexOf(":"));
  if (!PROVIDERS.has(provider) || !providerMessageId || accountId.indexOf(":") === accountId.length - 1) return null;
  const run = params.get("run") ?? "";
  return {
    id: JSON.stringify([accountId, providerMessageId]), accountId, provider: provider as InboxMessage["provider"], providerMessageId,
    subject: "", sender: "", recipient: "", date: "", read: true, starred: false, snippet: "",
    ...(RUN.test(run) ? { agentRun: { id: run, status: "" } } : {}),
  };
}
