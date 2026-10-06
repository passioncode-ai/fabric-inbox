/**
 * Drafts on the server (B-52, also B-09): the main window's drafts live in the chosen account —
 * a Cloudflare mailbox's Drafts or Gmail's own drafts — so they survive this device, show beside
 * agents' drafts, and are sent from there. The copy on this device (draft-store.ts) is the cache
 * that keeps typing safe offline and after a crash; `syncDraft` brings it up to the server.
 *
 * Every save names the revision it was made from; a change made meanwhile elsewhere (another
 * window or device, an agent, Gmail itself) is refused by the server, never overwritten, and
 * comes back here as a conflict for the person to settle.
 */
import { htmlToText, textToHtml } from "../../../shared/mail/text";
import type { MailAttachment } from "../../../shared/mail/attachments";
import { loadAttachments, type AttachmentStorage } from "./attachment-store";
import type { Draft, ServerFile } from "./draft-store";
import { rawAccount } from "./model";
import { recipientAddresses } from "./send-state";

/** The app's API as the sync needs it (`fabric` in the app, a fake in tests). */
export type Request = <T>(url: string, body?: unknown, method?: string) => Promise<T>;
/** A refused request: its HTTP status and the server's answer (ApiError in the app). */
export interface HttpError { status: number; body: Record<string, unknown> }
const isHttp = (e: unknown): e is HttpError => !!e && typeof e === "object" && typeof (e as HttpError).status === "number" && typeof (e as HttpError).body === "object";

/**
 * "cloudflare" (a mailbox's Drafts), "gmail" (Gmail's own drafts), "imap" (the account's Drafts
 * folder) or "outlook" (the Outlook Drafts folder); the last three share their routes.
 */
const provider = (accountId: string) => (accountId.startsWith("gmail:") ? "gmail" : accountId.startsWith("imap:") ? "imap"
  : accountId.startsWith("outlook:") ? "outlook" : accountId.startsWith("cloudflare:") ? "cloudflare" : null);
const remote = (accountId: string) => { const p = provider(accountId); return p === "gmail" || p === "imap" || p === "outlook"; };
/** Who keeps a remote account's drafts, in a sentence. */
const keeper = (accountId: string) => (provider(accountId) === "gmail" ? "Gmail" : provider(accountId) === "outlook" ? "Outlook" : "Your mail server");
const cfBox = (accountId: string) => `/api/v1/mailboxes/${encodeURIComponent(rawAccount(accountId))}`;
const gmailBase = (accountId: string) => `/api/accounts/${encodeURIComponent(rawAccount(accountId))}`;
const list = (header: string | undefined) => (header ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export type SyncResult =
  /** Saved: the server's id, revision and files for this draft; `uploaded` local files are on the server now. */
  | { ok: true; serverId: string; serverRevision: number | string; serverFiles: ServerFile[]; uploaded: string[] }
  /** Waiting: a step to keep before the next attempt (a Gmail creation key). */
  | { ok: false; reason: "pending"; patch: Partial<Draft>; message: string }
  | { ok: false; reason: "no_sender" | "incomplete" | "offline" | "refused" | "conflict" | "gone"; message: string };

const CONFLICT = "This draft was changed elsewhere (another window or device, an agent, or the mail account itself). Your text is kept here.";
const GONE = "This draft was sent or deleted elsewhere. Your text is kept here.";

/** What the server said, in the sync's own terms. */
function refusal(error: unknown): SyncResult {
  if (!isHttp(error) || error.status === 0 || error.status >= 500 || error.status === 429)
    return { ok: false, reason: "offline", message: "Not saved to your server yet; it is kept on this device and saved when the server answers." };
  const code = String(error.body.code ?? error.body.error ?? "");
  if (code === "draft_conflict") return { ok: false, reason: "conflict", message: CONFLICT };
  if (code === "draft_gone" || code === "draft_not_found") return { ok: false, reason: "gone", message: GONE };
  if (error.status === 401) return { ok: false, reason: "offline", message: String(error.body.error ?? "Your sign-in expired. Reload the page to sign in again.") };
  return { ok: false, reason: "refused", message: `The server did not save this draft: ${String(error.body.error ?? error.status)}` };
}

/** New server files matched to the local files just uploaded, by size and then name, each used once. */
function matchUploads(before: ServerFile[], after: ServerFile[], uploaded: Draft["attachments"]): ServerFile[] {
  const known = new Set(before.map((f) => f.id));
  const fresh = after.filter((f) => !known.has(f.id));
  const out = after.filter((f) => known.has(f.id)).map((f) => ({ ...f, ...(before.find((b) => b.id === f.id)?.sourceId ? { sourceId: before.find((b) => b.id === f.id)!.sourceId } : {}) }));
  for (const ref of uploaded ?? []) {
    const i = fresh.findIndex((f) => f.size === ref.size && f.filename === ref.filename);
    const j = i >= 0 ? i : fresh.findIndex((f) => f.size === ref.size);
    if (j < 0) continue;
    const [file] = fresh.splice(j, 1);
    out.push({ ...file!, ...(ref.sourceId ? { sourceId: ref.sourceId } : {}) });
  }
  return [...out, ...fresh];
}

const cfFiles = (files: { id: string; filename: string; mimetype: string; size: number }[] = []): ServerFile[] =>
  files.map((f) => ({ id: f.id, filename: f.filename, mimetype: f.mimetype, size: f.size }));

/**
 * Saves the draft to its account's server. The draft is not changed here: the caller merges the
 * result into whatever the person typed meanwhile (`mergeSynced`).
 */
export async function syncDraft(draft: Draft, files: AttachmentStorage, request: Request): Promise<SyncResult> {
  const kind = provider(draft.accountId);
  if (!kind) return { ok: false, reason: "no_sender", message: "Choose a sender to save this draft to your server; until then it is kept on this device." };
  let local: MailAttachment[];
  try { local = await loadAttachments(files, draft.attachments ?? [], draft.id); }
  catch (error) { return { ok: false, reason: "refused", message: (error as Error).message }; }
  const before = draft.serverFiles ?? [];
  if (kind === "cloudflare") {
    const id = draft.serverId ?? draft.id;
    try {
      const saved = await request<{ id: string; revision: number; attachments: ServerFile[] }>(`${cfBox(draft.accountId)}/drafts/${encodeURIComponent(id)}`, {
        to: draft.to, ...(draft.cc ? { cc: draft.cc } : {}), ...(draft.bcc ? { bcc: draft.bcc } : {}), subject: draft.subject, body: textToHtml(draft.text),
        ...(draft.mode === "reply" && draft.originalId ? { in_reply_to: draft.originalId } : {}), ...(draft.threadId ? { thread_id: draft.threadId } : {}),
        ...(local.length ? { attachments: local } : {}), keep_attachments: before.map((f) => f.id), expected_revision: Number(draft.serverRevision ?? 0),
      }, "PUT");
      return { ok: true, serverId: saved.id, serverRevision: saved.revision, serverFiles: matchUploads(before, cfFiles(saved.attachments), draft.attachments), uploaded: (draft.attachments ?? []).map((a) => a.id) };
    } catch (error) { return refusal(error); }
  }
  const base = gmailBase(draft.accountId);
  // Gmail keeps a draft only with a recipient and well-formed addresses; until then it waits here.
  let to: string[], cc: string[], bcc: string[];
  try {
    to = recipientAddresses(draft.to);
    cc = draft.cc?.trim() ? recipientAddresses(draft.cc) : [];
    bcc = draft.bcc?.trim() ? recipientAddresses(draft.bcc) : [];
  } catch {
    return { ok: false, reason: "incomplete", message: `${keeper(draft.accountId)} saves a draft once it has a recipient with a valid address; until then it is kept on this device.` };
  }
  const message = { to, cc, bcc, subject: draft.subject, text: draft.text,
    ...(draft.threadId ? { threadId: draft.threadId } : {}), ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}), ...(draft.references ? { references: draft.references } : {}) };
  let serverId = draft.serverId, serverRevision = draft.serverRevision;
  try {
    if (!serverId) {
      // A creation that may have happened already is looked up by its key before another is tried.
      if (draft.pendingCreateKey) {
        const receipt = await request<{ status: string; providerDraftId?: string; providerMessageId?: string }>(`${base}/drafts/${encodeURIComponent(draft.pendingCreateKey)}`)
          .catch((error: unknown) => { if (isHttp(error) && error.status === 404) return null; throw error; });
        if (receipt?.status === "accepted" && receipt.providerDraftId) { serverId = receipt.providerDraftId; serverRevision = receipt.providerMessageId; }
        else if (receipt) return { ok: false, reason: "pending", patch: { pendingCreateKey: `draft-${draft.id}-${crypto.randomUUID().slice(0, 8)}` },
          message: `${keeper(draft.accountId)} did not confirm the last save; it is tried again.` };
      }
      if (!serverId) {
        const key = draft.pendingCreateKey ?? `draft-${draft.id}-${crypto.randomUUID().slice(0, 8)}`;
        if (!draft.pendingCreateKey) return { ok: false, reason: "pending", patch: { pendingCreateKey: key }, message: provider(draft.accountId) === "gmail" ? "Saving to Gmail…" : "Saving to your mail server…" };
        const receipt = await request<{ status: string; providerDraftId?: string; providerMessageId?: string }>(`${base}/drafts`, { idempotencyKey: key, ...message,
          ...(local.length ? { attachments: local } : {}) }).catch((error: unknown) => {
          // An unconfirmed creation, or this key used for other text: a fresh key next time (Gmail may keep a second draft).
          if (isHttp(error) && error.status === 409) return { status: "retry" } as { status: string; providerDraftId?: string; providerMessageId?: string };
          throw error;
        });
        if (receipt.status === "retry") return { ok: false, reason: "pending", patch: { pendingCreateKey: `draft-${draft.id}-${crypto.randomUUID().slice(0, 8)}` },
          message: `${keeper(draft.accountId)} did not confirm the last save; it is tried again.` };
        if (receipt.status !== "accepted" || !receipt.providerDraftId) return { ok: false, reason: "offline", message: `${keeper(draft.accountId)} did not confirm the save; it is tried again.` };
        return { ok: true, serverId: receipt.providerDraftId, serverRevision: receipt.providerMessageId!, serverFiles: await gmailFiles(base, receipt.providerDraftId, request, before, draft.attachments),
          uploaded: (draft.attachments ?? []).map((a) => a.id) };
      }
    }
    const saved = await request<{ revision: string }>(`${base}/drafts/${encodeURIComponent(serverId)}`, { ...message, ...(local.length ? { attachments: local } : {}),
      keepAttachments: before.map((f) => f.id), ...(serverRevision !== undefined ? { expectedRevision: String(serverRevision) } : {}) }, "PUT");
    // Gmail gives a draft's files new ids with each change: read them again when it has any.
    const filesNow = before.length || local.length ? await gmailFiles(base, serverId, request, before, draft.attachments) : [];
    return { ok: true, serverId, serverRevision: saved.revision, serverFiles: filesNow, uploaded: (draft.attachments ?? []).map((a) => a.id) };
  } catch (error) { return refusal(error); }
}

async function gmailFiles(base: string, draftId: string, request: Request, before: ServerFile[], uploaded: Draft["attachments"]): Promise<ServerFile[]> {
  const now = await request<{ attachments: ServerFile[] }>(`${base}/drafts/${encodeURIComponent(draftId)}/content`);
  // Ids changed, so files are told apart by name and size; a kept original keeps its source.
  const kept = before.map((b) => ({ ...b }));
  const out: ServerFile[] = [];
  const rest = [...now.attachments];
  for (const b of kept) {
    const i = rest.findIndex((f) => f.filename === b.filename && f.size === b.size);
    if (i >= 0) out.push({ ...rest.splice(i, 1)[0]!, ...(b.sourceId ? { sourceId: b.sourceId } : {}) });
  }
  return [...out, ...matchUploads([], rest, uploaded)];
}

/** What the person typed since `snapshot` was saved stays; the server's ids, revision and files are taken. */
export function mergeSynced(current: Draft, snapshot: Draft, result: Extract<SyncResult, { ok: true }>): Draft {
  const uploaded = new Set(result.uploaded);
  const sameContent = contentKey(current) === contentKey(snapshot);
  return {
    ...current,
    serverId: result.serverId, serverRevision: result.serverRevision, serverFiles: result.serverFiles, pendingCreateKey: undefined,
    attachments: (current.attachments ?? []).filter((a) => !uploaded.has(a.id)),
    synced: sameContent && !(current.attachments ?? []).some((a) => !uploaded.has(a.id)),
  };
}

/**
 * A change typed in the composer, on top of the copy here. The server's id, revision and files
 * belong to the saves to the server, so a keystroke from a window that has not shown the last save
 * yet keeps them: files already uploaded do not come back as files of this device, and server files
 * a save added stay unless the person removed them. Anything the server holds that changed is still
 * to be saved there.
 */
export function rebaseEdit(before: Draft | undefined, input: Draft, uploaded: ReadonlySet<string>, syncAdded: ReadonlySet<string>): Draft {
  if (!before) return { ...input, synced: false };
  const d: Draft = {
    ...input,
    serverId: before.serverId, serverRevision: before.serverRevision, pendingCreateKey: before.pendingCreateKey,
    ...(input.attachments ? { attachments: input.attachments.filter((a) => !uploaded.has(a.id)) } : {}),
    serverFiles: before.serverFiles?.filter((f) => (input.serverFiles ?? []).some((x) => x.id === f.id) || syncAdded.has(f.id)),
  };
  return { ...d, synced: contentKey(before) === contentKey(d) ? before.synced : false };
}

/** The part of a draft the server holds; a change to any of it is still to be saved. */
export function contentKey(d: Draft): string {
  return JSON.stringify([d.accountId, d.to, d.cc ?? "", d.bcc ?? "", d.subject, d.text, (d.attachments ?? []).map((a) => a.id), (d.serverFiles ?? []).map((f) => f.id)]);
}

/** Sends the saved draft from the server; it leaves Drafts there once accepted. Throws the server's refusal. */
export function sendSavedDraft(draft: Draft, request: Request) {
  if (!draft.serverId || !draft.synced) throw new Error("Save the draft to your server before sending.");
  if (provider(draft.accountId) === "cloudflare")
    return request<{ status: string }>(`${cfBox(draft.accountId)}/drafts/${encodeURIComponent(draft.serverId)}/send`,
      { idempotencyKey: draft.idempotencyKey, expected_revision: Number(draft.serverRevision) });
  return request<{ status: string }>(`${gmailBase(draft.accountId)}/drafts/${encodeURIComponent(draft.serverId)}/send`,
    { idempotencyKey: draft.idempotencyKey, expectedRevision: String(draft.serverRevision) });
}

/** Deletes the server's copy; a draft already gone there counts as deleted. */
export async function deleteSavedDraft(draft: Draft, request: Request): Promise<void> {
  if (!draft.serverId) return;
  const path = provider(draft.accountId) === "cloudflare" ? `${cfBox(draft.accountId)}/drafts/${encodeURIComponent(draft.serverId)}`
    : `${gmailBase(draft.accountId)}/drafts/${encodeURIComponent(draft.serverId)}`;
  try { await request(path, undefined, "DELETE"); }
  catch (error) { if (!(isHttp(error) && error.status === 404)) throw error; }
}

/** One draft on the server, as the Drafts list shows it. */
export interface ServerDraftRow {
  accountId: string; serverId: string; revision: number | string; to: string; subject: string; date: string; snippet: string; files: number;
}

/** Every account's drafts on the server; an account that cannot be read is named, the others listed. */
export async function listServerDrafts(accountIds: string[], request: Request): Promise<{ drafts: ServerDraftRow[]; failed: string[] }> {
  const drafts: ServerDraftRow[] = [], failed: string[] = [];
  await Promise.all(accountIds.map(async (accountId) => {
    try {
      if (provider(accountId) === "cloudflare") {
        const data = await request<{ drafts: { id: string; revision: number; to: string; subject: string; date: string; snippet: string; attachments: unknown[] }[] }>(`${cfBox(accountId)}/drafts`);
        for (const d of data.drafts) drafts.push({ accountId, serverId: d.id, revision: d.revision, to: d.to, subject: d.subject, date: d.date, snippet: d.snippet, files: d.attachments.length });
      } else if (remote(accountId)) {
        const data = await request<{ drafts: { draftId: string; revision: string; to: string; subject: string; date: string; snippet: string; attachments: unknown[] }[] }>(`${gmailBase(accountId)}/drafts`);
        for (const d of data.drafts) drafts.push({ accountId, serverId: d.draftId, revision: d.revision, to: d.to, subject: d.subject, date: d.date, snippet: d.snippet, files: d.attachments.length });
      }
    } catch { failed.push(accountId); }
  }));
  drafts.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return { drafts, failed: failed.sort() };
}

/** A server draft as a draft on this device, ready to edit: its text, recipients, conversation and files. */
export async function openServerDraft(row: Pick<ServerDraftRow, "accountId" | "serverId">, request: Request): Promise<Draft> {
  const common = { accountId: row.accountId, serverId: row.serverId, synced: true, idempotencyKey: crypto.randomUUID(), attachments: [] };
  if (provider(row.accountId) === "cloudflare") {
    const d = await request<{ id: string; revision: number; to: string; cc: string | null; bcc: string | null; subject: string; body: string;
      inReplyTo: string | null; threadId: string | null; attachments: ServerFile[] }>(`${cfBox(row.accountId)}/drafts/${encodeURIComponent(row.serverId)}`);
    return { ...common, id: d.id, to: d.to, ...(d.cc ? { cc: d.cc } : {}), ...(d.bcc ? { bcc: d.bcc } : {}), subject: d.subject, text: htmlToText(d.body),
      mode: d.inReplyTo ? "reply" : "new", ...(d.inReplyTo ? { originalId: d.inReplyTo } : {}), ...(d.threadId ? { threadId: d.threadId } : {}),
      serverRevision: d.revision, serverFiles: cfFiles(d.attachments) };
  }
  const d = await request<{ draftId: string; revision: string; to: string; cc: string | null; bcc: string | null; subject: string; text: string; html: string;
    threadId: string | null; inReplyTo: string | null; references: string | null; attachments: ServerFile[] }>(`${gmailBase(row.accountId)}/drafts/${encodeURIComponent(row.serverId)}/content`);
  return { ...common, id: crypto.randomUUID(), to: d.to, ...(d.cc ? { cc: d.cc } : {}), ...(d.bcc ? { bcc: d.bcc } : {}), subject: d.subject,
    text: d.text || htmlToText(d.html), mode: d.inReplyTo ? "reply" : "new", ...(d.threadId ? { threadId: d.threadId } : {}),
    ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}), ...(d.references ? { references: d.references } : {}), serverRevision: d.revision, serverFiles: d.attachments.map((f) => ({ ...f })) };
}

/**
 * The server's version of a draft changed elsewhere: as a draft (to take theirs), and the files of
 * this copy that are still there under their ids now (to save this copy over theirs).
 */
export async function refreshFromServer(draft: Draft, request: Request): Promise<{ draft: Draft; matchedFiles: ServerFile[] }> {
  if (!draft.serverId) throw new Error("This draft is not on the server yet");
  const server = await openServerDraft({ accountId: draft.accountId, serverId: draft.serverId }, request);
  const rest = [...(server.serverFiles ?? [])];
  const matchedFiles: ServerFile[] = [];
  for (const mine of draft.serverFiles ?? []) {
    const i = rest.findIndex((f) => f.id === mine.id || (remote(draft.accountId) && f.filename === mine.filename && f.size === mine.size));
    if (i >= 0) matchedFiles.push({ ...rest.splice(i, 1)[0]!, ...(mine.sourceId ? { sourceId: mine.sourceId } : {}) });
  }
  return { draft: server, matchedFiles };
}

/** The address's signature for a new draft from it ("" when it has none, or for Gmail, which adds its own). */
export async function signatureFor(accountId: string, request: Request): Promise<string> {
  if (provider(accountId) !== "cloudflare") return "";
  const box = await request<{ settings?: { signature?: { enabled?: boolean; text?: string } } }>(cfBox(accountId));
  const s = box.settings?.signature;
  return s?.enabled && s.text?.trim() ? s.text.trim() : "";
}

/** The text with its signature swapped for another sender's (only when the old one is still at its end). */
export function swapSignature(text: string, previous: string | undefined, next: string): string {
  const body = previous && text.endsWith(previous) ? text.slice(0, text.length - previous.length).replace(/\n*$/, "") : text;
  if (!next) return body;
  return body.trim() ? `${body}\n\n${next}` : `\n\n${next}`;
}
