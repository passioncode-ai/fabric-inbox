import type { Env } from "../types";
import type { SendMailResult } from "../../shared/mail/send";
import type { OutboxStatus } from "../../shared/mail/outbox";
import type { Message } from "../providers/gmail-client";
import type { SendReceipt, SendRequest, SubmitOptions } from "../providers/account-service";
import { inFolder } from "../providers/gmail-cache";
import { textToHtml } from "../lib/email-helpers";
import { sharedDeps } from "./deps";
import { accountIdOf, accountSettingsKey } from "./account-settings";

export { accountIdOf, accountSettingsKey, isAccountMailbox } from "./account-settings";
import type { RunnerDeps, RunnerEmail, RunnerThreadMessage } from "./runner";

/** What a run reads and writes through GmailAccountsDO (its RPC, or the service in tests). */
export interface AccountsPort {
  listAccounts(): Promise<{ accounts: { id: string; provider: string; email: string }[] }>;
  getMessage(accountId: string, messageId: string): Promise<Message>;
  getHeaders(accountId: string, messageId: string): Promise<{ headers: { key: string; value: string }[] }>;
  listMessages(accountId: string, options: { threadId: string; limit: number }): Promise<{ messages: Omit<Message, "text" | "html">[] }>;
  send(accountId: string, request: SendRequest, options?: SubmitOptions): Promise<SendReceipt>;
  createDraft(accountId: string, request: SendRequest, options?: SubmitOptions): Promise<SendReceipt>;
  getSendReceipt(accountId: string, key: string): Promise<SendReceipt>;
}

/** The account's email, or null when the account is gone (its queued messages are dropped). */
export async function accountAddress(port: Pick<AccountsPort, "listAccounts">, mailboxId: string): Promise<string | null> {
  const id = accountIdOf(mailboxId.toLowerCase());
  const provider = mailboxId.slice(0, mailboxId.indexOf(":")).toLowerCase();
  const account = (await port.listAccounts()).accounts.find((a) => a.id.toLowerCase() === id && a.provider === provider);
  return account ? account.email.toLowerCase() : null;
}

function folderOf(labels: string[]): string {
  return (["trash", "spam", "draft", "sent", "inbox"] as const).find((f) => inFolder(labels, f)) ?? "archive";
}

/**
 * A provider's receipt as the runner reads an outbox entry (REQ-3): accepted is accepted, failed is
 * failed, and a send still marked sending or unknown is unknown, never sent again.
 */
export function receiptOutcome(mailboxId: string, receipt: SendReceipt): SendMailResult {
  const status: OutboxStatus = receipt.status === "accepted" ? "accepted" : receipt.status === "failed" ? "failed" : "unknown";
  const now = Date.now();
  return {
    id: receipt.idempotencyKey, mailboxId, status, createdAt: now, updatedAt: now, attempts: 1,
    providerMessageId: receipt.providerMessageId ?? null, deliveryStatus: "unconfirmed", projectionStatus: "complete",
    errorCode: status === "accepted" ? null : receipt.error ?? status,
  };
}

/** A run's mailbox on an account: reads from the account's cache, replies leave from the account itself. */
export function accountMailbox(env: Pick<Env, "BUCKET">, port: AccountsPort, mailboxId: string, address: string): RunnerDeps["mailbox"] {
  const box = mailboxId.toLowerCase();
  const id = accountIdOf(box);
  const settingsKey = accountSettingsKey(box);
  // The original of a reply: the headers a reply names (In-Reply-To, References), and for Gmail its
  // conversation (IMAP and Outlook thread by those headers; their own thread ids are not Gmail's shape).
  const gmail = box.startsWith("gmail:");
  const replyFields = async (messageId: string) => {
    const original = await port.getMessage(id, messageId);
    const rfc = original.rfcMessageId?.trim();
    return {
      ...(gmail && original.threadId ? { threadId: original.threadId } : {}),
      ...(rfc ? { inReplyTo: rfc, references: [original.references, rfc].filter(Boolean).join(" ").trim() } : {}),
    };
  };
  return {
    address,
    async settings() {
      const object = await env.BUCKET.get(settingsKey);
      return object ? await object.json<Record<string, unknown>>() : null;
    },
    // An account is never migrated to a legacy agent (resolveAgent): nothing to write.
    async saveAssignment() {},
    async email(messageId) {
      let message: Message;
      try {
        message = await port.getMessage(id, messageId);
      } catch (error) {
        if (/not_found/.test((error as Error)?.message ?? "")) return null;
        throw error;
      }
      // B-171 decision 4: the prefilter reads the real headers; one that cannot be read fails the run (retried), never answers blind.
      const { headers } = await port.getHeaders(id, messageId);
      const rfc = message.rfcMessageId?.trim().replace(/^<|>$/g, "") || null;
      return {
        id: message.providerMessageId, sender: message.from ?? "", subject: message.subject ?? "",
        body: message.text || message.html || "", date: message.date || new Date(message.timestamp || Date.now()).toISOString(),
        thread_id: message.threadId || null, raw_headers: JSON.stringify(headers), folder_id: folderOf(message.labels ?? []),
        message_id: rfc, recipient: message.to ?? null, cc: message.cc ?? null,
      } satisfies RunnerEmail;
    },
    async thread(threadId) {
      const { messages } = await port.listMessages(id, { threadId, limit: 20 });
      const rows: RunnerThreadMessage[] = [];
      for (const m of messages) {
        const folder = folderOf(m.labels ?? []);
        // What the account sent is read whole: the waiting reply is told from a person's answer by its opening (closeRun).
        const body = folder === "sent" ? await port.getMessage(id, m.providerMessageId).then((full) => full.text || full.html || m.snippet, () => m.snippet) : m.snippet;
        rows.push({ id: m.providerMessageId, sender: m.from ?? "", recipient: m.to ?? "", date: m.date || new Date(m.timestamp || 0).toISOString(), folder_id: folder, body: body ?? "" });
      }
      return rows.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    },
    // The account keeps its own sending budget (B-06): nothing more to ask here.
    rateLimit: async () => null,
    async send(command) {
      const key = command.idempotencyKey;
      if (!key) return { error: "idempotency key required", code: "INVALID_REQUEST" };
      const to = Array.isArray(command.request.to) ? command.request.to : [command.request.to];
      const reply = command.originalEmailId ? await replyFields(command.originalEmailId) : {};
      const request: SendRequest = {
        idempotencyKey: key, to: to.map(String), subject: command.request.subject ?? "", text: command.request.text ?? "",
        ...(command.request.html ? { html: command.request.html } : {}), ...reply,
      };
      try {
        return receiptOutcome(box, await port.send(id, request, { autoSubmitted: command.request.auto_submitted === true }));
      } catch (error) {
        // A refusal before anything left takes its reservation back: no receipt is kept under the key.
        // A receipt that is there means the provider may have it; anything else is unknown (never sent twice).
        const receipt = await port.getSendReceipt(id, key).catch((e: unknown) => (/receipt_not_found/.test((e as Error)?.message ?? "") ? null : undefined));
        if (receipt === null) return { error: (error as Error)?.message?.slice(0, 120) || "refused", code: "INVALID_REQUEST" };
        if (receipt) return receiptOutcome(box, receipt);
        throw error;
      }
    },
    async createDraft(draft) {
      const reply = await replyFields(draft.inReplyTo);
      // Idempotent by the draft's id: the same key answers the draft already made.
      await port.createDraft(id, { idempotencyKey: draft.id, to: [draft.to], subject: draft.subject, text: draft.text, html: textToHtml(draft.text), ...reply });
    },
  };
}

/** The production effects of a run on an account. */
export function accountDeps(env: Env, mailboxId: string, address: string, registry: RunnerDeps["registry"]): RunnerDeps {
  const port = env.GMAIL_ACCOUNTS.getByName("workspace") as unknown as AccountsPort;
  return { ...sharedDeps(env, registry), mailbox: accountMailbox(env, port, mailboxId, address) };
}
