// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { MailAttachment } from '../shared/mail/attachments';
import type { Env } from './types';
import { CloudflareApiError } from './routing/cloudflare-api';
import { CloudflareAccounts, readDomainAccounts, type AccountsEnv } from './routing/accounts';
/**
 * Email sending via Cloudflare Email Service binding.
 *
 * Uses the `send_email` Worker binding (`env.EMAIL.send()`) to send emails.
 *
 * See: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: MailAttachment[];

	headers?: Record<string, string>;
}

/**
 * Send an email using the Cloudflare Email Service binding.
 *
 * @param binding  - The `EMAIL` SendEmail binding from env
 * @param params   - Email parameters (to, from, subject, body, etc.)
 * @returns The send result with messageId
 * @throws On validation or delivery errors (error has `.code` property)
 */
export async function sendEmail(
	binding: SendEmail,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const message: Record<string, unknown> = {
		to: params.to,
		from: params.from,
		subject: params.subject,
	};

	if (params.html) message.html = params.html;
	if (params.text) message.text = params.text;
	if (params.cc) message.cc = params.cc;
	if (params.bcc) message.bcc = params.bcc;
	if (params.replyTo) message.replyTo = params.replyTo;

	if (params.headers && Object.keys(params.headers).length > 0) {
		message.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		message.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			type: att.type,
			disposition: att.disposition,
			...(att.contentId ? { contentId: att.contentId } : {}),
		}));
	}

	const result = await binding.send(message as any);
	return { messageId: result.messageId };
}

/** A transport error that carries the outbox's outcome code (workers/actions/outbox.ts). */
class SendRefused extends Error {
	constructor(message: string, readonly code: string) { super(message); }
}

type SendEnv = Pick<Env, "EMAIL" | "BUCKET"> & AccountsEnv;
const fromAddress = (from: SendEmailParams["from"]) => (typeof from === "string" ? from : from.email).toLowerCase();
const NOT_IN_THIS_ACCOUNT = new Set(["E_SENDER_DOMAIN_NOT_AVAILABLE", "E_SENDER_NOT_VERIFIED"]);

/**
 * Sends from any account the server has a token for (MA-8). A domain in the server's own account
 * goes through the `send_email` binding; a domain in another account through that account's Email
 * Sending REST API, since a binding sends only for its own account. Which account a domain is in is
 * the remembered one (config/domain-accounts.json); a binding that refuses the sender as not its own
 * is a definite refusal (nothing was sent), so the domain is then looked up and sent over REST.
 */
export async function sendFromAccount(env: SendEnv, params: SendEmailParams): Promise<{ messageId: string }> {
	const domain = fromAddress(params.from).split("@").pop() ?? "";
	const accounts = new CloudflareAccounts(env);
	const remembered = accounts.tokens.length ? (await readDomainAccounts(env.BUCKET))[domain] : undefined;
	if (remembered) {
		const server = await accounts.serverAccountId().catch(() => null);
		if (server && remembered !== server) return sendOverRest(accounts, remembered, params);
	}
	try {
		return await sendEmail(env.EMAIL, params);
	} catch (error) {
		const code = (error as { code?: unknown })?.code;
		if (typeof code !== "string" || !NOT_IN_THIS_ACCOUNT.has(code) || accounts.tokens.length < 2) throw error;
		const ctx = await accounts.zone(domain).catch(() => null);
		if (!ctx || ctx.server) throw error;
		return sendOverRest(accounts, ctx.accountId, params);
	}
}

async function sendOverRest(accounts: CloudflareAccounts, accountId: string, params: SendEmailParams): Promise<{ messageId: string }> {
	const api = await accounts.apiFor(accountId);
	if (!api) throw new SendRefused(`No Cloudflare token this server has reaches the account of ${fromAddress(params.from)}; connect it on Domains & addresses.`, "E_SENDER_DOMAIN_NOT_AVAILABLE");
	const address = (a: string | { email: string; name: string }) => (typeof a === "string" ? a : { address: a.email, name: a.name });
	const body: Record<string, unknown> = { from: address(params.from), to: params.to, subject: params.subject };
	if (params.html) body.html = params.html;
	if (params.text) body.text = params.text;
	if (params.cc) body.cc = params.cc;
	if (params.bcc) body.bcc = params.bcc;
	if (params.replyTo) body.reply_to = address(params.replyTo);
	if (params.headers && Object.keys(params.headers).length) body.headers = params.headers;
	if (params.attachments?.length)
		body.attachments = params.attachments.map((a) => ({ content: a.content, filename: a.filename, type: a.type, disposition: a.disposition,
			...(a.disposition === "inline" && a.contentId ? { content_id: a.contentId } : {}) }));
	try {
		const result = await api.call<{ message_id?: string }>(`/accounts/${accountId}/email/sending/send`, {
			method: "POST", body, what: "send from the domain (Email Sending: Edit)", timeoutMs: 60_000,
		});
		return { messageId: result?.message_id ?? "" };
	} catch (error) {
		// A 4xx is Cloudflare refusing before accepting anything: a definite failure. Anything else —
		// no answer, a timeout, a 5xx — may have been sent, so it stays unknown and is never retried.
		if (error instanceof CloudflareApiError && error.status >= 400 && error.status < 500)
			throw new SendRefused(error.message, error.status === 429 ? "E_RATE_LIMIT_EXCEEDED" : "E_REST_REFUSED");
		throw error;
	}
}
