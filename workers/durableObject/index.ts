// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { AttachmentValidationError, storedAttachmentName, validateAttachments, type MailAttachment } from '../../shared/mail/attachments';
import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import { IncomingJournal } from '../actions/incoming';
import type { IncomingMailEvent } from '../../shared/mail/incoming';
import { SqlOutboxStore, journal } from '../actions/outbox-store';
import { OutboxCoordinator, IdempotencyConflict, payloadHash } from '../actions/outbox';
import { sentProjection, transportParams, type PreparedMail } from '../actions/prepare-mail';
import { sendFromAccount } from '../email-sender';
import { SendEmailRequestSchema, type EmailFull } from '../lib/schemas';
import { validateSender, buildReferencesChain, buildQuotedReplyBlock } from '../lib/email-helpers';
import { verifyDraft } from '../lib/ai';
import type { SendMailCommand, SendMailResult, SendMailRequest } from '../../shared/mail/send';
import type { InboxReadOptions } from '../../shared/mail/inbox';
import { mailboxInboxQuery, mailboxInboxMessage, type MailboxInboxRow } from '../lib/inbox-query';
import { parseStoredHeaders } from '../agents/prefilter';
import { DISCARD_RETENTION_MS } from '../../shared/mail/discard';
import { listDrafts as listDraftRows, saveDraft as saveDraftRows, type DraftSql, type DraftSummary, type SaveDraftInput, type SaveDraftResult } from '../lib/mailbox-drafts';
import { htmlToText } from '../../shared/mail/text';
import { msg } from "../../shared/i18n";


/** Reject control characters before durable reservation and after reply-header derivation. */
function validateSendHeaders(request: SendMailRequest) {
  const values = [request.subject, typeof request.from === 'string' ? request.from : request.from.name,
    request.in_reply_to, ...(request.references || [])];
  if (values.some(value => value !== undefined && /[\x00-\x1f\x7f-\x9f]/.test(value))) {
    const error = new Error('Invalid send header');
    error.name = 'SenderValidationError';
    throw error;
  }
}

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

/** How long a stranger's message waits for its spam check before its agent runs anyway (B-30). */
const SPAM_HOLD_MS = 15 * 60_000;
/** Spam is kept this long, then deleted with its attachments (SP-5). */
export const SPAM_RETENTION_MS = 30 * 86_400_000;
/**
 * A Durable Object SQLite row holds at most 2 MB. A longer body goes to R2 whole and the row
 * keeps this many characters of it (search and snippets read the row); UTF-8 is at most 3 bytes a
 * character, so the row stays well under the limit (reliability audit H1).
 */
export const BODY_INLINE_CHARS = 400_000;
const HEADERS_INLINE_CHARS = 200_000;

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	spam_reason?: string | null;
	spam_at?: string | null;
	discard_reason?: string | null;
	discarded_at?: string | null;
	body_key?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;
  private outbox: SqlOutboxStore;
  private sender: OutboxCoordinator;
  private incoming: IncomingJournal;
  private incomingDelivery?: Promise<void>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
    this.outbox = new SqlOutboxStore(this.ctx.storage.sql, fn => this.ctx.storage.transactionSync(fn));
    this.outbox.recoverInterrupted();
    this.incoming = new IncomingJournal(this.ctx.storage.sql);
    this.sender = new OutboxCoordinator(this.outbox, {
      beforeEffect: () => this.ctx.storage.sync(),
      transport: (payload: PreparedMail) => sendFromAccount(this.env, transportParams(payload)),
      project: async (payload: PreparedMail, row) => {
        const attachments: AttachmentData[] = [];
        for (const [index, attachment] of (payload.request.attachments || []).entries()) {
          const id = `${row.id}-${index}`;
          const filename = storedAttachmentName(attachment.filename);
          const binary = atob(attachment.content);
          await this.env.BUCKET.put(`attachments/${row.id}/${id}/${filename}`, Uint8Array.from(binary, c => c.charCodeAt(0)));
          attachments.push({ id, email_id: row.id, filename, mimetype: attachment.type,
            size: binary.length, content_id: attachment.contentId || null, disposition: attachment.disposition });
        }
        // Projection can safely run again after an R2 write or a process interruption.
        const projected = await this.spillBody(sentProjection(payload, row));
        this.ctx.storage.transactionSync(() => {
          if (!this.db.select({ id: schema.emails.id }).from(schema.emails).where(eq(schema.emails.id, row.id)).get()) {
            this.db.insert(schema.emails).values({ ...projected, folder_id: Folders.SENT, read: 1 }).run();
            if (attachments.length) this.db.insert(schema.attachments).values(attachments).run();
          }
          if (payload.request.thread_id) this.ctx.storage.sql.exec('UPDATE emails SET read = 1 WHERE thread_id = ?', payload.request.thread_id);
        });
      },
    });
    if (this.outbox.recoverable().length || this.incoming.waiting()) {
      this.ctx.blockConcurrencyWhile(async () => {
        if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
      });
    }
	}

  /** Sole outgoing effect boundary for HTTP, MCP and background automation. */
  async sendMail(command: SendMailCommand): Promise<SendMailResult> {
    try {
      const mailboxId = command.mailboxId.toLowerCase();
      const request = SendEmailRequestSchema.parse(command.request);
      if (request.attachments !== undefined) request.attachments = validateAttachments(request.attachments);
      validateSender(request.to, request.from, mailboxId);
      validateSendHeaders(request);
      const key = command.idempotencyKey ?? crypto.randomUUID();
      if (typeof key !== 'string' || !key || key.length > 200 || /[\r\n]/.test(key)) return { error: msg('Invalid idempotency key'), code: 'INVALID_REQUEST' };
      const kind = command.kind || 'send';
      if (!['send', 'reply', 'forward'].includes(kind)) return { error: msg('Invalid send operation'), code: 'INVALID_REQUEST' };
      const identity = { mailboxId, request: structuredClone(request), kind, originalEmailId: command.originalEmailId, verifyContent: !!command.verifyContent };
      const existing = this.outbox.find(mailboxId, key, await payloadHash(identity));
      // Arm before creating durable pending state. A crash after this point leaves
      // an alarm that can drive pending work or repair an accepted projection.
      await this.armRecovery();
      if (existing) return await this.sender.process(existing.id);
      if (kind !== 'send') {
        let original = command.originalEmailId ? await this.getEmail(command.originalEmailId) : null;
        if (!original) return { error: msg('Original email not found'), code: 'NOT_FOUND' };
        if (original.folder_id === Folders.DRAFT && original.in_reply_to) original = await this.getEmail(original.in_reply_to) || original;
        if (kind === 'reply') {
          const chain = buildReferencesChain(original as EmailFull);
          // Never thread against an internal UUID if a sent provider receipt was opaque.
          if (!original.message_id && original.folder_id === Folders.SENT) return { error: msg('Provider RFC Message-ID unavailable for this reply'), code: 'INVALID_REQUEST' };
          if (chain.originalMsgId) { request.in_reply_to = chain.originalMsgId; request.references = chain.references; }
          else { delete request.in_reply_to; if (chain.references.length) request.references = chain.references; else delete request.references; }
          request.thread_id = chain.threadId;
          if (command.verifyContent) request.html = (request.html || '') + buildQuotedReplyBlock({ date: original.date || undefined, sender: original.sender || undefined, body: original.body || undefined });
        } else {
          delete request.in_reply_to; delete request.references; delete request.thread_id;
        }
      }
      if (command.verifyContent && request.html) {
        const verified = await verifyDraft(this.env.AI, request.html);
        if (!verified) return { error: msg('Draft verification failed'), code: 'INVALID_REQUEST' };
        request.html = verified;
      }
      await this.armRecovery();
      validateSendHeaders(request);
      return await this.sender.submit(mailboxId, key, { request }, identity);
    } catch (error) {
      if (error instanceof AttachmentValidationError) return { error: error.code, code: 'INVALID_REQUEST' };
      if (error instanceof IdempotencyConflict) return { error: error.message, code: 'IDEMPOTENCY_CONFLICT' };
      if (error instanceof Error && (error.name === 'ZodError' || error.name === 'SenderValidationError')) return { error: msg('Invalid send request or sender'), code: 'INVALID_REQUEST' };
      throw error;
    }
  }
  async getOutboxAction(mailboxId: string, id: string) {
    const row = this.outbox.get(id);
    return row?.mailbox_id === mailboxId.toLowerCase() ? journal(row) : null;
  }
  async listOutbox(mailboxId: string, limit = 50, offset = 0) {
    return this.outbox.list(mailboxId.toLowerCase(), limit, offset);
  }
  private async armRecovery() {
    const next = Date.now() + 60000;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
  async alarm() {
    // An in-flight send on this live instance is never retried. Constructor
    // recovery marks interrupted sends unknown before any alarm is processed.
    await this.flushIncomingEvents();
    const rows = this.outbox.recoverable();
    if (rows.length) await this.armRecovery();
    for (const row of rows) await this.sender.process(row.id);
    // Spam and Discarded past their 30 days go; the next wake-up is set for the oldest left.
    await this.purgeSpam();
    await this.purgeDiscarded();
  }

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

  /** Unread messages in Inbox, for the sidebar counts. */
  async countUnreadInbox(): Promise<number> {
    return Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM emails WHERE folder_id = 'inbox' AND read = 0").one().n);
  }

  /** These messages in the feed's shape, outside trash, spam and drafts (a category's view, CAT-5). */
  async inboxMessagesByIds(mailboxId: string, ids: string[], ownDomains: string[] = []) {
    const accountId = "cloudflare:" + mailboxId;
    const wanted = [...new Set(ids)].slice(0, 100);
    if (!wanted.length) return [];
    return this.ctx.storage.sql.exec<MailboxInboxRow>(
      `SELECT id, subject, sender, recipient, date, read, starred, thread_id, folder_id, raw_headers, message_id, substr(body,1,2000) AS snippet,
         coalesce(cast(round((julianday(date)-2440587.5)*86400000) AS INTEGER),0) AS timestamp
       FROM emails WHERE id IN (${wanted.map(() => "?").join(",")}) AND folder_id NOT IN ('trash', 'spam', 'draft', 'discarded')`, ...wanted)
      .toArray().map(row => mailboxInboxMessage(accountId, row, ownDomains));
  }

  async listInboxMessages(mailboxId: string, options: InboxReadOptions) {
    const accountId = "cloudflare:" + mailboxId;
    const query = mailboxInboxQuery(accountId, options);
    return this.ctx.storage.sql.exec<MailboxInboxRow>(query.sql, ...query.parameters).toArray()
      .map(row => mailboxInboxMessage(accountId, row, options.ownDomains ?? []));
  }

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = 'draft' THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				-- Folder ids, not names: the seeded names are "Sent" and "Drafts", so the
				-- name lookups returned NULL and both badges were always false.
				CASE WHEN lmc.folder_id NOT IN ('sent', 'draft')
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		// A body kept in R2 is read whole; if it cannot be read the row's start is shown, said so.
		if (email.body_key) {
			const object = await (this.env as Env).BUCKET.get(email.body_key).catch(() => null);
			email.body = object ? await object.text() : `${email.body ?? ""}\n\n[The rest of this message could not be read right now. Try again.]`;
		}

		// Where the body is kept is the store's business, not the reader's.
		const { body_key: _key, ...shown } = email as typeof email & { body_key?: string | null };
		return {
			...shown,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		// One bound parameter regardless of thread length: SQLite in Durable
		// Objects limits bound parameters, so an IN list failed on long threads.
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE thread_id = ?1)`,
				threadId,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		// A body kept in R2 is read whole, as getEmail does; the thread view used to show only the
		// row's first part of a long message, with no sign it was cut.
		const bodies = await Promise.all(emailRows.map(async (email) => {
			if (!email.body_key) return email.body;
			const object = await (this.env as Env).BUCKET.get(email.body_key).catch(() => null);
			return object ? await object.text() : `${email.body ?? ""}\n\n[The rest of this message could not be read right now. Try again.]`;
		}));
		return emailRows.map(({ body_key: _key, ...email }, i) => ({
			...email,
			body: bodies[i],
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id, body_key: schema.emails.body_key })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();
		if (email.body_key) await (this.env as Env).BUCKET.delete(email.body_key).catch((error: unknown) =>
			console.warn(JSON.stringify({ event: "body_delete_failed", error: (error as Error).message })));

		return emailAttachments;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Drafts on the server (B-52, workers/lib/mailbox-drafts.ts) ──

	async listDrafts(limit = 200): Promise<DraftSummary[]> {
		return listDraftRows(this.ctx.storage.sql as unknown as DraftSql, limit);
	}

	/**
	 * Creates or changes one draft in place. A body too long for a row goes to R2 under a key of
	 * its own for this save, so a refused save never touches the stored draft's body; whatever
	 * this save made unused (removed files, the previous body) is deleted after it is stored.
	 */
	async saveDraft(input: Omit<SaveDraftInput, "body" | "bodyKey" | "now"> & { body: string }): Promise<SaveDraftResult> {
		const env = this.env as Env;
		let body = input.body, bodyKey: string | null = null;
		if (body.length > BODY_INLINE_CHARS) {
			bodyKey = `bodies/${input.id}.${crypto.randomUUID()}.html`;
			await env.BUCKET.put(bodyKey, body, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
			body = body.slice(0, BODY_INLINE_CHARS);
		}
		const result = this.ctx.storage.transactionSync(() => saveDraftRows(this.ctx.storage.sql as unknown as DraftSql,
			{ ...input, body, bodyKey, now: new Date().toISOString() }));
		const unused = result.ok
			? [...result.removed.map((a) => `attachments/${input.id}/${a.id}/${a.filename}`), ...(result.oldBodyKey ? [result.oldBodyKey] : [])]
			: bodyKey ? [bodyKey] : [];
		if (unused.length) await env.BUCKET.delete(unused).catch((error: unknown) =>
			console.warn(JSON.stringify({ event: "draft_cleanup_failed", error: (error as Error).message })));
		return result;
	}

	/** Deletes a draft (only a draft): its row, files' rows and kept body; the caller removes the files' bytes. */
	async deleteDraft(id: string) {
		const row = this.ctx.storage.sql.exec("SELECT folder_id FROM emails WHERE id = ?", id).toArray()[0];
		if (!row || row.folder_id !== Folders.DRAFT) return null;
		return this.deleteEmail(id);
	}

	/**
	 * Sends a draft as it is (no signature or quote added: the draft already holds what the person
	 * or agent wrote) and removes it once the transport accepted it. A draft that answers a message
	 * goes out as a reply in its conversation. A retry with the same key after the draft is gone
	 * answers the first attempt's outcome; a key used for different content is a conflict.
	 */
	async sendDraft(command: { mailboxId: string; draftId: string; idempotencyKey: string; from: string | { email: string; name: string }; expectedRevision?: number }): Promise<SendMailResult> {
		const mailboxId = command.mailboxId.toLowerCase();
		const draft = await this.getEmail(command.draftId);
		if (!draft || draft.folder_id !== Folders.DRAFT) {
			const prior = this.ctx.storage.sql.exec("SELECT id FROM outbox WHERE mailbox_id = ? AND idempotency_key = ?", mailboxId, command.idempotencyKey).toArray()[0];
			if (prior) return this.sender.process(String(prior.id));
			return { error: msg("Draft not found: it was sent or deleted"), code: "NOT_FOUND" };
		}
		const revision = Number(draft.draft_revision ?? 1);
		if (command.expectedRevision !== undefined && command.expectedRevision !== revision)
			return { error: msg("The draft changed since revision {expected} (now {revision}); read it again before sending", { expected: command.expectedRevision, revision }), code: "DRAFT_CONFLICT" };
		const split = (value: string | null | undefined) => (value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
		const to = split(draft.recipient);
		if (!to.length) return { error: msg("The draft has no recipient"), code: "INVALID_REQUEST" };
		const files: MailAttachment[] = [];
		for (const a of draft.attachments ?? []) {
			const object = await (this.env as Env).BUCKET.get(`attachments/${draft.id}/${a.id}/${a.filename}`);
			if (!object) return { error: msg("The draft's file {file} could not be read; remove it and add it again", { file: a.filename }), code: "INVALID_REQUEST" };
			const bytes = new Uint8Array(await object.arrayBuffer());
			let binary = "";
			for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			files.push({ content: btoa(binary), filename: a.filename, type: a.mimetype, disposition: (a.disposition === "inline" ? "inline" : "attachment") as "inline" | "attachment",
				...(a.content_id ? { contentId: a.content_id } : {}) });
		}
		const html = draft.body ?? "";
		const cc = split(draft.cc), bcc = split(draft.bcc);
		const result = await this.sendMail({
			mailboxId, idempotencyKey: command.idempotencyKey, kind: draft.in_reply_to ? "reply" : "send",
			originalEmailId: draft.in_reply_to ? draft.id : undefined,
			request: { to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), from: command.from, subject: draft.subject || "(no subject)",
				html, text: htmlToText(html) || " ", ...(files.length ? { attachments: files } : {}) },
		});
		if (!("error" in result) && result.status === "accepted") {
			const removed = await this.deleteDraft(draft.id);
			if (removed?.length) await (this.env as Env).BUCKET.delete(removed.map((a: { id: string; filename: string }) => `attachments/${draft.id}/${a.id}/${a.filename}`))
				.catch((error: unknown) => console.warn(JSON.stringify({ event: "draft_cleanup_failed", error: (error as Error).message })));
		}
		return result;
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		// Its messages move to Inbox first: the emails table cascades on folder
		// delete, so deleting a folder used to delete every message in it.
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("UPDATE emails SET folder_id = ? WHERE folder_id = ?", Folders.INBOX, id);
			this.db.delete(schema.folders).where(eq(schema.folders.id, id)).run();
		});

		return true;
	}

	/**
	 * Removes every message, folder, receipt and journal of this mailbox and
	 * returns the R2 keys of its attachments for the caller to delete. Used
	 * when a mailbox is deleted, so recreating the address starts empty.
	 */
	async purge(): Promise<string[]> {
		const keys = [
			...this.ctx.storage.sql.exec<{ email_id: string; id: string; filename: string }>(
				"SELECT email_id, id, filename FROM attachments").toArray()
				.map((a) => `attachments/${a.email_id}/${a.id}/${a.filename}`),
			...this.ctx.storage.sql.exec<{ body_key: string }>("SELECT body_key FROM emails WHERE body_key IS NOT NULL").toArray().map((r) => r.body_key),
		];
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		// This live instance keeps serving the address: rebuild an empty schema.
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
		return keys;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		// Moved into Spam or Discarded by hand: say so; moved out: the reason no longer applies.
		const now = new Date().toISOString();
		const moved = this.db
			.update(schema.emails)
			.set({ folder_id: folderId, spam_reason: folderId === Folders.SPAM ? msg("You moved it to Spam") : null,
				spam_at: folderId === Folders.SPAM ? now : null,
				discard_reason: folderId === Folders.DISCARDED ? msg("You moved it to Discarded") : null,
				discarded_at: folderId === Folders.DISCARDED ? now : null })
			.where(eq(schema.emails.id, id))
			.returning({ id: schema.emails.id })
			.get();

		if (moved && folderId === Folders.SPAM) await this.armSpamPurge();
		if (moved && folderId === Folders.DISCARDED) await this.armDiscardPurge();
		return !!moved;
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		// % and _ typed by the user are literal characters, not wildcards.
		const like = (value: string) => `%${value.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
		const E = " ESCAPE '\\'";
		if (query) {
			const p = addParam(like(query));
			conditions.push(`(${prefix}subject LIKE ${p}${E} OR ${prefix}body LIKE ${p}${E} OR ${prefix}sender LIKE ${p}${E} OR ${prefix}recipient LIKE ${p}${E} OR ${prefix}cc LIKE ${p}${E} OR ${prefix}bcc LIKE ${p}${E})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(like(from)); conditions.push(`${prefix}sender LIKE ${p}${E}`); }
		if (to) { const p = addParam(like(to)); conditions.push(`(${prefix}recipient LIKE ${p}${E} OR ${prefix}cc LIKE ${p}${E} OR ${prefix}bcc LIKE ${p}${E})`); }
		if (subject) { const p = addParam(like(subject)); conditions.push(`${prefix}subject LIKE ${p}${E}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment !== undefined) { conditions.push(`${prefix}id ${has_attachment ? "IN" : "NOT IN"} (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

  async findThreadByMessageIds(messageIds: string[]): Promise<string | null> {
    const ids = messageIds.filter(Boolean).slice(-100);
    if (!ids.length) return null;
    const row = [...this.ctx.storage.sql.exec(`SELECT COALESCE(thread_id, id) AS thread_id FROM emails WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY date DESC LIMIT 1`, ...ids)][0];
    return row ? String(row.thread_id) : null;
  }

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * The outbox's own send budget (20 per hour, 100 per day per mailbox), read
	 * without sending. Returns null when a send may be attempted, or the reason.
	 * The outbox enforces the same numbers at claim time; this lets an agent
	 * choose a draft instead of burning a send on a certain rejection.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const now = Date.now();
		const count = (since: number) => Number([...this.ctx.storage.sql.exec(
			"SELECT COUNT(*) AS n FROM outbox WHERE attempts > 0 AND attempted_at >= ?", since)][0].n);
		if (count(now - 3_600_000) >= 20) return msg("Rate limit exceeded: max {n} emails per hour per mailbox", { n: 20 });
		if (count(now - 86_400_000) >= 100) return msg("Rate limit exceeded: max {n} emails per day per mailbox", { n: 100 });
		return null;
	}

	/** The newest messages of a thread with bodies, oldest first, bounded for model context. */
	async recentThreadEmails(threadId: string, limit = 20) {
		const rows = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
			"SELECT id, sender, recipient, date, folder_id, body FROM emails WHERE thread_id = ? ORDER BY date DESC LIMIT ?",
			threadId, Math.max(1, Math.min(50, limit))).toArray();
		return rows.reverse();
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

  async createEmail(folder: string, email: EmailData, attachments: AttachmentData[]) {
    return this.ctx.storage.transactionSync(() => this.insertEmail(folder, email, attachments));
  }

  async hasReceivedEmail(deliveryId: string) {
    return this.incoming.has(deliveryId);
  }

  /** A redelivery of a stored message: its own journal event, if still owed, is due now (no backoff). */
  async redelivered(deliveryId: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE incoming_receipts SET next_at = 0 WHERE delivery_id = ? AND automation_status = 'pending'", deliveryId);
  }

  /** Whether the forwarding copy of this delivery is still to be sent (it was stored, then cut off). */
  async forwardOwed(deliveryId: string): Promise<boolean> {
    return this.ctx.storage.sql.exec("SELECT 1 FROM incoming_receipts WHERE delivery_id = ? AND forward_status = 'owed'", deliveryId).toArray().length > 0;
  }
  /** The copy was sent or its failure recorded: a later redelivery does not send it again. */
  async forwardSettled(deliveryId: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE incoming_receipts SET forward_status = 'settled' WHERE delivery_id = ?", deliveryId);
  }

  /**
   * Stores an arriving message once. `spam` (SP-1) puts it in Spam with its reason,
   * where no rule, agent or category acts on it; `screen` lets the model read it for
   * spam later (SP-2).
   */
  async receiveEmailOnce(email: EmailData, attachments: AttachmentData[], mailboxId: string,
    verdict: { spam?: string | null; discard?: string | null; screen?: boolean; copyOwed?: boolean } = {}) {
    // The alarm is durable before the event; inbox insertion and automation intent
    // share a transaction, so a crash cannot create an unqueued new message.
    await this.armRecovery();
    email = await this.spillBody(email);
    const spam = verdict.spam?.trim() ? verdict.spam.trim().slice(0, 300) : null;
    // A discard rule matched (and spam did not): it goes to Discarded, read, as if deleted.
    const discard = !spam && verdict.discard?.trim() ? verdict.discard.trim().slice(0, 300) : null;
    const now = new Date().toISOString();
    const inserted = this.ctx.storage.transactionSync(() => {
      if (this.incoming.has(email.id)) return false;
      this.insertEmail(spam ? Folders.SPAM : discard ? Folders.DISCARDED : Folders.INBOX, { ...email, spam_reason: spam, spam_at: spam ? now : null,
        discard_reason: discard, discarded_at: discard ? now : null, ...(discard ? { read: true } : {}) }, attachments);
      this.incoming.record(mailboxId, { id: email.id, sender: email.sender, subject: email.subject,
        body: email.body, date: email.date, thread_id: email.thread_id,
        ...(spam ? { spam: true } : discard ? { discarded: true } : verdict.screen ? { screen: true } : {}) });
      if (verdict.copyOwed && !spam && !discard) this.ctx.storage.sql.exec("UPDATE incoming_receipts SET forward_status = 'owed' WHERE delivery_id = ?", email.id);
      return true;
    });
    if (inserted && spam) await this.armSpamPurge();
    if (inserted && discard) await this.armDiscardPurge();
    await this.flushIncomingEvents();
    return inserted;
  }

  /**
   * A body or header list too large for a row: the whole body goes to R2 at
   * `bodies/<id>.html` first (idempotent, so a retried delivery writes the same key),
   * the row keeps its start and the key.
   */
  private async spillBody<T extends { id: string; body: string; raw_headers?: string | null }>(email: T): Promise<T & { body_key?: string | null }> {
    let next: T & { body_key?: string | null } = email;
    if ((email.raw_headers?.length ?? 0) > HEADERS_INLINE_CHARS) next = { ...next, raw_headers: null };
    if (email.body.length <= BODY_INLINE_CHARS) return next;
    const key = `bodies/${email.id}.html`;
    await (this.env as Env).BUCKET.put(key, email.body, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    return { ...next, body: email.body.slice(0, BODY_INLINE_CHARS), body_key: key };
  }

  // ── Spam (SP-1…SP-5) ───────────────────────────────────────────

  /** Moves messages to Spam with a reason; returns the ids that moved. */
  async markSpam(ids: string[], reason: string): Promise<string[]> {
    const moved: string[] = [];
    for (const id of ids.slice(0, 200)) {
      // spam_at is kept when it is already in Spam: a second report does not restart its 30 days.
      const row = this.ctx.storage.sql.exec(`UPDATE emails SET spam_reason = ?, spam_at = CASE WHEN folder_id = 'spam' AND spam_at IS NOT NULL THEN spam_at ELSE ? END,
        folder_id = 'spam' WHERE id = ? AND folder_id NOT IN ('sent', 'draft') RETURNING id`, reason.slice(0, 300), new Date().toISOString(), id).toArray();
      if (row.length) moved.push(id);
    }
    if (moved.length) await this.armSpamPurge();
    return moved;
  }

  /** Moves messages out of Spam back to the inbox; returns the ids that moved. */
  async markNotSpam(ids: string[]): Promise<string[]> {
    const moved: string[] = [];
    for (const id of ids.slice(0, 200)) {
      const row = this.ctx.storage.sql.exec("UPDATE emails SET folder_id = 'inbox', spam_reason = NULL, spam_at = NULL WHERE id = ? AND folder_id = 'spam' RETURNING id", id).toArray();
      if (row.length) moved.push(id);
    }
    return moved;
  }

  // ── Discarded (operator, 2026-10-06) ───────────────────────────

  /**
   * Discards messages: each moves to Discarded, read, with why. Sent mail and drafts stay. A message
   * already in Discarded keeps its date there (a second discard does not restart its 30 days).
   * Returns each id that moved with the folder it left and whether it was unread, for Undo.
   */
  async discardMessages(ids: string[], reason: string): Promise<{ id: string; from: string; unread: boolean }[]> {
    const moved: { id: string; from: string; unread: boolean }[] = [];
    const now = new Date().toISOString();
    for (const id of ids.slice(0, 200)) {
      const before = this.ctx.storage.sql.exec<{ folder_id: string; read: number }>("SELECT folder_id, read FROM emails WHERE id = ? AND folder_id NOT IN ('sent', 'draft')", id).toArray()[0];
      if (!before) continue;
      this.ctx.storage.sql.exec(`UPDATE emails SET folder_id = 'discarded', read = 1, discard_reason = ?, spam_reason = NULL, spam_at = NULL,
        discarded_at = CASE WHEN folder_id = 'discarded' AND discarded_at IS NOT NULL THEN discarded_at ELSE ? END WHERE id = ?`, reason.slice(0, 300), now, id);
      moved.push({ id, from: before.folder_id, unread: !before.read });
    }
    if (moved.length) await this.armDiscardPurge();
    return moved;
  }

  /** Not discarded: messages back from Discarded to the inbox (unread again when `read` is false); returns the ids that moved. */
  async restoreDiscarded(ids: string[], read?: boolean): Promise<string[]> {
    const moved: string[] = [];
    for (const id of ids.slice(0, 200)) {
      const row = this.ctx.storage.sql.exec(`UPDATE emails SET folder_id = 'inbox', discard_reason = NULL, discarded_at = NULL${read === undefined ? "" : ", read = " + (read ? 1 : 0)}
        WHERE id = ? AND folder_id = 'discarded' RETURNING id`, id).toArray();
      if (row.length) moved.push(id);
    }
    return moved;
  }

  /** What a message says about itself for a discard rule: its sender, headers, conversation, and whether this address wrote to the sender. */
  async discardFacts(id: string): Promise<{ sender: string; subject: string; headers: { key: string; value: string }[]; threadId: string | null; folder: string; known: boolean; inThread: boolean } | null> {
    const row = this.ctx.storage.sql.exec<{ sender: string | null; subject: string | null; raw_headers: string | null; thread_id: string | null; folder_id: string }>(
      "SELECT sender, subject, raw_headers, thread_id, folder_id FROM emails WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    const sender = (row.sender ?? "").toLowerCase();
    return { sender, subject: row.subject ?? "", headers: parseStoredHeaders(row.raw_headers), threadId: row.thread_id, folder: row.folder_id,
      known: sender ? await this.knownCorrespondent(sender) : false, inThread: row.thread_id ? await this.threadHasSent(row.thread_id) : false };
  }

  /** Whether this address took part in the conversation (it sent a message in it). */
  async threadHasSent(threadId: string): Promise<boolean> {
    if (!threadId) return false;
    return this.ctx.storage.sql.exec("SELECT 1 FROM emails WHERE thread_id = ? AND folder_id = 'sent' LIMIT 1", threadId).toArray().length > 0;
  }

  /**
   * Deletes what has been in Discarded longer than DISCARD_RETENTION_MS (or all of it with `all`),
   * with the attachments' bytes; the clock is `discarded_at`, never the arrival. Runs on the alarm.
   */
  async purgeDiscarded(options: { all?: boolean; now?: number } = {}): Promise<number> {
    const cutoff = new Date((options.now ?? Date.now()) - DISCARD_RETENTION_MS).toISOString();
    const rows = options.all
      ? this.ctx.storage.sql.exec("SELECT id FROM emails WHERE folder_id = 'discarded' LIMIT 500").toArray()
      : this.ctx.storage.sql.exec("SELECT id FROM emails WHERE folder_id = 'discarded' AND discarded_at IS NOT NULL AND discarded_at < ? LIMIT 500", cutoff).toArray();
    const bucket = (this.env as Env).BUCKET;
    let deleted = 0;
    for (const { id } of rows) {
      const attachments = await this.deleteEmail(String(id));
      if (attachments === null) continue;
      deleted++;
      if (attachments.length && bucket)
        await bucket.delete(attachments.map((a) => `attachments/${id}/${a.id}/${a.filename}`)).catch((error: unknown) =>
          console.warn(JSON.stringify({ event: "discarded_attachment_delete_failed", error: (error as Error).message })));
    }
    if (deleted) console.log(JSON.stringify({ event: "discarded_purged", count: deleted, all: !!options.all }));
    if (rows.length === 500) await this.ctx.storage.setAlarm(Date.now() + 1000);
    else await this.armDiscardPurge();
    return deleted;
  }

  async countDiscarded(): Promise<number> {
    return Number((this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM emails WHERE folder_id = 'discarded'").one() as { n: number }).n);
  }

  /** Wakes the mailbox when its oldest Discarded mail turns 30 days old. */
  private async armDiscardPurge() {
    const oldest = this.ctx.storage.sql.exec("SELECT MIN(discarded_at) AS d FROM emails WHERE folder_id = 'discarded'").one() as { d: string | null };
    if (!oldest.d) return;
    const due = Math.max(Date.now() + 1000, Date.parse(oldest.d) + DISCARD_RETENTION_MS + 60_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > due) await this.ctx.storage.setAlarm(due);
  }

  /** Whether this address has sent mail to `address` (To, Cc or Bcc). */
  async knownCorrespondent(address: string): Promise<boolean> {
    const needle = address.trim().toLowerCase();
    if (!needle.includes("@")) return false;
    return this.ctx.storage.sql.exec(
      // The whole address, not a part of one: x@example.test is not known from ax@example.test or
      // x@example.test.au. Lists are comma-joined; an entry may also be "Name <address>".
      "SELECT 1 FROM emails WHERE folder_id = 'sent' AND (" +
      "instr(',' || replace(lower(coalesce(recipient,'') || ',' || coalesce(cc,'') || ',' || coalesce(bcc,'')), ' ', '') || ',', ',' || ?1 || ',') > 0 OR " +
      "instr(lower(coalesce(recipient,'') || ',' || coalesce(cc,'') || ',' || coalesce(bcc,'')), '<' || ?1 || '>') > 0) LIMIT 1",
      needle).toArray().length > 0;
  }

  /**
   * Deletes what has been in Spam longer than `SPAM_RETENTION_MS` (or all of it with
   * `all`), with the attachments' bytes; returns how many went. The clock is `spam_at`,
   * when it entered Spam, never its arrival. Runs on the mailbox's alarm (SP-5).
   */
  async purgeSpam(options: { all?: boolean; now?: number } = {}): Promise<number> {
    const cutoff = new Date((options.now ?? Date.now()) - SPAM_RETENTION_MS).toISOString();
    const rows = options.all
      ? this.ctx.storage.sql.exec("SELECT id FROM emails WHERE folder_id = 'spam' LIMIT 500").toArray()
      : this.ctx.storage.sql.exec("SELECT id FROM emails WHERE folder_id = 'spam' AND spam_at IS NOT NULL AND spam_at < ? LIMIT 500", cutoff).toArray();
    const bucket = (this.env as Env).BUCKET;
    let deleted = 0;
    for (const { id } of rows) {
      const attachments = await this.deleteEmail(String(id));
      if (attachments === null) continue;
      deleted++;
      if (attachments.length && bucket)
        await bucket.delete(attachments.map((a) => `attachments/${id}/${a.id}/${a.filename}`)).catch((error: unknown) =>
          console.warn(JSON.stringify({ event: "spam_attachment_delete_failed", error: (error as Error).message })));
    }
    if (deleted) console.log(JSON.stringify({ event: "spam_purged", count: deleted, all: !!options.all }));
    if (rows.length === 500) await this.ctx.storage.setAlarm(Date.now() + 1000);
    else await this.armSpamPurge();
    return deleted;
  }

  async countSpam(): Promise<number> {
    return Number((this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM emails WHERE folder_id = 'spam'").one() as { n: number }).n);
  }

  /** Wakes the mailbox when its oldest Spam turns 30 days old. */
  private async armSpamPurge() {
    const oldest = this.ctx.storage.sql.exec("SELECT MIN(spam_at) AS d FROM emails WHERE folder_id = 'spam'").one() as { d: string | null };
    if (!oldest.d) return;
    const due = Math.max(Date.now() + 1000, Date.parse(oldest.d) + SPAM_RETENTION_MS + 60_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > due) await this.ctx.storage.setAlarm(due);
  }

  async flushIncomingEvents(): Promise<void> {
    if (this.incomingDelivery) return this.incomingDelivery;
    this.incomingDelivery = this.drainIncomingEvents();
    try { await this.incomingDelivery; } finally { this.incomingDelivery = undefined; }
  }
  private async drainIncomingEvents() {
    // Every installed consumer must accept an event before it is acknowledged.
    // Both are idempotent by message id, so redelivery after a partial failure
    // is safe. A missing binding (rolling integration, tests) is not a consumer;
    // with no consumer at all every pending event is preserved.
    const env = this.env as Env & {
      AUTOMATIONS?: { getByName(name: string): { ingest(mailboxId: string, event: IncomingMailEvent): Promise<unknown> } };
      AGENT_REGISTRY?: { getByName(name: string): { enqueue(mailboxId: string, emailId: string, options?: { holdMs?: number }): Promise<void> } };
      CATEGORIES?: { getByName(name: string): { ingest(account: { id: string; email: string }, event: IncomingMailEvent): Promise<void> } };
    };
    if (!env.AUTOMATIONS && !env.AGENT_REGISTRY && !env.CATEGORIES) return;
    const pending = this.incoming.pending();
    if (this.incoming.waiting()) await this.armRecovery();
    for (const item of pending) {
      try {
        this.incoming.attempted(item.delivery_id);
        const event = this.incoming.event(item.delivery_id);
        // Spam, and mail a discard rule took on arrival, reach no rule, agent or category (SP-1).
        if (!event.spam && !event.discarded) {
          if (env.AUTOMATIONS) await env.AUTOMATIONS.getByName(item.mailbox_id).ingest(item.mailbox_id, event);
          // A stranger's message waits for its spam check before its agent answers (B-30).
          if (env.AGENT_REGISTRY) await env.AGENT_REGISTRY.getByName("workspace").enqueue(item.mailbox_id, event.id,
            event.screen && env.CATEGORIES ? { holdMs: SPAM_HOLD_MS } : {});
          if (env.CATEGORIES) await env.CATEGORIES.getByName("workspace").ingest({ id: "cloudflare:" + item.mailbox_id, email: item.mailbox_id }, event);
        }
        this.ctx.storage.transactionSync(() => this.incoming.accepted(item.delivery_id));
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        const dead = this.ctx.storage.transactionSync(() => this.incoming.failed(item.delivery_id, message));
        console.warn(JSON.stringify({ event: dead ? "incoming_delivery_dead" : "incoming_delivery_retry", mailboxId: item.mailbox_id, deliveryId: item.delivery_id, error: message }));
      }
    }
    // Wake for the next event whose backoff ends, not only on the next arrival.
    const due = this.incoming.nextDue();
    if (due !== null) {
      const at = Math.max(Date.now() + 1000, due);
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > at) await this.ctx.storage.setAlarm(at);
    }
  }

  /** Unread and total mail in the inbox, and journal events that did not reach their consumers. */
  async inboxCounts(): Promise<{ unread: number; total: number; stuck: { dead: number; retrying: number; lastError: string | null } }> {
    const row = this.ctx.storage.sql.exec("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END), 0) AS unread FROM emails WHERE folder_id = 'inbox'").one() as { total: number; unread: number };
    return { unread: Number(row.unread), total: Number(row.total), stuck: this.incoming.problems() };
  }

  /** The operator's Retry: set-aside journal events are delivered again now. */
  async retryIncoming(): Promise<number> {
    const revived = this.ctx.storage.transactionSync(() => this.incoming.revive());
    await this.flushIncomingEvents();
    return revived;
  }

	private insertEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
				spam_reason: email.spam_reason ?? null,
				spam_at: email.spam_at ?? null,
				discard_reason: email.discard_reason ?? null,
				discarded_at: email.discarded_at ?? null,
				body_key: email.body_key ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}
	}
}
