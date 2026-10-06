/**
 * A Cloudflare mailbox's drafts on the server (B-52): the rows of its `draft` folder, changed in
 * place under a revision so two writers cannot silently overwrite each other. Pure SQL over the
 * MailboxDO's storage; the object calls these inside its own transaction.
 *
 * A draft keeps its id for its whole life. `draft_revision` starts at 1 and grows by one on each
 * save; a save that names the revision it read is refused when another save came first. Files are
 * rows in `attachments` like any message's, their bytes in R2 under the draft's id.
 */
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "../../shared/mail/attachments";
import { htmlToText } from "../../shared/mail/text";

export interface DraftSql { exec(query: string, ...args: (string | number | null)[]): Iterable<Record<string, unknown>> }

/** One draft as the drafts list shows it. */
export interface DraftSummary {
  id: string; revision: number; to: string; cc: string | null; bcc: string | null; subject: string; date: string;
  /** The message it answers (its id in this mailbox), or null for a new message. */
  inReplyTo: string | null; threadId: string | null; snippet: string;
  attachments: { id: string; filename: string; mimetype: string; size: number }[];
}

export interface DraftAttachmentRow { id: string; email_id: string; filename: string; mimetype: string; size: number; content_id: string | null; disposition: string }

export interface SaveDraftInput {
  id: string; sender: string; now: string;
  /** The revision the writer read; absent means "whatever is there" (an agent's plain overwrite). */
  expectedRevision?: number;
  to: string; cc: string | null; bcc: string | null; subject: string;
  body: string; bodyKey: string | null; inReplyTo: string | null; threadId: string | null;
  /** Ids of the draft's files to keep; absent keeps them all. */
  keep?: string[];
  /** New files, already in R2 under this draft's id. */
  added: DraftAttachmentRow[];
}
export type SaveDraftResult =
  | { ok: true; draft: DraftSummary; removed: { id: string; filename: string }[]; oldBodyKey: string | null; created: boolean }
  | { ok: false; code: "not_draft" | "gone" | "conflict" | "too_large"; revision?: number };

const rows = (sql: DraftSql, query: string, ...args: (string | number | null)[]) => [...sql.exec(query, ...args)];

function attachmentsOf(sql: DraftSql, id: string) {
  return rows(sql, "SELECT id, filename, mimetype, size FROM attachments WHERE email_id = ? ORDER BY id", id)
    .map((a) => ({ id: String(a.id), filename: String(a.filename), mimetype: String(a.mimetype), size: Number(a.size) }));
}

export function draftSummary(sql: DraftSql, row: Record<string, unknown>): DraftSummary {
  return {
    id: String(row.id), revision: Number(row.draft_revision ?? 1), to: String(row.recipient ?? ""), cc: (row.cc as string) || null, bcc: (row.bcc as string) || null,
    subject: String(row.subject ?? ""), date: String(row.date ?? ""), inReplyTo: (row.in_reply_to as string) || null, threadId: (row.thread_id as string) || null,
    snippet: htmlToText(String(row.body ?? "")).slice(0, 200), attachments: attachmentsOf(sql, String(row.id)),
  };
}

/** Every draft of the mailbox, newest first (at most `limit`). */
export function listDrafts(sql: DraftSql, limit = 200): DraftSummary[] {
  return rows(sql, "SELECT id, recipient, cc, bcc, subject, date, in_reply_to, thread_id, body, draft_revision FROM emails WHERE folder_id = 'draft' ORDER BY date DESC LIMIT ?", limit)
    .map((row) => draftSummary(sql, row));
}

/** Creates or changes one draft. Run inside a transaction: every check and write is one step. */
export function saveDraft(sql: DraftSql, input: SaveDraftInput): SaveDraftResult {
  const current = rows(sql, "SELECT id, folder_id, draft_revision, body_key FROM emails WHERE id = ?", input.id)[0];
  if (current && current.folder_id !== "draft") return { ok: false, code: "not_draft" };
  const revision = current ? Number(current.draft_revision ?? 1) : 0;
  if (!current && (input.expectedRevision ?? 0) > 0) return { ok: false, code: "gone" };
  if (current && input.expectedRevision !== undefined && input.expectedRevision !== revision) return { ok: false, code: "conflict", revision };

  const existing = current ? rows(sql, "SELECT id, filename, size FROM attachments WHERE email_id = ?", input.id) : [];
  const keep = input.keep === undefined ? null : new Set(input.keep);
  const kept = existing.filter((a) => !keep || keep.has(String(a.id)));
  const files = kept.length + input.added.length;
  const bytes = kept.reduce((n, a) => n + Number(a.size), 0) + input.added.reduce((n, a) => n + a.size, 0);
  if (files > MAX_ATTACHMENTS || bytes > MAX_ATTACHMENT_BYTES) return { ok: false, code: "too_large" };
  const removed = existing.filter((a) => keep && !keep.has(String(a.id))).map((a) => ({ id: String(a.id), filename: String(a.filename) }));

  if (current) {
    sql.exec(`UPDATE emails SET recipient = ?, cc = ?, bcc = ?, subject = ?, body = ?, body_key = ?, in_reply_to = ?, thread_id = ?, date = ?, draft_revision = ?
      WHERE id = ?`, input.to, input.cc, input.bcc, input.subject, input.body, input.bodyKey, input.inReplyTo,
      input.threadId || input.inReplyTo || input.id, input.now, revision + 1, input.id);
    for (const a of removed) sql.exec("DELETE FROM attachments WHERE id = ? AND email_id = ?", a.id, input.id);
  } else {
    sql.exec(`INSERT INTO emails (id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred, body, in_reply_to, thread_id, body_key, draft_revision)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, 1)`, input.id, input.subject, input.sender, input.to, input.cc, input.bcc, input.now,
      input.body, input.inReplyTo, input.threadId || input.inReplyTo || input.id, input.bodyKey);
  }
  for (const a of input.added)
    sql.exec("INSERT INTO attachments (id, email_id, filename, mimetype, size, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, ?)",
      a.id, a.email_id, a.filename, a.mimetype, a.size, a.content_id, a.disposition);
  const saved = rows(sql, "SELECT id, recipient, cc, bcc, subject, date, in_reply_to, thread_id, body, draft_revision FROM emails WHERE id = ?", input.id)[0]!;
  const oldBodyKey = current?.body_key && current.body_key !== input.bodyKey ? String(current.body_key) : null;
  return { ok: true, draft: draftSummary(sql, saved), removed, oldBodyKey, created: !current };
}
