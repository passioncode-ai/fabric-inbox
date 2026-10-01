// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { type StoredAttachment } from "./lib/attachments";
import { storedAttachmentName } from "../shared/mail/attachments";
import { allServedDomains, createMailbox, deleteMailbox, listMailboxAddresses, readSettings, storedCatchAll, updateSettings, readAllSettings, allowedAddresses as allowedAddressList } from "./lib/mailbox-store";
import { createAddress, removeAddress } from "./lib/address-ops";
import { routingClient } from "./routing/email-routing";
import { handleSendEmail, handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import { spamCheck, type SpamVerdict } from "../shared/mail/spam";
import { readSpamLists } from "./spam/lists";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", async (c) => {
	const domains = await allServedDomains(c.env);
	const emailAddresses = allowedAddressList(c.env);
	return c.json({ domains, emailAddresses });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	// The display name each mailbox sends with, so a rename on Settings shows here.
	const all = await readAllSettings(c.env.BUCKET);
	return c.json(all.map(({ email, settings }) => ({ id: email, email,
		name: typeof settings.fromName === "string" && settings.fromName.trim() ? settings.fromName : email })));
});

// Mailboxes screen (MB-1): creating and removing go through the same operations as
// Domains & addresses, so Cloudflare's rule and the catch-all are kept right.
app.post("/api/v1/mailboxes", async (c) => {
	const parsed = CreateMailboxBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid mailbox: email and name are required" }, 400);
	const { name, email } = parsed.data;
	const result = await createAddress(c.env, { email, name, agent: "off", createRoute: !!routingClient(c.env) }, null);
	if (result.status !== 201) return c.json(result.body, result.status);
	return c.json({ id: email.toLowerCase(), email: email.toLowerCase(), name, settings: result.body.settings,
		...(result.body.warning ? { warning: result.body.warning } : {}) }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	const settings = await readSettings(c.env.BUCKET, mailboxId).catch(() => null);
	if (!settings) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: typeof settings.fromName === "string" && settings.fromName ? settings.fromName : mailboxId, email: mailboxId, settings });
});

/**
 * Settings (MB-2): only what the Settings page edits is changed, merged into what is
 * stored, so an agent or a forwarding copy set elsewhere meanwhile is kept.
 */
const MailboxSettingsPatch = z.object({
	fromName: z.string().trim().min(1, "A display name is needed").max(80).optional(),
	signature: z.object({ enabled: z.boolean(), text: z.string().max(2000) }).strict().optional(),
	agentSystemPrompt: z.string().max(20000).nullable().optional(),
}).strict();
app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!.toLowerCase();
	const raw = (await c.req.json().catch(() => null)) as { settings?: unknown } | null;
	const parsed = MailboxSettingsPatch.safeParse(raw?.settings);
	if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid settings" }, 400);
	const patch = parsed.data;
	const next = await updateSettings(c.env.BUCKET, mailboxId, (current) => {
		const merged: Record<string, unknown> = { ...current };
		if (patch.fromName !== undefined) merged.fromName = patch.fromName;
		if (patch.signature !== undefined) merged.signature = { enabled: patch.signature.enabled, text: patch.signature.text.trim() };
		if (patch.agentSystemPrompt !== undefined) {
			if (patch.agentSystemPrompt === null || !patch.agentSystemPrompt.trim()) delete merged.agentSystemPrompt;
			else merged.agentSystemPrompt = patch.agentSystemPrompt;
		}
		return merged;
	});
	if (!next) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: typeof next.fromName === "string" ? next.fromName : mailboxId, email: mailboxId, settings: next });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const result = await removeAddress(c.env, c.req.param("mailboxId")!);
	return result.status === 200 ? c.json(result.body) : c.json(result.body, result.status);
});

/** Retry the journal events of this mailbox that were set aside (reliability audit H2). */
app.post("/api/v1/mailboxes/:mailboxId/incoming/retry", async (c: AppContext) => {
	const revived = await c.var.mailboxStub.retryIncoming();
	return c.json({ revived });
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", (c) => handleSendEmail(c));

app.get("/api/v1/mailboxes/:mailboxId/outbox", async (c) => {
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 50));
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  return c.json(await c.var.mailboxStub.listOutbox(c.req.param('mailboxId'), limit, offset));
});
app.get("/api/v1/mailboxes/:mailboxId/outbox/:actionId", async (c) => {
  const item = await c.var.mailboxStub.getOutboxAction(c.req.param('mailboxId'), c.req.param('actionId'));
  return item ? c.json(item) : c.json({ error: 'Outbox action not found' }, 404);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	// Only a draft can be replaced, and only after its successor is stored: a
	// draft_id used to delete any message, and a failed create lost the draft.
	const previous = draft_id ? await stub.getEmail(draft_id) : null;
	if (draft_id && (!previous || previous.folder_id !== Folders.DRAFT)) return c.json({ error: "draft_id is not a draft in this mailbox" }, 400);
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	if (previous) await stub.deleteEmail(previous.id);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	if (bytesRead !== streamSize) throw new Error("Stream shorter than declared size");
	return result;
}

type IncomingEmailEvent = {
	raw: ReadableStream; rawSize: number; to?: string; from?: string;
	setReject?: (reason: string) => void;
	/** Email Routing forward to a verified destination; absent outside the email handler. */
	forward?: (rcptTo: string, headers?: Headers) => Promise<unknown>;
	/**
	 * Mail carried by a relay in another account (workers/relay/): the relay forwards the copy there,
	 * so it is handed back here and stays owed until the relay reports (`settleRelayedCopy`).
	 */
	deferForward?: (rcptTo: string) => void;
};
type RejectReason = "no_recipient" | "domain_not_served" | "unknown_address";
type Route = { mailboxId: string } | { rejected: RejectReason; address?: string };

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);


// Per-domain policy for mail to an address that has no mailbox (SCN-025):
// JSON such as {"example.com":"catch_all:hello@example.com"}; anything else rejects.
async function unknownAddressPolicy(env: Env, domain: string): Promise<{ kind: "reject" } | { kind: "catch_all"; mailbox: string }> {
	let policies: Record<string, unknown> = {};
	if (env.UNKNOWN_ADDRESS_POLICY) {
		// A broken policy is a configuration error: fail the delivery so it is
		// visible, never guess a destination or drop the message.
		policies = JSON.parse(env.UNKNOWN_ADDRESS_POLICY);
	}
	const value = policies[domain];
	if (typeof value === "string" && value.startsWith("catch_all:")) {
		const mailbox = value.slice("catch_all:".length).trim().toLowerCase();
		if (mailbox) return { kind: "catch_all", mailbox };
	}
	// The deployment's policy wins; otherwise a catch-all set by an applied setup.
	const stored = (await storedCatchAll(env.BUCKET))[domain];
	if (typeof stored === "string" && stored.endsWith("@" + domain)) return { kind: "catch_all", mailbox: stored.toLowerCase() };
	return { kind: "reject" };
}

// Records that an unknown address received mail, for the Create address list.
// Only the address, its domain, counts and times are kept: no sender, subject or body.
async function recordUnknownRecipient(env: Env, address: string, action: "rejected" | "catch_all") {
	const key = `unknown-recipients/${domainOf(address)}/${address}.json`;
	const now = new Date().toISOString();
	const previous = await env.BUCKET.get(key);
	const prior = previous ? ((await previous.json()) as { firstSeen?: string; count?: number }) : null;
	await env.BUCKET.put(key, JSON.stringify({
		address, domain: domainOf(address), action,
		firstSeen: prior?.firstSeen ?? now, lastSeen: now, count: (prior?.count ?? 0) + 1,
	}));
}

async function resolveRecipient(candidates: string[], allowedAddresses: string[], env: Env): Promise<Route> {
	if (!candidates.length) return { rejected: "no_recipient" };
	const domains = new Set(await allServedDomains(env));
	const onServedDomain = candidates.filter((a) => !domains.size || domains.has(domainOf(a)));
	if (!onServedDomain.length) return { rejected: "domain_not_served", address: candidates[0] };
	for (const address of onServedDomain) {
		if (allowedAddresses.length && !allowedAddresses.includes(address)) continue;
		if (await env.BUCKET.head(`mailboxes/${address}.json`)) return { mailboxId: address };
	}
	const address = onServedDomain[0];
	const policy = await unknownAddressPolicy(env, domainOf(address));
	if (policy.kind === "catch_all" && await env.BUCKET.head(`mailboxes/${policy.mailbox}.json`)) {
		await recordUnknownRecipient(env, address, "catch_all");
		return { mailboxId: policy.mailbox };
	}
	await recordUnknownRecipient(env, address, "rejected");
	return { rejected: "unknown_address", address };
}

const REJECT_TEXT: Record<RejectReason, (address?: string) => string> = {
	no_recipient: () => "No recipient address",
	domain_not_served: (address) => `Domain not served here: ${address ? domainOf(address) : "unknown"}`,
	unknown_address: (address) => `Address not found: ${address ?? "unknown"}`,
};

async function receiveEmail(event: IncomingEmailEvent, env: Env, ctx: ExecutionContext) {
	// A message over the limit is refused with a bounce instead of failing the
	// delivery (which made the platform retry and the sender wait).
	if (event.rawSize > MAX_EMAIL_SIZE && event.setReject) {
		event.setReject(`Message too large: the limit is ${MAX_EMAIL_SIZE / 1024 / 1024} MB`);
		return { rejected: "too_large" as const };
	}
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);


	const allowedAddresses = allowedAddressList(env);
	const allRecipients = (parsedEmail.to || []).map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	// SMTP envelope is authoritative for aliases, forwarded delivery and BCC.
  // MIME To is only a fallback for older synthetic events without an envelope.
  const envelopeTo = event.to?.toLowerCase().trim();
  const candidates = envelopeTo ? [envelopeTo] : allRecipients;
  const route = await resolveRecipient(candidates, allowedAddresses, env);
  if ("rejected" in route) {
    // A permanent SMTP rejection tells the sender; without setReject there is
    // no way to do that, so fail loudly instead of dropping the message.
    if (!event.setReject) throw new Error(`Cannot reject mail (${route.rejected}): the event has no setReject`);
    event.setReject(REJECT_TEXT[route.rejected](route.address));
    return { rejected: route.rejected };
  }
  const mailboxId = route.mailboxId;
  const rawHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', rawEmail))].map(b => b.toString(16).padStart(2, '0')).join('');
  const deliveryBytes = new TextEncoder().encode(JSON.stringify([mailboxId, event.from?.toLowerCase() || '', rawHash]));
  const messageId = 'incoming-' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', deliveryBytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
  if (await stub.hasReceivedEmail(messageId)) {
    await stub.redelivered(messageId);
    // Stored before, cut off before its copy: the retry sends the copy it still owes.
    const owed = await stub.forwardOwed(messageId).catch(() => false);
    if (owed) {
      const forwarded = await forwardCopy(event, env, mailboxId);
      if (forwarded !== "deferred") await stub.forwardSettled(messageId);
      await stub.flushIncomingEvents();
      return { mailboxId, emailId: messageId, inserted: false, ...(forwarded ? { forwarded } : {}) };
    }
    await stub.flushIncomingEvents();
    return { mailboxId, emailId: messageId, inserted: false };
  }

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const [index, att] of parsedEmail.attachments.entries()) {
			const attId = `${messageId}-${index}`;
			const filename = storedAttachmentName(att.filename);
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = await stub.findThreadByMessageIds([...(inReplyTo ? [inReplyTo] : []), ...emailReferences]) || emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;
	const sender = (parsedEmail.from?.address || "").toLowerCase();
	const verdict = await spamVerdict(env, stub, sender, parsedEmail.headers ?? []);

	const inserted = await stub.receiveEmailOnce({
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData, mailboxId, verdict.verdict === "spam" ? { spam: verdict.reason }
		: { screen: verdict.verdict === "screen", copyOwed: await wantsCopy(env, mailboxId) });

  // The mailbox's incoming-event journal hands the message to automation rules
  // and to the address's agent (AgentRegistryDO.enqueue) durably; nothing here
  // depends on waitUntil finishing.
  if (!inserted) return { mailboxId, emailId: messageId, inserted: false };
  if (verdict.verdict === "spam") {
    // Spam is kept here for 30 days and is not sent on as a copy (SP-1).
    console.log(JSON.stringify({ event: "spam_filtered", mailboxId, senderDomain: domainOf(sender || "@"), reason: verdict.reason }));
    return { mailboxId, emailId: messageId, inserted: true, spam: verdict.reason };
  }
  const forwarded = await forwardCopy(event, env, mailboxId);
  if (forwarded && forwarded !== "deferred") await stub.forwardSettled(messageId);
  return { mailboxId, emailId: messageId, inserted: true, ...(forwarded ? { forwarded } : {}) };
}

/** Whether this mailbox forwards a copy of what it receives (decided before storing, so it can be owed). */
async function wantsCopy(env: Env, mailboxId: string): Promise<boolean> {
	const settings = await readSettings(env.BUCKET, mailboxId).catch(() => null);
	const f = settings?.forwarding as { enabled?: unknown; email?: unknown } | undefined;
	return f?.enabled === true && typeof f.email === "string" && !!f.email.trim();
}

/**
 * The arriving message's spam verdict (SP-1). Any failure to read the lists or the
 * mailbox's sent mail degrades to "no rule decided": mail is never lost to the filter.
 */
async function spamVerdict(env: Env, stub: { knownCorrespondent(address: string): Promise<boolean> }, sender: string,
  headers: { key: string; value: string }[]): Promise<SpamVerdict> {
  try {
    const [lists, ownDomains, known] = await Promise.all([
      readSpamLists(env.BUCKET), allServedDomains(env), sender ? stub.knownCorrespondent(sender) : Promise.resolve(false),
    ]);
    return spamCheck({ sender, headers, ownDomains, lists, known });
  } catch (error) {
    // Not "clean": a failed look-up must not also switch off the model's check and the agents' wait
    // for it. "screen" still delivers to the inbox, so no mail is lost to the filter.
    console.warn(JSON.stringify({ event: "spam_check_failed", error: (error as Error).message }));
    return { verdict: "screen", reason: "" };
  }
}

/**
 * The mailbox's forwarding copy (settings.forwarding), sent after the message
 * is stored, so moving an address from "forward to Gmail" to this Worker keeps
 * the Gmail copy. A failed forward never fails the delivery — the mail is
 * already kept — but is recorded for the operator under delivery-issues/.
 */
async function forwardCopy(event: IncomingEmailEvent, env: Env, mailboxId: string): Promise<"sent" | "failed" | "deferred" | undefined> {
	const settings = await readSettings(env.BUCKET, mailboxId).catch(() => null);
	const forwarding = settings?.forwarding as { enabled?: unknown; email?: unknown } | undefined;
	const target = typeof forwarding?.email === "string" ? forwarding.email.trim().toLowerCase() : "";
	if (forwarding?.enabled !== true || !target) return undefined;
	let problem: string | null = null;
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) problem = "The forwarding address is not an email address";
	else if ((await allServedDomains(env)).includes(domainOf(target))) problem = "Forwarding to a domain served here would loop";
	else if (!event.forward && !event.deferForward) problem = "Forwarding is only possible for mail arriving through Email Routing";
	if (!problem && event.deferForward) { event.deferForward(target); return "deferred"; }
	if (!problem) {
		try {
			await event.forward!(target);
			await recordCopyOutcome(env, mailboxId, target, null);
			return "sent";
		} catch (error) {
			problem = `Email Routing refused the forward: ${(error as Error).message}`;
		}
	}
	await recordCopyOutcome(env, mailboxId, target, problem);
	return "failed";
}

/**
 * A copy's outcome, for the operator: a working forward retires the last recorded failure; a failed
 * one is kept under delivery-issues/. Recording never fails the delivery: the mail is already kept.
 */
async function recordCopyOutcome(env: Env, mailboxId: string, target: string, problem: string | null) {
	const key = `delivery-issues/${mailboxId}.json`;
	if (!problem) {
		if (await env.BUCKET.head(key).catch(() => null)) await env.BUCKET.delete(key).catch(() => undefined);
		return;
	}
	const previous = await env.BUCKET.get(key).then((o) => o?.json<{ count?: number }>()).catch(() => null);
	// Recording the failure must not fail the delivery: the mail is already kept.
	await env.BUCKET.put(key, JSON.stringify({ mailboxId, target, problem, count: (previous?.count ?? 0) + 1, lastAt: new Date().toISOString() }))
		.catch((error: unknown) => console.error(JSON.stringify({ event: "forward_issue_unrecorded", mailboxId, error: (error as Error).message })));
	console.warn(JSON.stringify({ event: "forward_copy_failed", mailboxId, target, problem }));
}

/** A relay's report on the copy it forwarded (MA-7): the copy is settled, and a failure is recorded. */
async function settleRelayedCopy(env: Env, mailboxId: string, emailId: string, target: string, ok: boolean, error?: string) {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await recordCopyOutcome(env, mailboxId, target, ok ? null : `The relay's forward was refused: ${error || "no reason given"}`);
	await stub.forwardSettled(emailId);
}

// The Email Routing entry point. A failure is logged and rethrown, so the
// platform records an error instead of a handled message; swallowing it here
// used to make a lost message look delivered.
/**
 * Durable Object failures a second attempt survives: the object was reset (a deploy restarting it,
 * a storage operation past its timeout) or briefly unreachable. Seen live on 2026-09-28, a minute
 * after a deploy: "Durable Object storage operation exceeded timeout which caused object to be
 * reset", and the message was never redelivered.
 */
const TRANSIENT_DO = /storage operation exceeded timeout|caused object to be reset|Durable Object reset|Network connection lost|Durable Object is overloaded|internal error; reference/i;

/**
 * `receiveEmail` with one retry after a transient Durable Object failure. Safe because a delivery is
 * stored once (its id is a hash of mailbox, sender and bytes), so a first attempt that got further
 * than it reported is found, not duplicated. The message is read once and replayed.
 */
async function receiveEmailResilient(event: IncomingEmailEvent, env: Env, ctx: ExecutionContext, retryDelayMs = 1000) {
	if (event.rawSize > MAX_EMAIL_SIZE) return receiveEmail(event, env, ctx);
	const bytes = await streamToArrayBuffer(event.raw, event.rawSize);
	const attempt = () => receiveEmail({ ...event, raw: new Response(bytes).body!, rawSize: bytes.byteLength }, env, ctx);
	try {
		return await attempt();
	} catch (error) {
		const message = (error as Error)?.message ?? "";
		if (!TRANSIENT_DO.test(message)) throw error;
		console.warn(JSON.stringify({ event: "incoming_retry", error: message.slice(0, 200) }));
		await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		return attempt();
	}
}

async function handleIncomingEmail(event: IncomingEmailEvent, env: Env, ctx: ExecutionContext) {
	try {
		return await receiveEmailResilient(event, env, ctx);
	} catch (e) {
		console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
		throw e;
	}
}

export { app, receiveEmail, receiveEmailResilient, handleIncomingEmail, settleRelayedCopy, MAX_EMAIL_SIZE };
export type { IncomingEmailEvent };
