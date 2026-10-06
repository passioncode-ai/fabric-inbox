import type { Env } from "../types";
import type { InboxAccount } from "../../shared/mail/inbox";
import { parseRemoteAccount } from "../../shared/mail/accounts";
import type { InboxSources } from "../routes/inbox";
import { importPercent } from "../providers/gmail-sync";

/**
 * The feed's providers, read the same way by the /api/inbox route and by background work (a
 * category's first classification): Cloudflare mailboxes listed from R2; Gmail, IMAP and Outlook accounts
 * from the accounts object (GmailAccountsDO, named for its first provider).
 */
export function inboxSources(env: Env): InboxSources {
  const remote = (account: InboxAccount) => {
    const parsed = parseRemoteAccount(account.id);
    if (!parsed) throw new Error("account_not_found");
    return { stub: env.GMAIL_ACCOUNTS.getByName("workspace"), id: parsed.id };
  };
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
    async remoteAccounts() {
      if (!env.GMAIL_ACCOUNTS) return [];
      const result = await env.GMAIL_ACCOUNTS.getByName("workspace").listAccounts();
      return result.accounts.map((a): InboxAccount => {
        const c = a.capabilities;
        const provider = a.provider ?? "gmail";
        const importing = a.importing ?? importPercent(a.sync as Parameters<typeof importPercent>[0]);
        return { id: provider + ":" + a.id, provider, email: a.email, name: a.email,
          status: a.sync.mode === "initial" && a.status === "connected" ? "syncing" : a.status,
          error: a.error, lastSyncAt: a.lastSyncAt, ...(a.reason ? { reason: a.reason } : {}),
          ...(a.providerName ? { providerName: a.providerName } : {}),
          ...(c ? { capabilities: { archive: c.archive, spam: c.spam, trash: c.trash, drafts: c.drafts, organization: c.organization } } : {}),
          ...(a.sync.mode === "initial" && importing !== undefined ? { importing } : {}) };
      });
  },
    async unreadCount(account) {
      if (account.provider !== "cloudflare") { const r = remote(account); return r.stub.countUnreadInbox(r.id); }
      return env.MAILBOX.get(env.MAILBOX.idFromName(account.id.slice(11))).countUnreadInbox();
  },
    async counts(account) {
      if (account.provider !== "cloudflare") { const r = remote(account); return r.stub.countInbox(r.id); }
      return env.MAILBOX.get(env.MAILBOX.idFromName(account.id.slice(11))).inboxCounts();
  },
    async messages(account, options) {
      if (account.provider !== "cloudflare") { const r = remote(account); return r.stub.listInboxMessages(r.id, options); }
      // The account list was read from R2 a moment ago; a mailbox deleted since reads as empty.
      const email = account.id.slice(11);
      return env.MAILBOX.get(env.MAILBOX.idFromName(email)).listInboxMessages(email, options);
  },
  };
}

/** Current inbox accounts of every provider; a provider that cannot be listed is left out. */
export async function listInboxAccounts(env: Env): Promise<InboxAccount[]> {
  const s = inboxSources(env);
  const found = await Promise.allSettled([s.cloudflareAccounts(), s.remoteAccounts()]);
  return found.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
