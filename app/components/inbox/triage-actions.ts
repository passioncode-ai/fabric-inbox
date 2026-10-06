// What Delete/Backspace and ⌘⌫ do to the messages in the list (operator, 2026-10-06), as plain
// requests so they are tested without a browser: archive marks read and archives; discard sends the
// messages to Discarded in one request, which also learns from them; Undo puts each message back where
// and as it was (unread again if it was), and takes back what the discard taught.
import { fabric } from "../../services/fabric";
import { isRemote, rawAccount, type MailProvider } from "./model";
import { TRIAGE_TEXT as T } from "./triage-text";

export type ActMessage = { id: string; accountId: string; provider: MailProvider; providerMessageId: string; read: boolean };
type Request = (url: string, body: unknown, method?: string) => Promise<unknown>;
export interface Learned { ruleId: string; kind: "list" | "sender"; label: string; discards: number; created: boolean }
export interface Done {
  kind: "archive" | "discard";
  /**
   * What moved: each message with the id it has now (an IMAP move gives a new one), whether it was
   * unread, the folder a discard took it from (Undo puts it back there), and the rule its discard
   * taught (Undo takes back that alone).
   */
  items: { message: ActMessage; id: string; unread: boolean; learnedRuleId?: string; from?: string }[];
  failed: { message: ActMessage; error: string }[];
  learned: Learned[];
  ruleError?: string;
}

const base = (m: Pick<ActMessage, "provider" | "accountId">, id: string) => isRemote(m.provider)
  ? `/api/accounts/${encodeURIComponent(rawAccount(m.accountId))}/messages/${encodeURIComponent(id)}`
  : `/api/v1/mailboxes/${encodeURIComponent(rawAccount(m.accountId))}/emails/${encodeURIComponent(id)}`;

/** Archive and mark read, one message after another; one that fails is named and the rest go on. */
export async function archiveMessages(messages: ActMessage[], request: Request = fabric): Promise<Done> {
  const done: Done = { kind: "archive", items: [], failed: [], learned: [] };
  for (const m of messages) {
    try {
      const path = base(m, m.providerMessageId);
      if (!m.read) await (isRemote(m.provider) ? request(path + "/read", { read: true }) : request(path, { read: true }, "PUT"));
      const result = (isRemote(m.provider) ? await request(path + "/archive", {}) : await request(path + "/move", { folderId: "archive" })) as { providerMessageId?: string } | null;
      done.items.push({ message: m, id: result?.providerMessageId || m.providerMessageId, unread: !m.read });
    } catch (error) {
      done.failed.push({ message: m, error: (error as Error).message });
    }
  }
  return done;
}

/** Discard in one request: the server moves each message, says what it learned, and why any did not move. */
export async function discardMessages(messages: ActMessage[], request: Request = fabric): Promise<Done> {
  const answer = (await request("/api/discard", { messages: messages.map((m) => ({ accountId: m.accountId, providerMessageId: m.providerMessageId })) })) as {
    results?: { accountId: string; providerMessageId: string; id: string; unread: boolean; from?: string; learnedRuleId?: string }[];
    failed?: { accountId: string; providerMessageId: string; error?: string }[];
    learned?: Learned[]; ruleError?: string;
  };
  const find = (r: { accountId: string; providerMessageId: string }) => messages.find((m) => m.accountId === r.accountId && m.providerMessageId === r.providerMessageId);
  return {
    kind: "discard",
    items: (answer.results ?? []).flatMap((r) => { const m = find(r); return m ? [{ message: m, id: r.id, unread: r.unread, ...(r.from ? { from: r.from } : {}), ...(r.learnedRuleId ? { learnedRuleId: r.learnedRuleId } : {}) }] : []; }),
    failed: (answer.failed ?? []).flatMap((f) => { const m = find(f); return m ? [{ message: m, error: f.error ?? T.notDiscardedAny }] : []; }),
    learned: answer.learned ?? [],
    ...(answer.ruleError ? { ruleError: answer.ruleError } : {}),
  };
}

/** Undo: each message back where it was (a discard's from the folder it left), unread again if it was; a discard's lesson is taken back. */
export async function undoDone(done: Done, request: Request = fabric): Promise<{ restored: number; failed: string[] }> {
  const failed: string[] = [];
  let restored = 0;
  if (done.kind === "discard") {
    // Grouped by read state: the route takes one `read` for the messages it is given.
    for (const unread of [true, false]) {
      const items = done.items.filter((i) => i.unread === unread);
      if (!items.length) continue;
      try {
        const r = (await request("/api/discard/restore", { messages: items.map((i) => ({ accountId: i.message.accountId, providerMessageId: i.id, ...(i.from ? { to: i.from } : {}), ...(i.learnedRuleId ? { ruleId: i.learnedRuleId } : {}) })), ...(unread ? { read: false } : {}), unlearn: true })) as { moved?: number; failed?: { error?: string }[] };
        restored += r?.moved ?? items.length;
        for (const f of r?.failed ?? []) failed.push(f.error ?? T.notRestored);
      } catch (error) { failed.push((error as Error).message); }
    }
    return { restored, failed };
  }
  for (const i of done.items) {
    try {
      const path = base(i.message, i.id);
      const result = (isRemote(i.message.provider) ? await request(path + "/inbox", {}) : await request(path + "/move", { folderId: "inbox" })) as { providerMessageId?: string } | null;
      if (i.unread) {
        const back = base(i.message, result?.providerMessageId || i.id);
        await (isRemote(i.message.provider) ? request(back + "/read", { read: false }) : request(back, { read: false }, "PUT"));
      }
      restored++;
    } catch (error) { failed.push((error as Error).message); }
  }
  return { restored, failed };
}

/** The toast's words: "Archived", "3 messages discarded", and what did not work. */
export function doneText(done: Done): string {
  const head = T.done(done.kind === "archive" ? T.archived : T.discarded, done.items.length);
  const failed = done.failed.length ? T.someFailed(done.failed.length, done.failed[0]!.error) : "";
  return head + failed + (done.ruleError ? `. ${done.ruleError}` : "");
}

/** The once-only notice after a discard taught a new rule, with the rules Don't removes. */
export function learnedNotice(done: Done): { text: string; ruleIds: string[] } | null {
  const fresh = done.learned.filter((l) => l.created);
  if (!fresh.length) return null;
  const names = fresh.map((l) => l.label);
  const who = names.length === 1 ? names[0]! : names.length === 2 ? T.and(names[0]!, names[1]!) : T.andOthers(names[0]!, names.length - 1);
  return { text: T.futureMail(who), ruleIds: fresh.map((l) => l.ruleId) };
}

/** Why an action cannot be done here (in a sentence), or null when it can. */
export function canAct(action: "archive" | "discard", folder: string, capabilities: { archive?: boolean } | undefined): string | null {
  if (action === "archive") {
    if (folder === "archive") return T.alreadyArchived;
    if (folder !== "inbox" && folder !== "starred") return T.archiveInboxOnly;
    if (capabilities?.archive === false) return T.noArchiveFolder;
    return null;
  }
  if (folder === "discarded") return T.alreadyDiscarded;
  if (folder === "sent") return T.sentNotDiscardable;
  return null;
}
