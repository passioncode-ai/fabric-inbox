import type { Env } from "../types";
import type { InboxAccount } from "../../shared/mail/inbox";
import type { InboxSources } from "../routes/inbox";
import { importPercent } from "../providers/gmail-sync";

/**
 * The feed's providers, read the same way by the /api/inbox route and by
 * background work (a category's first classification): Cloudflare mailboxes
 * listed from R2, Gmail accounts from GmailAccountsDO.
 */
export function inboxSources(env: Env): InboxSources {
  return {
    async cloudflareAccounts() {
      const accounts: InboxAccount[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await env.BUCKET.list({ prefix: "mailboxes/", cursor });
        for (const object of result.objects) {
          if (!object.key.endsWith(".json")) continue;
          const email = object.key.slice("mailboxes/".length, -5);
          accounts.push({ id: "cloudflare:" + email, provider: "cloudflare", email, name: email, status: "connected" });
        }
        if (!result.truncated) return accounts;
        cursor = result.cursor;
      }
      throw new Error("account_limit");
  },
    async gmailAccounts() {
      if (!env.GMAIL_ACCOUNTS) return [];
      const result = await env.GMAIL_ACCOUNTS.getByName("workspace").listAccounts();
      return result.accounts.map(a => ({ id: "gmail:" + a.id, provider: "gmail", email: a.email, name: a.email,
        status: a.sync.mode === "initial" && a.status === "connected" ? "syncing" : a.status,
        error: a.error, lastSyncAt: a.lastSyncAt, ...(a.reason ? { reason: a.reason } : {}),
        ...(a.sync.mode === "initial" && importPercent(a.sync) !== undefined ? { importing: importPercent(a.sync) } : {}) }));
  },
    async unreadCount(account) {
      if (account.provider === "gmail") return env.GMAIL_ACCOUNTS.getByName("workspace").countUnreadInbox(account.id.slice(6));
      return env.MAILBOX.get(env.MAILBOX.idFromName(account.id.slice(11))).countUnreadInbox();
  },
    async counts(account) {
      if (account.provider === "gmail") return env.GMAIL_ACCOUNTS.getByName("workspace").countInbox(account.id.slice(6));
      return env.MAILBOX.get(env.MAILBOX.idFromName(account.id.slice(11))).inboxCounts();
  },
    async messages(account, options) {
      if (account.provider === "gmail") return env.GMAIL_ACCOUNTS.getByName("workspace").listInboxMessages(account.id.slice(6), options);
      // The account list was read from R2 a moment ago; a mailbox deleted since reads as empty.
      const email = account.id.slice(11);
      return env.MAILBOX.get(env.MAILBOX.idFromName(email)).listInboxMessages(email, options);
  },
  };
}

/** Current inbox accounts of both providers; a provider that cannot be listed is left out. */
export async function listInboxAccounts(env: Env): Promise<InboxAccount[]> {
  const s = inboxSources(env);
  const found = await Promise.allSettled([s.cloudflareAccounts(), s.gmailAccounts()]);
  return found.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
