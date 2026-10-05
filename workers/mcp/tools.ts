/**
 * Every tool of the agent protocol (AP-5). Each one calls the app's own routes — the route's
 * validation and behaviour are the tool's — and names them in `routes`, which
 * `tests/mcp-coverage.test.ts` compares with every route the Worker serves.
 *
 * Accounts are named as the feed names them: `cloudflare:<address>` for a Cloudflare mailbox,
 * `gmail:<id>` for a Gmail account (`list_accounts`). A message is its account plus `messageId`.
 *
 * Adding or changing a route means adding or changing its tool here in the same change, then
 * `npm run mcp:docs` (docs/agents/mcp.md). The tests fail until both are done.
 */
import { z } from "zod";
import { ApiError, defineTool, unwrap, type ToolContext, type ToolDef } from "./protocol";
import { clip, forwardedBlock, htmlToText, quotedBlock, textToHtml } from "./mail-text";
import { headerValue, parseStoredHeaders } from "../agents/prefilter";

// ── Shared pieces ──────────────────────────────────────────────────

const enc = encodeURIComponent;
type Account = { provider: "cloudflare"; mailbox: string; id: string } | { provider: "gmail"; gmailId: string; id: string };

export function parseAccount(accountId: string): Account {
  const value = accountId.trim();
  if (value.startsWith("cloudflare:") && /^[^@\s/]+@[^@\s/]+$/.test(value.slice(11))) return { provider: "cloudflare", mailbox: value.slice(11).toLowerCase(), id: `cloudflare:${value.slice(11).toLowerCase()}` };
  if (value.startsWith("gmail:") && /^[A-Za-z0-9_-]{1,128}$/.test(value.slice(6))) return { provider: "gmail", gmailId: value.slice(6), id: value };
  if (/^[^@\s]+@[^@\s]+$/.test(value)) return { provider: "cloudflare", mailbox: value.toLowerCase(), id: `cloudflare:${value.toLowerCase()}` };
  throw new ApiError(400, `accountId must be "cloudflare:<address>" or "gmail:<id>", as list_accounts and list_messages return it`, null);
}
const cloudflareOnly = (account: Account, what: string) => {
  if (account.provider !== "cloudflare") throw new ApiError(400, `${what} is available for Cloudflare mailboxes only`, null);
  return account;
};
const box = (mailbox: string) => `/api/v1/mailboxes/${enc(mailbox)}`;
const gmail = (id: string) => `/api/accounts/${enc(id)}`;

async function get(ctx: ToolContext, path: string, query?: Record<string, unknown>) { return unwrap(await ctx.api.request("GET", path, { query })); }
async function post(ctx: ToolContext, path: string, body?: unknown) { return unwrap(await ctx.api.request("POST", path, { body: body ?? {} })); }
async function put(ctx: ToolContext, path: string, body: unknown) { return unwrap(await ctx.api.request("PUT", path, { body })); }
async function del(ctx: ToolContext, path: string) { return unwrap(await ctx.api.request("DELETE", path)); }

const accountId = z.string().min(3).max(400).describe('The account: "cloudflare:<address>" or "gmail:<id>" (from list_accounts or list_messages)');
const messageId = z.string().min(1).max(300).describe("The message id within its account (messageId from list_messages)");
const address = z.string().email().max(320).describe("A mailbox address on one of your Cloudflare domains, e.g. support@example.com");
const domain = z.string().min(3).max(253).describe("A domain in your Cloudflare account, e.g. example.com");
const recipients = z.union([z.string().email(), z.array(z.string().email()).min(1).max(100)]);
const list = (value: string | string[] | undefined) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
  .describe("Your own stable id for this one message (letters, digits, _ . : -). Retrying with the same key never sends twice; a different message needs a new key.");
const maxChars = z.number().int().min(500).max(200_000).default(20_000).describe("Longest body returned, in characters");

interface MailboxSettings { fromName?: string; signature?: { enabled?: boolean; text?: string } }
async function mailboxSettings(ctx: ToolContext, mailbox: string): Promise<MailboxSettings> {
  const data = (await get(ctx, box(mailbox))) as { settings?: MailboxSettings };
  return data.settings ?? {};
}
const signed = (text: string, settings: MailboxSettings, use: boolean) =>
  use && settings.signature?.enabled && settings.signature.text?.trim() ? `${text.trim()}\n\n${settings.signature.text.trim()}` : text;
const fromFor = (mailbox: string, settings: MailboxSettings) =>
  settings.fromName && settings.fromName !== mailbox ? { email: mailbox, name: settings.fromName } : mailbox;

/** One message, the same shape for both providers. */
interface ReadMessage {
  accountId: string; messageId: string; threadId: string | null; rfcMessageId: string | null; references: string | null;
  subject: string; from: string; to: string; cc: string | null; replyTo: string | null; date: string; folder: string | null;
  read: boolean; starred: boolean; spamReason: string | null; text: string; truncated: boolean; html?: string;
  attachments: { attachmentId: string; filename: string; type: string; size: number }[];
}
async function readMessage(ctx: ToolContext, account: Account, id: string, max = 20_000, includeHtml = false): Promise<ReadMessage> {
  if (account.provider === "cloudflare") {
    const e = (await get(ctx, `${box(account.mailbox)}/emails/${enc(id)}`)) as Record<string, unknown> & { attachments?: Record<string, unknown>[] };
    const html = String(e.body ?? "");
    const body = clip(htmlToText(html), max);
    return {
      accountId: account.id, messageId: String(e.id), threadId: (e.thread_id as string) ?? null, rfcMessageId: (e.message_id as string) ?? null,
      references: (e.email_references as string) ?? null, subject: String(e.subject ?? ""), from: String(e.sender ?? ""), to: String(e.recipient ?? ""),
      cc: (e.cc as string) || null, replyTo: headerValue(parseStoredHeaders(e.raw_headers as string | null), "reply-to")?.trim() || null, date: String(e.date ?? ""), folder: (e.folder_id as string) ?? null, read: !!e.read, starred: !!e.starred,
      spamReason: (e.spam_reason as string) ?? null, text: body.text, truncated: body.truncated, ...(includeHtml ? { html } : {}),
      attachments: (e.attachments ?? []).map((a) => ({ attachmentId: String(a.id), filename: String(a.filename), type: String(a.mimetype), size: Number(a.size) })),
    };
  }
  const m = (await get(ctx, `${gmail(account.gmailId)}/messages/${enc(id)}`)) as Record<string, unknown> & { labels?: string[]; attachments?: Record<string, unknown>[] };
  const body = clip(String(m.text || "") || htmlToText(String(m.html ?? "")), max);
  const labels = m.labels ?? [];
  return {
    accountId: account.id, messageId: String(m.providerMessageId ?? id), threadId: (m.threadId as string) ?? null, rfcMessageId: (m.rfcMessageId as string) || null,
    references: (m.references as string) || null, subject: String(m.subject ?? ""), from: String(m.from ?? ""), to: String(m.to ?? ""),
    cc: (m.cc as string) || null, replyTo: (m.replyTo as string) || null,
    date: String(m.date ?? ""), folder: labels.includes("SPAM") ? "spam" : labels.includes("TRASH") ? "trash" : labels.includes("INBOX") ? "inbox" : labels.includes("SENT") ? "sent" : "archive",
    read: !!m.read, starred: labels.includes("STARRED"), spamReason: labels.includes("SPAM") ? "Gmail put it in Spam" : null,
    text: body.text, truncated: body.truncated, ...(includeHtml ? { html: String(m.html ?? "") } : {}),
    attachments: (m.attachments ?? []).map((a) => ({ attachmentId: String(a.providerAttachmentId), filename: String(a.filename), type: String(a.mimeType), size: Number(a.size) })),
  };
}

const row = (m: Record<string, unknown>) => ({
  accountId: m.accountId, messageId: m.providerMessageId, threadId: m.threadId ?? null, subject: m.subject, from: m.sender, to: m.recipient,
  date: m.date, read: m.read, starred: m.starred, snippet: m.snippet,
  ...(m.alsoIn ? { alsoIn: m.alsoIn } : {}), ...(m.categories ? { categories: m.categories } : {}),
  ...(m.spamReason ? { spamReason: m.spamReason } : {}), ...(m.triage ? { triage: m.triage } : {}),
});

/** Text written by other people, quoted and cut, so it cannot pass for the summary's own words. */
const quoted = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").slice(0, 120));

/** The first address in a header value, e.g. "Ann <ann@example.com>" → "ann@example.com". */
const firstAddress = (value: string) => (value.match(/<([^>]+)>/)?.[1] ?? value.split(",")[0] ?? "").trim();

/** Every address of a header value, lower-cased: commas inside quotes or <> do not split it. */
function addresses(value: string | null | undefined): string[] {
  const out: string[] = [];
  let part = "", quoted = false, angle = false;
  for (const ch of `${value ?? ""},`) {
    if (ch === "\"") quoted = !quoted;
    else if (!quoted && ch === "<") angle = true;
    else if (!quoted && ch === ">") angle = false;
    if (ch === "," && !quoted && !angle) {
      const email = firstAddress(part).toLowerCase();
      if (/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(email)) out.push(email);
      part = "";
    } else part += ch;
  }
  return out;
}

/** The address an account sends as: the mailbox, or the Gmail account's own address. */
async function ownAddress(ctx: ToolContext, account: Account): Promise<string> {
  if (account.provider === "cloudflare") return account.mailbox;
  const data = (await get(ctx, "/api/accounts")) as { accounts?: { id?: unknown; email?: unknown }[] };
  const email = data.accounts?.find((a) => a.id === account.gmailId)?.email;
  if (typeof email !== "string" || !email) throw new ApiError(404, `${account.id} is not a connected Gmail account (list_accounts)`, null);
  return email.toLowerCase();
}

// ── Reading ────────────────────────────────────────────────────────

const listAccounts = defineTool({
  name: "list_accounts", title: "List accounts", level: "read", readOnly: true,
  description: "Every mailbox this Fabric Inbox reads: Cloudflare addresses and Gmail accounts, with unread and total counts, whether each is hidden or a catch-all, and any delivery problem. Start here: the accountId values are what every other mail tool takes.",
  input: {},
  routes: ["GET /api/inbox", "GET /api/accounts", "GET /api/inbox/hidden"],
  async call(_args, ctx) {
    const feed = (await get(ctx, "/api/inbox", { limit: 1 })) as { accounts: Record<string, unknown>[]; issues: unknown[] };
    const gmailAccounts = (await get(ctx, "/api/accounts")) as { configuration?: string; accounts?: Record<string, unknown>[] };
    const hidden = (await get(ctx, "/api/inbox/hidden")) as { hidden: string[] };
    return {
      accounts: feed.accounts.map((a) => ({ accountId: a.id, provider: a.provider, email: a.email, name: a.name, status: a.status,
        unread: a.unread ?? 0, total: a.total ?? 0, hidden: !!a.hidden, catchAll: !!a.catchAll, ...(a.error ? { error: a.error } : {}), ...(a.stuck ? { stuck: a.stuck } : {}) })),
      gmail: { configuration: gmailAccounts.configuration ?? "configured", accounts: (gmailAccounts.accounts ?? []).map((a) => ({ accountId: `gmail:${a.id}`, email: a.email, status: a.status, lastSyncAt: a.lastSyncAt ?? null, error: a.error ?? null })) },
      hidden: hidden.hidden,
      issues: feed.issues,
    };
  },
});

const listMessages = defineTool({
  name: "list_messages", title: "List or search messages", level: "read", readOnly: true,
  description: "The triaged feed across every mailbox, newest first — the same list the app shows. Narrow it to one account, a domain, a provider, a folder, unread mail, a category, or text in the subject, sender or body (query). Page with cursor. Hidden addresses are left out unless you name the account.",
  input: {
    accountId: accountId.optional(), domain: z.string().max(253).optional().describe("Only Cloudflare addresses on this domain"),
    provider: z.enum(["cloudflare", "gmail"]).optional(), folder: z.enum(["inbox", "sent", "archive", "trash", "starred", "spam"]).default("inbox"),
    unread: z.boolean().optional(), query: z.string().max(500).optional().describe("Text to find in subject, sender, recipient or body"),
    categoryId: z.string().max(100).optional().describe("Only messages in this category (list_categories)"),
    limit: z.number().int().min(1).max(100).default(25), cursor: z.string().max(2000).optional().describe("From the previous page's nextCursor"),
  },
  routes: ["GET /api/inbox"],
  async call(a, ctx) {
    const data = (await get(ctx, "/api/inbox", { account: a.accountId ? parseAccount(a.accountId).id : undefined, domain: a.domain, provider: a.provider, folder: a.folder,
      unread: a.unread ? 1 : undefined, query: a.query, category: a.categoryId, limit: a.limit, cursor: a.cursor })) as { messages: Record<string, unknown>[]; issues: unknown[]; hasMore: boolean; cursor?: string };
    return { messages: data.messages.map(row), hasMore: data.hasMore, nextCursor: data.cursor ?? null, issues: data.issues };
  },
});

const searchMailbox = defineTool({
  name: "search_mailbox", title: "Search one mailbox", level: "read", readOnly: true,
  description: "Search one account with fields: for a Cloudflare mailbox by sender, recipient, subject, dates, read, starred and attachments, across every folder; for Gmail by text in subject, sender, recipient and snippet of the mail synced here. Use list_messages for the feed across all accounts.",
  input: {
    accountId, query: z.string().max(500).optional(), from: z.string().max(320).optional(), to: z.string().max(320).optional(), subject: z.string().max(500).optional(),
    folder: z.string().max(100).optional(), after: z.string().max(40).optional().describe("ISO date, inclusive (Cloudflare)"), before: z.string().max(40).optional().describe("ISO date (Cloudflare)"),
    unread: z.boolean().optional(), starred: z.boolean().optional(), hasAttachment: z.boolean().optional(),
    page: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(300).optional().describe("Gmail paging: nextCursor of the previous page"),
  },
  routes: ["GET /api/v1/mailboxes/:mailboxId/search", "GET /api/accounts/:accountId/messages"],
  async call(a, ctx) {
    const account = parseAccount(a.accountId);
    if (account.provider === "gmail") {
      const q = [a.query, a.from, a.to, a.subject].filter(Boolean).join(" ");
      const data = (await get(ctx, `${gmail(account.gmailId)}/messages`, { q: q || undefined, limit: a.limit, cursor: a.cursor })) as { messages: Record<string, unknown>[]; nextCursor?: string };
      return { messages: data.messages.map((m) => ({ accountId: account.id, messageId: m.providerMessageId, threadId: m.threadId, subject: m.subject, from: m.from, to: m.to, date: m.date, read: m.read, snippet: m.snippet })), nextCursor: data.nextCursor ?? null };
    }
    const data = (await get(ctx, `${box(account.mailbox)}/search`, { query: a.query, from: a.from, to: a.to, subject: a.subject, folder: a.folder, date_start: a.after, date_end: a.before,
      is_read: a.unread === undefined ? undefined : String(!a.unread), is_starred: a.starred === undefined ? undefined : String(a.starred), has_attachment: a.hasAttachment ? "true" : undefined, page: a.page, limit: a.limit })) as { emails: Record<string, unknown>[]; totalCount: number };
    return { messages: data.emails.map((e) => ({ accountId: account.id, messageId: e.id, threadId: e.thread_id, subject: e.subject, from: e.sender, to: e.recipient, date: e.date, read: !!e.read, starred: !!e.starred, folder: e.folder_id, snippet: htmlToText(String(e.snippet ?? "")).slice(0, 200) })), total: data.totalCount, page: a.page };
  },
});

const listMailboxMessages = defineTool({
  name: "list_mailbox_messages", title: "List a mailbox folder", level: "read", readOnly: true,
  description: "Messages of one Cloudflare mailbox folder in date order, including Drafts and your own folders, which the feed does not show; or every message of one thread. For Gmail use list_messages.",
  input: { accountId, folder: z.string().max(100).default("inbox").describe("inbox, sent, draft, archive, trash, spam or one of your folders (list_folders)"),
    threadId: z.string().max(300).optional(), page: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(100).default(25) },
  routes: ["GET /api/v1/mailboxes/:mailboxId/emails"],
  async call(a, ctx) {
    const account = cloudflareOnly(parseAccount(a.accountId), "Listing a folder");
    const data = (await get(ctx, `${box(account.mailbox)}/emails`, { folder: a.folder, thread_id: a.threadId, page: a.page, limit: a.limit })) as { emails?: Record<string, unknown>[]; totalCount?: number } | Record<string, unknown>[];
    const emails = Array.isArray(data) ? data : data.emails ?? [];
    return { messages: emails.map((e) => ({ accountId: account.id, messageId: e.id, threadId: e.thread_id, subject: e.subject, from: e.sender, to: e.recipient, date: e.date, read: !!e.read, starred: !!e.starred, folder: e.folder_id })),
      total: Array.isArray(data) ? emails.length : data.totalCount ?? emails.length, page: a.page };
  },
});

const readMessageTool = defineTool({
  name: "read_message", title: "Read a message", level: "read", readOnly: true,
  description: "One message in full: headers, the body as plain text, its attachments (ids for get_attachment) and why it is in Spam if it is. Reading does not mark it read; use update_messages for that.",
  input: { accountId, messageId, maxChars, includeHtml: z.boolean().default(false).describe("Also return the original HTML") },
  routes: ["GET /api/v1/mailboxes/:mailboxId/emails/:id", "GET /api/accounts/:accountId/messages/:messageId"],
  call: (a, ctx) => readMessage(ctx, parseAccount(a.accountId), a.messageId, a.maxChars, a.includeHtml),
});

const readThread = defineTool({
  name: "read_thread", title: "Read a conversation", level: "read", readOnly: true,
  description: "Every message of a Cloudflare conversation, oldest first, as plain text. For Gmail, read the messages one by one with read_message.",
  input: { accountId, threadId: z.string().min(1).max(300), maxChars: z.number().int().min(500).max(50_000).default(8000).describe("Longest body returned per message") },
  routes: ["GET /api/v1/mailboxes/:mailboxId/threads/:threadId"],
  async call(a, ctx) {
    const account = cloudflareOnly(parseAccount(a.accountId), "Reading a conversation");
    const emails = (await get(ctx, `${box(account.mailbox)}/threads/${enc(a.threadId)}`)) as Record<string, unknown>[];
    return { messages: emails.map((e) => { const body = clip(htmlToText(String(e.body ?? "")), a.maxChars);
      return { messageId: e.id, subject: e.subject, from: e.sender, to: e.recipient, date: e.date, folder: e.folder_id, read: !!e.read, text: body.text, truncated: body.truncated }; }) };
  },
});

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const toBase64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const getAttachment = defineTool({
  name: "get_attachment", title: "Get an attachment", level: "read", readOnly: true,
  description: "The bytes of one attachment, base64-encoded, up to 5 MB. The attachmentId comes from read_message.",
  input: { accountId, messageId, attachmentId: z.string().min(1).max(2048) },
  routes: ["GET /api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", "GET /api/accounts/:accountId/messages/:messageId/attachments/:attachmentId"],
  async call(a, ctx) {
    const account = parseAccount(a.accountId);
    if (account.provider === "gmail") {
      const data = (await get(ctx, `${gmail(account.gmailId)}/messages/${enc(a.messageId)}/attachments/${enc(a.attachmentId)}`)) as { data: string; size: number };
      if (data.size > MAX_ATTACHMENT_BYTES) throw new ApiError(413, "The attachment is larger than 5 MB; open it in the app", null);
      return { size: data.size, base64: data.data.replace(/-/g, "+").replace(/_/g, "/") };
    }
    const response = await ctx.api.request("GET", `${box(account.mailbox)}/emails/${enc(a.messageId)}/attachments/${enc(a.attachmentId)}`);
    if (response.status !== 200) unwrap(response);
    const bytes = response.data instanceof Uint8Array ? response.data : new TextEncoder().encode(typeof response.data === "string" ? response.data : JSON.stringify(response.data));
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new ApiError(413, "The attachment is larger than 5 MB; open it in the app", null);
    return { type: response.contentType, size: bytes.length, base64: toBase64(bytes) };
  },
});

const listFolders = defineTool({
  name: "list_folders", title: "List folders", level: "read", readOnly: true,
  description: "The folders of a Cloudflare mailbox with their unread counts, including folders you made.",
  input: { accountId },
  routes: ["GET /api/v1/mailboxes/:mailboxId/folders"],
  async call(a, ctx) { return { folders: await get(ctx, `${box(cloudflareOnly(parseAccount(a.accountId), "Folders").mailbox)}/folders`) }; },
});

const getSendStatus = defineTool({
  name: "get_send_status", title: "Check what was sent", level: "read", readOnly: true,
  description: "Whether a message you sent went out. For a Cloudflare mailbox: one outbox entry by its id, or the latest entries. For Gmail: the receipt of a send or a draft by the idempotencyKey you gave it.",
  input: { accountId, outboxId: z.string().max(200).optional().describe("Cloudflare: the id send_email returned"), idempotencyKey: idempotencyKey.optional().describe("Gmail: the key you sent with"),
    kind: z.enum(["send", "draft"]).default("send").describe("Gmail: which receipt"), limit: z.number().int().min(1).max(100).default(20) },
  routes: ["GET /api/v1/mailboxes/:mailboxId/outbox", "GET /api/v1/mailboxes/:mailboxId/outbox/:actionId", "GET /api/accounts/:accountId/sends/:idempotencyKey", "GET /api/accounts/:accountId/drafts/:idempotencyKey"],
  async call(a, ctx) {
    const account = parseAccount(a.accountId);
    if (account.provider === "gmail") {
      if (!a.idempotencyKey) throw new ApiError(400, "Give the idempotencyKey the Gmail message was sent with", null);
      return get(ctx, `${gmail(account.gmailId)}/${a.kind === "draft" ? "drafts" : "sends"}/${enc(a.idempotencyKey)}`);
    }
    return a.outboxId ? get(ctx, `${box(account.mailbox)}/outbox/${enc(a.outboxId)}`) : { outbox: await get(ctx, `${box(account.mailbox)}/outbox`, { limit: a.limit }) };
  },
});

const listAddresses = defineTool({
  name: "list_addresses", title: "List addresses", level: "read", readOnly: true,
  description: "The Cloudflare addresses this server keeps mail for: each with its display name, its agent, where a copy is forwarded and any delivery problem; the served domains with their catch-all; and recent mail to addresses that do not exist. Give address to get one address's settings (display name, signature, agent instructions).",
  input: { address: address.optional() },
  routes: ["GET /api/project-addresses", "GET /api/v1/mailboxes", "GET /api/v1/mailboxes/:mailboxId", "GET /api/v1/config"],
  async call(a, ctx) {
    if (a.address) return get(ctx, box(a.address.toLowerCase()));
    const [overview, config] = await Promise.all([get(ctx, "/api/project-addresses"), get(ctx, "/api/v1/config")]);
    const mailboxes = (await get(ctx, "/api/v1/mailboxes")) as { email: string; name: string }[];
    return { ...(overview as object), config, mailboxes };
  },
});

const checkRouting = defineTool({
  name: "check_address_routing", title: "Check an address's routing", level: "read", readOnly: true,
  description: "Asks Cloudflare whether mail for this address reaches this server (a rule here, the catch-all, a rule elsewhere, or nothing).",
  input: { address },
  routes: ["GET /api/project-addresses/:email/routing"],
  call: (a, ctx) => get(ctx, `/api/project-addresses/${enc(a.address.toLowerCase())}/routing`),
});

const cloudflareAccount = z.string().regex(/^[0-9a-f]{32}$/).describe("A Cloudflare account id (from list_cloudflare_accounts)");

const listDomains = defineTool({
  name: "list_domains", title: "List domains", level: "read", readOnly: true,
  description: "The domains of the shown Cloudflare accounts, each with its account and whether it is served here, the accounts themselves, what a token needs, and — with destinations — `destinations: { account, destinations }`, the forwarding destinations of one account (the server's unless account is given; a copy must be confirmed in its domain's own account). Give domain for one domain's full routing detail.",
  input: { domain: domain.optional(), destinations: z.boolean().default(false).describe("Also list the forwarding destinations"), account: cloudflareAccount.optional() },
  routes: ["GET /api/domains", "GET /api/domains/:domain", "GET /api/domains/destinations"],
  async call(a, ctx) {
    const main = a.domain ? await get(ctx, `/api/domains/${enc(a.domain.toLowerCase())}`) : await get(ctx, "/api/domains");
    // Nested: the destinations answer carries its own `account`, which must not replace the domain's.
    return a.destinations ? { ...(main as object), destinations: await get(ctx, "/api/domains/destinations", a.account ? { account: a.account } : undefined) } : main;
  },
});

const listCloudflareAccounts = defineTool({
  name: "list_cloudflare_accounts", title: "List Cloudflare accounts", level: "read", readOnly: true,
  description: "Every Cloudflare account this server has a token for: its name and id, whether the server runs in it, whether it has mail, whether its domains are shown on Domains & addresses, how many domains it has and how many receive here, and whether its relay (the Worker that carries its domains' mail here) is installed.",
  input: {}, routes: ["GET /api/cloudflare/accounts"],
  call: (_a, ctx) => get(ctx, "/api/cloudflare/accounts"),
});

const getSpam = defineTool({
  name: "get_spam_settings", title: "Spam settings", level: "read", readOnly: true,
  description: "The Always spam and Never spam lists (senders and domains), how long Spam is kept, and today's use of the spam model.",
  input: {}, routes: ["GET /api/spam"], call: (_a, ctx) => get(ctx, "/api/spam"),
});

const listAgents = defineTool({
  name: "list_agents", title: "List reply agents", level: "read", readOnly: true,
  description: "The agents that answer mail on your addresses: instructions, knowledge, tools, reply policy and the addresses each answers; the templates; the tool hosts allowed. Give agentId for one agent with its versions.",
  input: { agentId: z.string().max(100).optional() },
  routes: ["GET /api/agents", "GET /api/agents/:id"],
  call: (a, ctx) => (a.agentId ? get(ctx, `/api/agents/${enc(a.agentId)}`) : get(ctx, "/api/agents")),
});

const listAgentRuns = defineTool({
  name: "list_agent_runs", title: "Reply agents' recent answers", level: "read", readOnly: true,
  description: "What the reply agents did with incoming mail, newest first: sent, drafted, needs a look, or left alone, with the reason and exactly what was sent. Page with before.",
  input: { address: address.optional(), agentId: z.string().max(100).optional(), outcome: z.enum(["answered", "attention", "skipped"]).optional(),
    before: z.string().max(200).optional().describe("The last run's createdAt|id, for the next page"), limit: z.number().int().min(1).max(200).default(50) },
  routes: ["GET /api/agent-runs"],
  call: (a, ctx) => get(ctx, "/api/agent-runs", { mailbox: a.address?.toLowerCase(), agent: a.agentId, outcome: a.outcome, before: a.before, limit: a.limit }),
});

const listCategories = defineTool({
  name: "list_categories", title: "List categories and projects", level: "read", readOnly: true,
  description: "Categories (by rule or described to the model) with their counts and backfill state, the projects that group addresses and domains, and the daily model budget. Give categoryId for one category.",
  input: { categoryId: z.string().max(100).optional() },
  routes: ["GET /api/categories", "GET /api/categories/:id", "GET /api/projects"],
  async call(a, ctx) {
    if (a.categoryId) return get(ctx, `/api/categories/${enc(a.categoryId)}`);
    return { ...(await get(ctx, "/api/categories") as object), ...(await get(ctx, "/api/projects") as object) };
  },
});

const listKnowledge = defineTool({
  name: "list_knowledge", title: "List knowledge", level: "read", readOnly: true,
  description: "Knowledge collections the reply agents answer from, with which agents use each. Give collectionId for its documents, and documentId for one document's text.",
  input: { collectionId: z.string().max(100).optional(), documentId: z.string().max(300).optional() },
  routes: ["GET /api/knowledge/collections", "GET /api/knowledge/collections/:id", "GET /api/knowledge/collections/:id/documents/:doc"],
  async call(a, ctx) {
    if (a.documentId && !a.collectionId) throw new ApiError(400, "Give the collectionId of the document too", null);
    if (a.collectionId && a.documentId) return get(ctx, `/api/knowledge/collections/${enc(a.collectionId)}/documents/${enc(a.documentId)}`);
    if (a.collectionId) return get(ctx, `/api/knowledge/collections/${enc(a.collectionId)}`);
    return get(ctx, "/api/knowledge/collections");
  },
});

const searchKnowledge = defineTool({
  name: "search_knowledge", title: "Search knowledge", level: "read", readOnly: true,
  description: "The passages of the given knowledge collections that best match a question, as a reply agent would be given them.",
  input: { query: z.string().min(1).max(500), collectionIds: z.array(z.string().max(100)).min(1).max(10), limit: z.number().int().min(1).max(20).default(5) },
  routes: ["GET /api/knowledge/search"],
  call: (a, ctx) => get(ctx, "/api/knowledge/search", { q: a.query, collections: a.collectionIds, limit: a.limit }),
});

const automationBase = (account: Account) => `/api/automation/${enc(account.provider === "cloudflare" ? account.mailbox : account.id)}`;
const listRules = defineTool({
  name: "list_rules", title: "List rules", level: "read", readOnly: true,
  description: "The automation rules of one account (conditions, action, approval or automatic, daily limit) and their latest 100 runs, including runs waiting for approval.",
  input: { accountId },
  routes: ["GET /api/automation/:account/rules", "GET /api/automation/:account/runs"],
  async call(a, ctx) {
    const base = automationBase(parseAccount(a.accountId));
    const [rules, runs] = await Promise.all([get(ctx, `${base}/rules`), get(ctx, `${base}/runs`)]);
    return { rules, runs };
  },
});

// ── Mail ───────────────────────────────────────────────────────────

const body = { text: z.string().min(1).max(1_000_000).describe("The message as plain text"), html: z.string().max(1_000_000).optional().describe("Optional HTML version; otherwise made from the text") };

const saveDraft = defineTool({
  name: "save_draft", title: "Save a draft", level: "mail", target: (a) => `${a.accountId}`,
  description: "Saves a message in Drafts without sending it — the way to propose mail a person sends. For a Cloudflare mailbox give draftId to change an existing draft; replyTo keeps it in the conversation.",
  input: { accountId, to: recipients.optional(), cc: recipients.optional(), bcc: recipients.optional(), subject: z.string().max(998).default(""), ...body,
    replyToMessageId: messageId.optional().describe("The message this draft answers"), draftId: z.string().max(200).optional().describe("Cloudflare: replace this draft"),
    signature: z.boolean().default(true).describe("Add the address's signature (Cloudflare)"),
    idempotencyKey: idempotencyKey.optional().describe("Gmail: required; your stable id for this draft") },
  routes: ["POST /api/v1/mailboxes/:mailboxId/drafts", "POST /api/accounts/:accountId/drafts"],
  async call(a, ctx) {
    const account = parseAccount(a.accountId);
    if (account.provider === "cloudflare") {
      const settings = await mailboxSettings(ctx, account.mailbox);
      const original = a.replyToMessageId ? await readMessage(ctx, account, a.replyToMessageId, 1) : null;
      const text = signed(a.text, settings, a.signature);
      return post(ctx, `${box(account.mailbox)}/drafts`, { body: a.html ?? textToHtml(text), to: list(a.to)?.join(", "), cc: list(a.cc)?.join(", "), bcc: list(a.bcc)?.join(", "),
        subject: a.subject, in_reply_to: original?.messageId, thread_id: original?.threadId ?? undefined, draft_id: a.draftId });
    }
    if (!a.idempotencyKey) throw new ApiError(400, "A Gmail draft needs an idempotencyKey", null);
    const original = a.replyToMessageId ? await readMessage(ctx, account, a.replyToMessageId, 1) : null;
    return post(ctx, `${gmail(account.gmailId)}/drafts`, { idempotencyKey: a.idempotencyKey, to: list(a.to) ?? [], cc: list(a.cc), bcc: list(a.bcc), subject: a.subject, text: a.text, html: a.html,
      threadId: original?.threadId ?? undefined, inReplyTo: original?.rfcMessageId ?? undefined, references: original ? [original.references, original.rfcMessageId].filter(Boolean).join(" ") : undefined });
  },
});

async function sendNew(ctx: ToolContext, account: Account, a: { to: string | string[]; cc?: string | string[]; bcc?: string | string[]; subject: string; text: string; html?: string; idempotencyKey: string; signature: boolean },
  thread?: { threadId?: string | null; rfcMessageId?: string | null; references?: string | null }) {
  if (account.provider === "cloudflare") {
    const settings = await mailboxSettings(ctx, account.mailbox);
    const text = signed(a.text, settings, a.signature);
    return post(ctx, `${box(account.mailbox)}/emails`, { to: list(a.to), cc: list(a.cc), bcc: list(a.bcc), from: fromFor(account.mailbox, settings), subject: a.subject, text, html: a.html ?? textToHtml(text), idempotencyKey: a.idempotencyKey });
  }
  return post(ctx, `${gmail(account.gmailId)}/send`, { idempotencyKey: a.idempotencyKey, to: list(a.to), cc: list(a.cc), bcc: list(a.bcc), subject: a.subject, text: a.text, html: a.html,
    ...(thread ? { threadId: thread.threadId ?? undefined, inReplyTo: thread.rfcMessageId ?? undefined, references: [thread.references, thread.rfcMessageId].filter(Boolean).join(" ") || undefined } : {}) });
}

const sendEmail = defineTool({
  name: "send_email", title: "Send a new message", level: "mail", sends: true, target: (a) => `${a.accountId} → ${[a.to].flat().join(", ")}`,
  description: "Sends a new message from one of your addresses or Gmail accounts. It really leaves: confirm the recipients and text with the person you work for unless they asked you to send. The idempotencyKey makes a retry safe. Counts against this key's daily sends.",
  input: { accountId, to: recipients, cc: recipients.optional(), bcc: recipients.optional(), subject: z.string().min(1).max(998), ...body, idempotencyKey,
    signature: z.boolean().default(true).describe("Add the address's signature (Cloudflare)") },
  routes: ["POST /api/v1/mailboxes/:mailboxId/emails", "POST /api/accounts/:accountId/send"],
  call: (a, ctx) => sendNew(ctx, parseAccount(a.accountId), a),
});

const reply = defineTool({
  name: "reply", title: "Reply to a message", level: "mail", sends: true, target: (a) => `${a.accountId} ${a.messageId}`,
  description: "Answers a message in its conversation: to its Reply-To address when it has one, otherwise its sender (with replyAll also everyone else in To and Cc except you), subject Re:, threaded, with the original quoted. It really leaves; counts against this key's daily sends.",
  input: { accountId, messageId, ...body, idempotencyKey, replyAll: z.boolean().default(false), to: recipients.optional().describe("Answer these addresses instead"),
    quote: z.boolean().default(true).describe("Quote the original below your text"), signature: z.boolean().default(true).describe("Add the address's signature (Cloudflare)") },
  routes: ["GET /api/v1/mailboxes/:mailboxId/emails/:id", "GET /api/v1/mailboxes/:mailboxId", "POST /api/v1/mailboxes/:mailboxId/emails/:id/reply",
    "GET /api/accounts/:accountId/messages/:messageId", "GET /api/accounts", "POST /api/accounts/:accountId/send"],
  async call(a, ctx) {
    const account = parseAccount(a.accountId);
    const original = await readMessage(ctx, account, a.messageId, 20_000);
    // Reply-To names where answers go (a help desk, a list); one with no address in it is ignored.
    const replyTargets = addresses(original.replyTo);
    const to = list(a.to) ?? (replyTargets.length ? replyTargets : [firstAddress(original.from)]);
    let cc: string[] | undefined;
    if (!a.to && a.replyAll) {
      const self = await ownAddress(ctx, account);
      const skip = new Set([self, firstAddress(original.from).toLowerCase(), ...to.map((x) => x.toLowerCase())]);
      const others = [...new Set([...addresses(original.to), ...addresses(original.cc)])].filter((x) => !skip.has(x));
      cc = others.length ? others : undefined;
    }
    const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    const text = a.quote ? `${a.text}\n\n${quotedBlock({ from: original.from, date: original.date, text: original.text })}` : a.text;
    if (account.provider === "cloudflare") {
      const settings = await mailboxSettings(ctx, account.mailbox);
      const finalText = a.quote ? `${signed(a.text, settings, a.signature)}\n\n${quotedBlock({ from: original.from, date: original.date, text: original.text })}` : signed(a.text, settings, a.signature);
      return post(ctx, `${box(account.mailbox)}/emails/${enc(a.messageId)}/reply`, { to, cc, from: fromFor(account.mailbox, settings), subject, text: finalText, html: a.html ?? textToHtml(finalText), idempotencyKey: a.idempotencyKey });
    }
    return sendNew(ctx, account, { to, cc, subject, text, html: a.html, idempotencyKey: a.idempotencyKey, signature: false }, original);
  },
});

const forward = defineTool({
  name: "forward", title: "Forward a message", level: "mail", sends: true, target: (a) => `${a.accountId} ${a.messageId} → ${[a.to].flat().join(", ")}`,
  description: "Forwards a message with its text (and, from a Cloudflare mailbox, its attachments up to 5 MB) and your note on top. It really leaves; counts against this key's daily sends.",
  input: { accountId, messageId, to: recipients, text: z.string().max(100_000).default("").describe("Your note above the forwarded message"), idempotencyKey,
    attachments: z.boolean().default(true).describe("Include the original's attachments (Cloudflare, up to 5 MB)") },
  routes: ["GET /api/v1/mailboxes/:mailboxId/emails/:id", "GET /api/v1/mailboxes/:mailboxId", "GET /api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId",
    "POST /api/v1/mailboxes/:mailboxId/emails/:id/forward", "GET /api/accounts/:accountId/messages/:messageId", "POST /api/accounts/:accountId/send"],
  async call(a, ctx) {
    const account = parseAccount(a.accountId);
    const original = await readMessage(ctx, account, a.messageId, 200_000);
    const subject = /^fwd?:/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`;
    const text = [a.text.trim(), forwardedBlock(original)].filter(Boolean).join("\n\n");
    if (account.provider === "cloudflare") {
      const settings = await mailboxSettings(ctx, account.mailbox);
      const files: { content: string; filename: string; type: string; disposition: "attachment" }[] = [];
      let total = 0;
      if (a.attachments) for (const f of original.attachments) {
        total += f.size;
        if (total > MAX_ATTACHMENT_BYTES || files.length >= 10) throw new ApiError(413, "The original's attachments are more than 5 MB or 10 files; forward with attachments: false", null);
        const got = (await getAttachment.call({ accountId: account.id, messageId: a.messageId, attachmentId: f.attachmentId }, ctx)) as { base64: string };
        files.push({ content: got.base64, filename: f.filename, type: f.type, disposition: "attachment" });
      }
      return post(ctx, `${box(account.mailbox)}/emails/${enc(a.messageId)}/forward`, { to: list(a.to), from: fromFor(account.mailbox, settings), subject, text, html: textToHtml(text), idempotencyKey: a.idempotencyKey, ...(files.length ? { attachments: files } : {}) });
    }
    return sendNew(ctx, account, { to: a.to, subject, text, idempotencyKey: a.idempotencyKey, signature: false });
  },
});

const messageRefs = z.array(z.object({ accountId, messageId })).min(1).max(100);
async function eachMessage<T>(refs: { accountId: string; messageId: string }[], run: (account: Account, id: string) => Promise<T>) {
  const done: { accountId: string; messageId: string }[] = [];
  const failed: { accountId: string; messageId: string; error: string }[] = [];
  for (const ref of refs) {
    try { await run(parseAccount(ref.accountId), ref.messageId); done.push(ref); }
    catch (error) { failed.push({ ...ref, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { done: done.length, failed };
}

const updateMessages = defineTool({
  name: "update_messages", title: "Mark read or starred", level: "mail", target: (a) => (a.thread ? `thread ${a.thread.threadId}` : `${a.messages?.length ?? 0} message(s)`),
  description: "Marks messages read or unread, starred or not. For a Cloudflare conversation, threadId marks the whole conversation read.",
  input: { messages: messageRefs.optional(), read: z.boolean().optional(), starred: z.boolean().optional(),
    thread: z.object({ accountId, threadId: z.string().min(1).max(300) }).optional().describe("Cloudflare: mark every message of this conversation read") },
  routes: ["PUT /api/v1/mailboxes/:mailboxId/emails/:id", "POST /api/v1/mailboxes/:mailboxId/threads/:threadId/read", "POST /api/accounts/:accountId/messages/:messageId/read", "POST /api/accounts/:accountId/messages/:messageId/starred"],
  async call(a, ctx) {
    if (a.thread) { const account = cloudflareOnly(parseAccount(a.thread.accountId), "Marking a conversation"); await post(ctx, `${box(account.mailbox)}/threads/${enc(a.thread.threadId)}/read`); }
    if (!a.messages) return { ok: true };
    if (a.read === undefined && a.starred === undefined) throw new ApiError(400, "Say read, starred or both", null);
    return eachMessage(a.messages, async (account, id) => {
      if (account.provider === "cloudflare") return put(ctx, `${box(account.mailbox)}/emails/${enc(id)}`, { read: a.read, starred: a.starred });
      if (a.read !== undefined) await post(ctx, `${gmail(account.gmailId)}/messages/${enc(id)}/read`, { read: a.read });
      if (a.starred !== undefined) await post(ctx, `${gmail(account.gmailId)}/messages/${enc(id)}/starred`, { starred: a.starred });
    });
  },
});

const moveMessages = defineTool({
  name: "move_messages", title: "Move messages", level: "mail", target: (a) => `${a.messages.length} message(s) → ${a.to}`,
  description: "Moves messages to inbox, archive or trash (both providers), or to another folder of a Cloudflare mailbox. Trash is kept and can be undone; to judge spam use mark_spam, which also teaches the lists.",
  input: { messages: messageRefs, to: z.string().min(1).max(100).describe("inbox, archive, trash, or a Cloudflare folder id (list_folders)") },
  routes: ["POST /api/v1/mailboxes/:mailboxId/emails/:id/move", "POST /api/accounts/:accountId/messages/:messageId/archive", "POST /api/accounts/:accountId/messages/:messageId/trashed"],
  async call(a, ctx) {
    if (a.to === "spam") throw new ApiError(400, "Use mark_spam to move mail to Spam", null);
    return eachMessage(a.messages, async (account, id) => {
      if (account.provider === "cloudflare") return post(ctx, `${box(account.mailbox)}/emails/${enc(id)}/move`, { folderId: a.to });
      if (a.to === "archive") return post(ctx, `${gmail(account.gmailId)}/messages/${enc(id)}/archive`);
      if (a.to === "trash") return post(ctx, `${gmail(account.gmailId)}/messages/${enc(id)}/trashed`, { trashed: true });
      if (a.to === "inbox") return post(ctx, `${gmail(account.gmailId)}/messages/${enc(id)}/trashed`, { trashed: false });
      throw new ApiError(400, "A Gmail message moves to inbox, archive or trash", null);
    });
  },
});

const markSpam = defineTool({
  name: "mark_spam", title: "Report spam or not spam", level: "mail", target: (a) => `${a.messages.length} message(s) spam=${a.spam}`,
  description: "Moves messages to Spam (spam: true) or back to the Inbox (spam: false), and by default puts the sender on the Always spam or Never spam list so their next mail is judged the same way. For Gmail it also tells Gmail.",
  input: { messages: messageRefs, spam: z.boolean(),
    list: z.enum(["sender", "domain", "none"]).default("sender").describe("What to remember: each message's sender, their whole domain, or nothing") },
  routes: ["POST /api/spam/report", "POST /api/spam/release"],
  async call(a, ctx) {
    // The sender remembered is the message's own, read here; the caller cannot name one, or a mail
    // key could put any domain on a list (only admin keys edit the lists, update_spam_list).
    const messages: { accountId: string; providerMessageId: string; sender: string }[] = [];
    for (const m of a.messages) {
      const account = parseAccount(m.accountId);
      const sender = a.list === "none" ? "" : firstAddress((await readMessage(ctx, account, m.messageId, 1)).from);
      messages.push({ accountId: account.id, providerMessageId: m.messageId, sender });
    }
    return post(ctx, a.spam ? "/api/spam/report" : "/api/spam/release", { messages, list: a.list });
  },
});

const deleteMessage = defineTool({
  name: "delete_message", title: "Delete a message for good", level: "mail", target: (a) => `${a.accountId} ${a.messageId}`,
  description: "Deletes a Cloudflare message, its body and attachments permanently — it cannot be restored. Prefer move_messages to trash. Takes two calls: the first says what will be deleted and gives a code.",
  input: { accountId, messageId },
  confirm: async (a, ctx) => { const m = await readMessage(ctx, cloudflareOnly(parseAccount(a.accountId), "Deleting for good"), a.messageId, 1); return `Delete for good the message ${quoted(m.subject)} from ${quoted(m.from)} (${quoted(m.date)}) in ${a.accountId}, with ${m.attachments.length} attachment(s). It cannot be restored.`; },
  routes: ["DELETE /api/v1/mailboxes/:mailboxId/emails/:id"],
  async call(a, ctx) { await del(ctx, `${box(cloudflareOnly(parseAccount(a.accountId), "Deleting for good").mailbox)}/emails/${enc(a.messageId)}`); return { deleted: true }; },
});

const syncAccount = defineTool({
  name: "sync_account", title: "Sync a Gmail account", level: "mail", target: (a) => a.accountId,
  description: "Fetches new mail from Gmail now instead of at the next scheduled sync.",
  input: { accountId },
  routes: ["POST /api/accounts/:accountId/sync"],
  async call(a, ctx) { const account = parseAccount(a.accountId); if (account.provider !== "gmail") throw new ApiError(400, "Only Gmail accounts sync; Cloudflare mail arrives as it is sent", null); return post(ctx, `${gmail(account.gmailId)}/sync`); },
});

const markCategorySeen = defineTool({
  name: "mark_category_seen", title: "Mark a category seen", level: "mail", target: (a) => a.categoryId,
  description: "Clears a category's count of new messages, as opening it in the app does.",
  input: { categoryId: z.string().min(1).max(100) },
  routes: ["POST /api/categories/:id/seen"],
  async call(a, ctx) { await post(ctx, `/api/categories/${enc(a.categoryId)}/seen`); return { ok: true }; },
});

const manageFolder = defineTool({
  name: "manage_folder", title: "Create, rename or remove a folder", level: "mail", target: (a) => `${a.accountId} ${a.folderId ?? a.name}`,
  description: "Makes, renames or removes a folder of a Cloudflare mailbox. Removing a folder moves its messages to the Inbox; nothing is deleted.",
  input: { accountId, action: z.enum(["create", "rename", "remove"]), folderId: z.string().max(100).optional().describe("rename, remove"), name: z.string().min(1).max(100).optional().describe("create, rename") },
  routes: ["POST /api/v1/mailboxes/:mailboxId/folders", "PUT /api/v1/mailboxes/:mailboxId/folders/:id", "DELETE /api/v1/mailboxes/:mailboxId/folders/:id"],
  async call(a, ctx) {
    const base = `${box(cloudflareOnly(parseAccount(a.accountId), "Folders").mailbox)}/folders`;
    if (a.action === "create") { if (!a.name) throw new ApiError(400, "Give the folder a name", null); return post(ctx, base, { name: a.name }); }
    if (!a.folderId) throw new ApiError(400, "Give folderId (list_folders)", null);
    if (a.action === "rename") { if (!a.name) throw new ApiError(400, "Give the new name", null); return put(ctx, `${base}/${enc(a.folderId)}`, { name: a.name }); }
    await del(ctx, `${base}/${enc(a.folderId)}`); return { removed: a.folderId };
  },
});

const approveRuleRun = defineTool({
  name: "approve_rule_run", title: "Approve a rule's action", level: "mail", sends: true, target: (a) => `${a.accountId} run ${a.runId}`,
  description: "Lets a rule run waiting for approval do its action (forward, archive, mark read, draft, or call its tool). A forward really leaves.",
  input: { accountId, runId: z.string().min(1).max(200) },
  routes: ["POST /api/automation/:account/runs/:id/approve"],
  call: (a, ctx) => post(ctx, `${automationBase(parseAccount(a.accountId))}/runs/${enc(a.runId)}/approve`),
});

const dismissRuleRun = defineTool({
  name: "dismiss_rule_run", title: "Dismiss a rule's action", level: "mail", target: (a) => `${a.accountId} run ${a.runId}`,
  description: "Cancels a rule run waiting for approval; nothing is done.",
  input: { accountId, runId: z.string().min(1).max(200) },
  routes: ["POST /api/automation/:account/runs/:id/dismiss"],
  call: (a, ctx) => post(ctx, `${automationBase(parseAccount(a.accountId))}/runs/${enc(a.runId)}/dismiss`),
});

// ── Administration ─────────────────────────────────────────────────

const agentChoice = z.union([z.literal("off"), z.object({ agentId: z.string().min(1).max(100) })]).describe('"off", or { agentId } of the agent that answers it (list_agents)');
const toAgent = (choice: "off" | { agentId: string } | undefined) => (choice === undefined ? undefined : choice === "off" ? "off" : { id: choice.agentId });

const createAddress = defineTool({
  name: "create_address", title: "Create an address", level: "admin", target: (a) => `${a.localPart}@${a.domain}`,
  description: "Makes a new mailbox on one of your served domains and, by default, the Cloudflare rule that sends its mail here. Optionally names it, sets its agent and forwards a copy to a verified destination.",
  input: { localPart: z.string().regex(/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/).describe("The part before @, lower case"), domain,
    name: z.string().max(80).optional().describe("Display name"), agent: agentChoice.optional(), createRoute: z.boolean().default(true).describe("Add the Cloudflare rule for it"),
    forwardTo: z.string().email().max(90).optional().describe("Also forward a copy here (a verified destination, list_domains destinations)") },
  routes: ["POST /api/project-addresses", "POST /api/v1/mailboxes"],
  call: (a, ctx) => post(ctx, "/api/project-addresses", { localPart: a.localPart, domain: a.domain.toLowerCase(), name: a.name, agent: toAgent(a.agent), createRoute: a.createRoute, forwardTo: a.forwardTo }),
});

const updateAddress = defineTool({
  name: "update_address", title: "Change an address's settings", level: "admin", target: (a) => a.address,
  description: "Changes what an address does: its display name, its signature, extra instructions for the chat assistant, which agent answers it, and where a copy of its mail is forwarded (null stops forwarding). Only the fields you give change.",
  input: { address, fromName: z.string().min(1).max(80).optional(), signature: z.object({ enabled: z.boolean(), text: z.string().max(2000) }).optional(),
    assistantPrompt: z.string().max(20_000).nullable().optional().describe("Instructions for the app's chat assistant on this mailbox; null clears them"),
    agent: agentChoice.optional(), forwardTo: z.string().email().max(90).nullable().optional().describe("A verified destination, or null to stop forwarding") },
  routes: ["PUT /api/v1/mailboxes/:mailboxId", "PUT /api/project-addresses/:email/agent", "PUT /api/project-addresses/:email/copy"],
  async call(a, ctx) {
    const email = a.address.toLowerCase();
    const out: Record<string, unknown> = {};
    if (a.fromName !== undefined || a.signature !== undefined || a.assistantPrompt !== undefined)
      out.settings = await put(ctx, box(email), { settings: { fromName: a.fromName, signature: a.signature, agentSystemPrompt: a.assistantPrompt } });
    if (a.agent !== undefined) out.agent = await put(ctx, `/api/project-addresses/${enc(email)}/agent`, { agent: toAgent(a.agent) });
    if (a.forwardTo !== undefined) out.copy = await put(ctx, `/api/project-addresses/${enc(email)}/copy`, { forwardTo: a.forwardTo });
    if (!Object.keys(out).length) throw new ApiError(400, "Nothing to change: give at least one field", null);
    return out;
  },
});

const removeAddress = defineTool({
  name: "remove_address", title: "Remove an address", level: "admin", target: (a) => a.address,
  description: "Removes a mailbox: its Cloudflare rule, and all of its mail and attachments, permanently. Takes two calls: the first says how much mail would go and gives a code.",
  input: { address },
  confirm: async (a, ctx) => {
    const email = a.address.toLowerCase();
    const feed = (await get(ctx, "/api/inbox", { account: `cloudflare:${email}`, limit: 1 })) as { accounts: { id: string; total?: number }[] };
    const total = feed.accounts.find((x) => x.id === `cloudflare:${email}`)?.total ?? 0;
    return `Remove ${email}: its Cloudflare rule is deleted and its mail (${total} message(s) in the Inbox, and every other folder) is deleted permanently. Mail sent to it afterwards is refused or goes to the domain's catch-all.`;
  },
  routes: ["DELETE /api/project-addresses/:email", "DELETE /api/v1/mailboxes/:mailboxId"],
  call: (a, ctx) => del(ctx, `/api/project-addresses/${enc(a.address.toLowerCase())}`),
});

const routeAddress = defineTool({
  name: "route_address_here", title: "Send an address's mail here", level: "admin", target: (a) => a.address,
  description: "Creates or turns on the Cloudflare rule that sends this address's mail to this server.",
  input: { address }, routes: ["POST /api/project-addresses/:email/routing"],
  call: (a, ctx) => post(ctx, `/api/project-addresses/${enc(a.address.toLowerCase())}/routing`),
});

const sendTest = defineTool({
  name: "send_test_message", title: "Send a test message", level: "admin", sends: true, target: (a) => a.address,
  description: "Sends a message from the address to itself through Cloudflare, to check that sending and receiving both work; it lands in its Inbox.",
  input: { address }, routes: ["POST /api/project-addresses/:email/test"],
  call: (a, ctx) => post(ctx, `/api/project-addresses/${enc(a.address.toLowerCase())}/test`),
});

const setCatchAll = defineTool({
  name: "set_catch_all", title: "Set a domain's catch-all", level: "admin", target: (a) => a.domain,
  description: "Chooses the mailbox that keeps mail for every address on the domain that has no mailbox of its own, and sets Cloudflare's catch-all rule to match; null stops catching.",
  input: { domain, mailbox: z.string().email().nullable() }, routes: ["PUT /api/domains/:domain/catch-all"],
  call: (a, ctx) => put(ctx, `/api/domains/${enc(a.domain.toLowerCase())}/catch-all`, { mailbox: a.mailbox?.toLowerCase() ?? null }),
});

const connectDomain = defineTool({
  name: "connect_domain", title: "Receive a domain's mail here", level: "admin", target: (a) => a.domain,
  description: "Makes this server receive and send a domain's mail: Email Routing on, the domain served, its mailboxes and their rules, sending and a DMARC record. If another provider's MX records are there it stops and says so; replaceMx: true deletes them (two calls).",
  input: { domain, replaceMx: z.boolean().default(false), sending: z.boolean().default(true) },
  confirm: (a) => (a.replaceMx ? `Delete the MX records of another mail provider on ${a.domain} and receive its mail here instead. Mail stops reaching that provider.` : null),
  routes: ["POST /api/domains/:domain/connect"],
  call: (a, ctx) => post(ctx, `/api/domains/${enc(a.domain.toLowerCase())}/connect`, { replaceMx: a.replaceMx, sending: a.sending }),
});

const releaseDomain = defineTool({
  name: "release_domain", title: "Stop serving a domain", level: "admin", target: (a) => a.domain,
  description: "Stops receiving a domain's mail here: rules that forward a copy go back to forwarding, the others are deleted, and the domain is no longer served. The mailboxes and their mail are kept. Two calls.",
  input: { domain, force: z.boolean().default(false).describe("Release even when the token cannot see the domain's zone") },
  confirm: (a) => `Stop serving ${a.domain}: its Cloudflare rules to this server are deleted or pointed back to their forwarding copies, and new mail for it no longer arrives here. Its mailboxes and mail stay.`,
  routes: ["POST /api/domains/:domain/release"],
  call: (a, ctx) => post(ctx, `/api/domains/${enc(a.domain.toLowerCase())}/release`, { force: a.force }),
});

const enableSending = defineTool({
  name: "enable_domain_sending", title: "Turn on sending for a domain", level: "admin", target: (a) => a.domain,
  description: "Turns on Cloudflare Email Sending for the domain and adds a DMARC record if it has none.",
  input: { domain }, routes: ["POST /api/domains/:domain/sending"],
  call: (a, ctx) => post(ctx, `/api/domains/${enc(a.domain.toLowerCase())}/sending`),
});

const addDestination = defineTool({
  name: "add_forward_destination", title: "Add a forwarding destination", level: "admin", target: (a) => a.email,
  description: "Adds an address that copies may be forwarded to, in one Cloudflare account (the server's unless account is given: add it in the account of the domain whose copies go there). Cloudflare emails it a verification link; it can be used once someone clicks it.",
  input: { email: z.string().email().max(320), account: cloudflareAccount.optional() }, routes: ["POST /api/domains/destinations"],
  async call(a, ctx) {
    return unwrap(await ctx.api.request("POST", "/api/domains/destinations", { body: { email: a.email }, ...(a.account ? { query: { account: a.account } } : {}) }));
  },
});

const showCloudflareAccount = defineTool({
  name: "show_cloudflare_account", title: "Show or hide a Cloudflare account", level: "admin", target: (a) => a.account,
  description: "Shows or hides an account's domains on Domains & addresses; null goes back to the default (shown when it has mail, and always for the server's own account). An account whose domains receive here cannot be hidden.",
  input: { account: cloudflareAccount, shown: z.boolean().nullable() }, routes: ["PUT /api/cloudflare/accounts/:id"],
  call: (a, ctx) => put(ctx, `/api/cloudflare/accounts/${enc(a.account)}`, { shown: a.shown }),
});

const removeCloudflareAccount = defineTool({
  name: "remove_cloudflare_account", title: "Remove a Cloudflare account", level: "admin", target: (a) => a.account,
  description: "Removes an account that was connected with its own token: its relay Worker there, the relay's sign-in here, then the token itself. Refused while one of its domains receives here, and for the server's own account.",
  input: { account: cloudflareAccount }, routes: ["DELETE /api/cloudflare/accounts/:id"],
  confirm: async (a, ctx) => {
    const list = (await get(ctx, "/api/cloudflare/accounts")) as { accounts?: { id: string; name: string; relay: unknown }[] };
    const account = list.accounts?.find((x) => x.id === a.account);
    return `Remove the Cloudflare account ${quoted(account?.name ?? a.account)} from this server: ${account?.relay ? "its relay Worker is deleted, " : ""}its token is deleted, and its domains are no longer listed. Connecting it again needs a new token pasted in the app.`;
  },
  call: (a, ctx) => del(ctx, `/api/cloudflare/accounts/${enc(a.account)}`),
});

const updateSpamList = defineTool({
  name: "update_spam_list", title: "Change a spam list", level: "admin", target: (a) => `${a.action} ${a.value} ${a.list}`,
  description: "Adds to or removes from the Always spam or Never spam lists. A sender is a full address; a domain is everything after @.",
  input: { list: z.enum(["blockedSenders", "blockedDomains", "allowedSenders", "allowedDomains"]), value: z.string().min(1).max(320), action: z.enum(["add", "remove"]) },
  routes: ["POST /api/spam/lists"],
  call: (a, ctx) => post(ctx, "/api/spam/lists", a),
});

const emptySpam = defineTool({
  name: "empty_spam", title: "Empty Spam", level: "admin", target: () => "every Cloudflare mailbox",
  description: "Deletes every message in Spam in every Cloudflare mailbox, permanently (Gmail's Spam is not touched). Two calls.",
  input: {},
  confirm: async (_a, ctx) => {
    const feed = (await get(ctx, "/api/inbox", { folder: "spam", provider: "cloudflare", limit: 100 })) as { messages: unknown[]; hasMore: boolean };
    return `Delete permanently ${feed.hasMore ? "more than 100" : feed.messages.length} message(s) in Spam across every Cloudflare mailbox. They cannot be restored.`;
  },
  routes: ["POST /api/spam/empty"],
  call: (_a, ctx) => post(ctx, "/api/spam/empty"),
});

const setHidden = defineTool({
  name: "set_hidden_addresses", title: "Hide or show addresses", level: "admin", target: (a) => `hide ${a.hide?.length ?? 0} show ${a.show?.length ?? 0}`,
  description: "Hides addresses from the sidebar, All inboxes and the totals (they keep receiving, and open on their own), or shows them again.",
  input: { hide: z.array(accountId).max(500).optional(), show: z.array(accountId).max(500).optional() },
  routes: ["PUT /api/inbox/hidden"],
  call: (a, ctx) => put(ctx, "/api/inbox/hidden", { hide: a.hide?.map((x) => parseAccount(x).id), show: a.show?.map((x) => parseAccount(x).id) }),
});

const agentInput = z.object({
  name: z.string().min(1).max(80), instructions: z.string().min(1).max(20_000), knowledge: z.string().max(50_000).optional().describe("Notes the agent always has"),
  collections: z.array(z.string().max(100)).max(10).optional().describe("Knowledge collection ids it searches"),
  tools: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), description: z.string().min(1).max(500), endpoint: z.string().url(), tool: z.string().min(1).max(200), tokenRef: z.string().max(100).optional() })).max(10).optional(),
  replyPolicy: z.object({ mode: z.enum(["draft", "auto"]), allowedIntents: z.array(z.string().max(80)).max(20).default([]), dailySendLimit: z.number().int().min(1).max(200).default(20) }).optional(),
}).describe("The agent's whole definition; saving makes a new version");

const saveAgent = defineTool({
  name: "save_agent", title: "Create or change a reply agent", level: "admin", target: (a) => a.agentId ?? a.agent.name,
  description: "Creates a reply agent, or saves a new version of one (give agentId and expectedVersion, the version you read with list_agents). A new agent drafts every answer until its replyPolicy says auto. Assign it to addresses with update_address.",
  input: { agentId: z.string().max(100).optional(), expectedVersion: z.number().int().min(1).optional(), agent: agentInput },
  routes: ["POST /api/agents", "PUT /api/agents/:id"],
  async call(a, ctx) {
    if (!a.agentId) return post(ctx, "/api/agents", { agent: a.agent });
    if (!a.expectedVersion) throw new ApiError(400, "Changing an agent needs expectedVersion (its current version from list_agents)", null);
    return put(ctx, `/api/agents/${enc(a.agentId)}`, { agent: a.agent, expectedVersion: a.expectedVersion });
  },
});

const deleteAgent = defineTool({
  name: "delete_agent", title: "Delete a reply agent", level: "admin", target: (a) => a.agentId,
  description: "Deletes a reply agent; the addresses it answered stop being answered. Two calls.",
  input: { agentId: z.string().min(1).max(100) },
  confirm: async (a, ctx) => { const d = (await get(ctx, `/api/agents/${enc(a.agentId)}`)) as { agent?: { name?: string }; addresses?: string[] }; return `Delete the agent ${quoted(d.agent?.name ?? a.agentId)}; ${d.addresses?.length ?? 0} address(es) stop being answered: ${(d.addresses ?? []).join(", ") || "none"}.`; },
  routes: ["DELETE /api/agents/:id"],
  async call(a, ctx) { await del(ctx, `/api/agents/${enc(a.agentId)}`); return { deleted: a.agentId }; },
});

const categoryInput = z.object({
  name: z.string().min(1).max(60), description: z.string().max(1000).optional().describe("What belongs here, for the model; makes it a screened category"),
  scope: z.object({ all: z.boolean().optional(), accounts: z.array(accountId).max(200).optional(), domains: z.array(z.string().max(253)).max(50).optional(), projects: z.array(z.string().max(100)).max(20).optional() }),
  conditions: z.object({ senders: z.array(z.string().max(320)).max(50).default([]), subjectWords: z.array(z.string().max(100)).max(20).default([]), textWords: z.array(z.string().max(100)).max(20).default([]) }).optional(),
  promote: z.boolean().optional(), enabled: z.boolean().optional(),
});
const saveCategory = defineTool({
  name: "save_category", title: "Create or change a category", level: "admin", target: (a) => a.categoryId ?? a.category.name,
  description: "Creates a category or replaces one (give categoryId). A description or conditions make it screened: new mail is judged, and the latest messages are classified in the background.",
  input: { categoryId: z.string().max(100).optional(), category: categoryInput },
  routes: ["POST /api/categories", "PUT /api/categories/:id"],
  call: (a, ctx) => {
    const category = { ...a.category, scope: { ...a.category.scope, accounts: a.category.scope.accounts?.map((x) => parseAccount(x).id) } };
    return a.categoryId ? put(ctx, `/api/categories/${enc(a.categoryId)}`, category) : post(ctx, "/api/categories", category);
  },
});
const deleteCategory = defineTool({
  name: "delete_category", title: "Delete a category", level: "admin", target: (a) => a.categoryId,
  description: "Deletes a category and its judgements; the messages themselves stay. Two calls.",
  input: { categoryId: z.string().min(1).max(100) },
  confirm: (a) => `Delete the category ${a.categoryId} and every judgement made for it. Messages are not touched.`,
  routes: ["DELETE /api/categories/:id"],
  async call(a, ctx) { await del(ctx, `/api/categories/${enc(a.categoryId)}`); return { deleted: a.categoryId }; },
});
const saveProject = defineTool({
  name: "save_project", title: "Create or change a project", level: "admin", target: (a) => a.projectId ?? a.name,
  description: "A project groups domains and addresses so categories can be scoped to it. Give projectId to change one.",
  input: { projectId: z.string().max(100).optional(), name: z.string().min(1).max(80), domains: z.array(z.string().max(253)).max(50).default([]), addresses: z.array(z.string().email()).max(100).default([]) },
  routes: ["POST /api/projects", "PUT /api/projects/:id"],
  call: (a, ctx) => { const b = { name: a.name, domains: a.domains, addresses: a.addresses }; return a.projectId ? put(ctx, `/api/projects/${enc(a.projectId)}`, b) : post(ctx, "/api/projects", b); },
});
const deleteProject = defineTool({
  name: "delete_project", title: "Delete a project", level: "admin", target: (a) => a.projectId,
  description: "Deletes a project; categories scoped to it lose that scope. Two calls.",
  input: { projectId: z.string().min(1).max(100) },
  confirm: (a) => `Delete the project ${a.projectId}; categories scoped to it no longer cover its domains and addresses.`,
  routes: ["DELETE /api/projects/:id"],
  async call(a, ctx) { await del(ctx, `/api/projects/${enc(a.projectId)}`); return { deleted: a.projectId }; },
});

const saveCollection = defineTool({
  name: "save_knowledge_collection", title: "Create or rename a knowledge collection", level: "admin", target: (a) => a.collectionId ?? a.name ?? "",
  description: "Creates a knowledge collection, or renames or redescribes one (give collectionId). Fill it with put_knowledge_documents; grant it to an agent with save_agent.",
  input: { collectionId: z.string().max(100).optional(), name: z.string().min(1).max(80).optional(), description: z.string().max(500).optional() },
  routes: ["POST /api/knowledge/collections", "PUT /api/knowledge/collections/:id"],
  call: (a, ctx) => {
    if (a.collectionId) return put(ctx, `/api/knowledge/collections/${enc(a.collectionId)}`, { name: a.name, description: a.description });
    if (!a.name) throw new ApiError(400, "A new collection needs a name", null);
    return post(ctx, "/api/knowledge/collections", { name: a.name, description: a.description });
  },
});
const deleteCollection = defineTool({
  name: "delete_knowledge_collection", title: "Delete a knowledge collection", level: "admin", target: (a) => a.collectionId,
  description: "Deletes a collection and its documents. Refused while an agent uses it. Two calls.",
  input: { collectionId: z.string().min(1).max(100) },
  confirm: async (a, ctx) => { const d = (await get(ctx, `/api/knowledge/collections/${enc(a.collectionId)}`)) as { collection?: { name?: string }; documents?: unknown[] }; return `Delete the collection ${quoted(d.collection?.name ?? a.collectionId)} and its ${d.documents?.length ?? 0} document(s).`; },
  routes: ["DELETE /api/knowledge/collections/:id"],
  async call(a, ctx) { await del(ctx, `/api/knowledge/collections/${enc(a.collectionId)}`); return { deleted: a.collectionId }; },
});
const putDocuments = defineTool({
  name: "put_knowledge_documents", title: "Add or update knowledge documents", level: "admin", target: (a) => `${a.collectionId} (${a.documents.length})`,
  description: "Adds documents to a collection or updates them by sourceUri (unchanged ones are skipped). prune: true also deletes every document of the collection not in this batch (two calls).",
  input: { collectionId: z.string().min(1).max(100), documents: z.array(z.object({ sourceUri: z.string().min(1).max(500), title: z.string().max(200).optional(), text: z.string().max(200_000), revision: z.string().max(100).optional() })).min(1).max(100),
    prune: z.boolean().default(false) },
  confirm: (a) => (a.prune ? `Replace the documents of ${a.collectionId}: every document not among these ${a.documents.length} is deleted.` : null),
  routes: ["POST /api/knowledge/collections/:id/documents"],
  call: (a, ctx) => post(ctx, `/api/knowledge/collections/${enc(a.collectionId)}/documents`, { documents: a.documents, prune: a.prune }),
});
const deleteDocument = defineTool({
  name: "delete_knowledge_document", title: "Delete a knowledge document", level: "admin", target: (a) => `${a.collectionId}/${a.documentId}`,
  description: "Deletes one document from a collection. Two calls.",
  input: { collectionId: z.string().min(1).max(100), documentId: z.string().min(1).max(300) },
  confirm: (a) => `Delete the document ${a.documentId} from ${a.collectionId}.`,
  routes: ["DELETE /api/knowledge/collections/:id/documents/:doc"],
  async call(a, ctx) { await del(ctx, `/api/knowledge/collections/${enc(a.collectionId)}/documents/${enc(a.documentId)}`); return { deleted: a.documentId }; },
});

const ruleInput = z.object({
  id: z.string().min(1).max(100), version: z.number().int().min(1), name: z.string().min(1).max(100), enabled: z.boolean().default(false),
  mode: z.enum(["approval", "automatic"]).default("approval"),
  conditions: z.object({ from: z.string().max(320).optional(), subject: z.string().max(200).optional(), ai: z.string().max(1000).optional() }),
  action: z.record(z.unknown()).describe('{type:"forward",to} | {type:"archive"} | {type:"mark_read"} | {type:"draft"} | {type:"mcp",endpoint,tool,arguments,tokenRef?,location:"cloud"}'),
  dailyLimit: z.number().int().min(1).max(100).default(20),
});
const saveRule = defineTool({
  name: "save_rule", title: "Create or change a rule", level: "admin", target: (a) => `${a.accountId} ${a.rule.id}`,
  description: "Saves an automation rule of one account (same id replaces it; raise version when you change it). A rule in approval mode waits for approve_rule_run; turn a rule off with enabled: false.",
  input: { accountId, rule: ruleInput },
  routes: ["PUT /api/automation/:account/rules"],
  call: (a, ctx) => put(ctx, `${automationBase(parseAccount(a.accountId))}/rules`, a.rule),
});
const dryRunRule = defineTool({
  // Changes nothing but spends the model's daily budget, so it is journalled (not readOnly).
  name: "dry_run_rule", title: "Try a rule on a message", level: "admin", target: (a) => `${a.accountId} ${a.messageId}`,
  description: "Shows whether a rule would match a Cloudflare message and what it would do, without doing it (the AI condition is judged by the model).",
  input: { accountId, messageId, rule: ruleInput },
  routes: ["POST /api/automation/:account/dry-run"],
  call: (a, ctx) => post(ctx, `${automationBase(parseAccount(a.accountId))}/dry-run`, { emailId: a.messageId, rule: a.rule }),
});

const retryIncoming = defineTool({
  name: "retry_incoming", title: "Retry mail that did not reach its rules", level: "admin", target: (a) => a.accountId,
  description: "Mail that arrived but did not reach its rules, agent or categories after several tries (list_accounts shows it as stuck) is tried again now.",
  input: { accountId }, routes: ["POST /api/v1/mailboxes/:mailboxId/incoming/retry"],
  call: (a, ctx) => post(ctx, `${box(cloudflareOnly(parseAccount(a.accountId), "Retrying").mailbox)}/incoming/retry`),
});

const exportSetup = defineTool({
  name: "export_setup", title: "Export or read the setup", level: "admin", readOnly: true,
  description: "The server's setup as a file (domains, mailboxes, their agents and forwarding, catch-alls — no secrets), or, with fromCloudflare, a proposed setup read from the Email Routing rules in your Cloudflare account, for apply_setup.",
  input: { fromCloudflare: z.boolean().default(false), domains: z.array(z.string().max(253)).max(100).optional().describe("fromCloudflare: only these domains") },
  routes: ["GET /api/setup/export", "GET /api/setup/from-cloudflare"],
  call: (a, ctx) => (a.fromCloudflare ? get(ctx, "/api/setup/from-cloudflare", { domains: a.domains }) : get(ctx, "/api/setup/export")),
});
const applySetup = defineTool({
  name: "apply_setup", title: "Apply a setup", level: "admin", target: (a) => String((a.setup as { name?: unknown }).name ?? "setup"),
  description: "Applies a setup file: adds its domains and missing mailboxes and updates their agents and forwarding. It never deletes and makes no Cloudflare change. Two calls.",
  input: { setup: z.record(z.unknown()).describe('A "fabric-inbox-setup/1" document, as export_setup returns it') },
  confirm: (a) => { const s = a.setup as { domains?: unknown[]; mailboxes?: unknown[] }; return `Apply the setup: ${s.domains?.length ?? 0} domain(s), ${s.mailboxes?.length ?? 0} mailbox(es) created or updated. Nothing is deleted.`; },
  routes: ["POST /api/setup/apply"],
  call: (a, ctx) => post(ctx, "/api/setup/apply", a.setup),
});

const disconnectGmail = defineTool({
  name: "disconnect_gmail", title: "Disconnect a Gmail account", level: "admin", target: (a) => a.accountId,
  description: "Revokes this server's access to a Gmail account and forgets its synced mail here (Gmail itself keeps everything). Reconnecting needs a person in the app. Two calls.",
  input: { accountId },
  confirm: (a) => `Disconnect ${a.accountId}: Google access is revoked and the mail synced here is forgotten. Gmail keeps it; reconnecting needs the owner in the app.`,
  routes: ["POST /api/accounts/:accountId/disconnect"],
  async call(a, ctx) { const account = parseAccount(a.accountId); if (account.provider !== "gmail") throw new ApiError(400, "Only a Gmail account is disconnected; remove a Cloudflare address with remove_address", null); return post(ctx, `${gmail(account.gmailId)}/disconnect`); },
});

const agentActivity = defineTool({
  name: "list_agent_activity", title: "What agents changed", level: "admin", readOnly: true,
  description: "The journal of every change made through this protocol, newest first: which key, which tool, on what, and whether it was done, refused or waiting for confirmation.",
  input: { before: z.number().int().optional().describe("Timestamp (ms) of the last entry, for the next page"), limit: z.number().int().min(1).max(200).default(50) },
  routes: ["GET /api/agent-keys/journal"],
  call: (a, ctx) => get(ctx, "/api/agent-keys/journal", { before: a.before, limit: a.limit }),
});

export const TOOLS: readonly ToolDef[] = [
  listAccounts, listMessages, searchMailbox, listMailboxMessages, readMessageTool, readThread, getAttachment, listFolders, getSendStatus,
  listAddresses, checkRouting, listDomains, getSpam, listAgents, listAgentRuns, listCategories, listKnowledge, searchKnowledge, listRules,
  saveDraft, sendEmail, reply, forward, updateMessages, moveMessages, markSpam, deleteMessage, syncAccount, markCategorySeen, manageFolder,
  approveRuleRun, dismissRuleRun,
  createAddress, updateAddress, removeAddress, routeAddress, sendTest, setCatchAll, connectDomain, releaseDomain, enableSending, addDestination,
  listCloudflareAccounts, showCloudflareAccount, removeCloudflareAccount,
  updateSpamList, emptySpam, setHidden, saveAgent, deleteAgent, saveCategory, deleteCategory, saveProject, deleteProject,
  saveCollection, deleteCollection, putDocuments, deleteDocument, saveRule, dryRunRule, retryIncoming, exportSetup, applySetup,
  disconnectGmail, agentActivity,
];

/**
 * Routes no tool calls, each with why (AP-5). Anything else the Worker serves must be behind a tool.
 */
export const NOT_TOOLS: Readonly<Record<string, string>> = {
  "GET /api/accounts/gmail/connect": "Connecting Gmail is a person's consent in a browser (Google's OAuth page and a cookie)",
  "POST /api/accounts/gmail/connect": "Connecting Gmail is a person's consent in a browser (Google's OAuth page and a cookie)",
  "GET /api/accounts/gmail/callback": "Google's OAuth redirect back to the browser",
  "GET /api/agent-keys": "Agent keys are issued and revoked by a person in the app; an agent cannot mint keys",
  "POST /api/agent-keys": "Agent keys are issued and revoked by a person in the app; an agent cannot mint keys",
  "DELETE /api/agent-keys/:id": "Agent keys are issued and revoked by a person in the app; an agent cannot mint keys",
  "POST /api/cloudflare/accounts": "A Cloudflare token is a secret: a person pastes it in the app, so it never passes through an agent's transcript",
};
