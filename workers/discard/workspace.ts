import { addressOf, isPersonalDomain } from "../../shared/mail/discard";
import { allServedDomains, listMailboxAddresses } from "../lib/mailbox-store";

/**
 * What a discard rule asks of the whole workspace (shared/mail/discard.ts): rules apply to every
 * mailbox and account, so "someone your addresses wrote to" and "your own domains" are answered
 * across every Cloudflare mailbox and every connected Gmail, IMAP and Outlook account — not only
 * the one the mail is in.
 *
 * Asking is bounded (at most KNOWN_MAILBOX_LIMIT mailboxes, KNOWN_CONCURRENCY at once, within
 * KNOWN_DEADLINE_MS) and answered once per sender per arrival batch. Anything it cannot read —
 * a mailbox that does not answer, accounts that cannot be listed, more mailboxes than the bound,
 * the deadline — answers "known": a rule never discards mail it could not clear.
 */
export const KNOWN_MAILBOX_LIMIT = 500;
export const KNOWN_CONCURRENCY = 10;
export const KNOWN_DEADLINE_MS = 5_000;

export interface WorkspaceSources {
  /** Every Cloudflare mailbox address of the workspace. */
  mailboxes(): Promise<string[]>;
  /** Whether this Cloudflare mailbox sent mail to `address` (To, Cc or Bcc). */
  mailboxKnows(mailbox: string, address: string): Promise<boolean>;
  /** Whether any connected Gmail, IMAP or Outlook account sent mail to `address`; absent when the server has none. */
  accountsKnow?(address: string): Promise<boolean>;
}

/** Answers "did any address of the workspace write to this sender", once per sender, for one batch of arrivals. */
export function workspaceKnown(sources: WorkspaceSources, options: { deadlineMs?: number; limit?: number } = {}): (sender: string) => Promise<boolean> {
  const answers = new Map<string, Promise<boolean>>();
  let mailboxes: Promise<string[]> | undefined;
  return (sender: string) => {
    const address = addressOf(sender);
    if (!address) return Promise.resolve(false);
    let answer = answers.get(address);
    if (!answer) {
      mailboxes ??= sources.mailboxes();
      answer = ask(sources, mailboxes, address, options.limit ?? KNOWN_MAILBOX_LIMIT, options.deadlineMs ?? KNOWN_DEADLINE_MS);
      answers.set(address, answer);
    }
    return answer;
  };
}

async function ask(sources: WorkspaceSources, mailboxes: Promise<string[]>, address: string, limit: number, deadlineMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), deadlineMs); });
  try {
    const found = await Promise.race([deadline, search(sources, mailboxes, address, limit)]);
    if (found === "timeout") throw new Error(`no answer within ${deadlineMs} ms`);
    return found;
  } catch (error) {
    console.warn(JSON.stringify({ event: "discard_known_unread", error: (error as Error)?.message?.slice(0, 160) ?? "unknown" }));
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function search(sources: WorkspaceSources, mailboxes: Promise<string[]>, address: string, limit: number): Promise<boolean> {
  if (sources.accountsKnow && await sources.accountsKnow(address)) return true;
  const all = await mailboxes;
  if (all.length > limit) throw new Error(`${all.length} mailboxes is more than the ${limit} a check reads`);
  let found = false;
  for (let i = 0; i < all.length && !found; i += KNOWN_CONCURRENCY) {
    const answers = await Promise.all(all.slice(i, i + KNOWN_CONCURRENCY).map((mailbox) => sources.mailboxKnows(mailbox, address)));
    found = answers.some(Boolean);
  }
  return found;
}

/**
 * The workspace's own domains: the domains it serves, and the domain of each connected account's
 * own address unless that is a shared personal provider (gmail.com, outlook.com, icloud.com…),
 * where a domain says nothing about who sent the mail.
 */
export function workspaceOwnDomains(served: string[], accountAddresses: string[]): string[] {
  const own = new Set(served.map((d) => d.trim().toLowerCase()).filter(Boolean));
  for (const value of accountAddresses) {
    const address = addressOf(value);
    const domain = address.slice(address.lastIndexOf("@") + 1);
    if (address && !isPersonalDomain(domain)) own.add(domain);
  }
  return [...own];
}

/** The Cloudflare mailboxes of the workspace, as WorkspaceSources reads them (none without a bucket or the binding). */
export interface MailboxNamespace { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): unknown }
export function cloudflareSources(bucket: R2Bucket | undefined, namespace: MailboxNamespace | undefined): Pick<WorkspaceSources, "mailboxes" | "mailboxKnows"> {
  return {
    mailboxes: async () => (bucket && namespace ? listMailboxAddresses(bucket) : []),
    mailboxKnows: (mailbox, address) =>
      (namespace!.get(namespace!.idFromName(mailbox)) as { knownCorrespondent(a: string): Promise<boolean> }).knownCorrespondent(address),
  };
}

/** The workspace's accounts object, as these checks call it. */
export interface AccountsObject {
  knownSender(address: string): Promise<boolean>;
  listAccounts(): Promise<{ accounts: { email: string }[] }>;
}

/**
 * The workspace checks as the Worker asks them for a Cloudflare arrival or a discard: every
 * mailbox through its object, every connected account through the accounts object. One instance
 * per request or arrival, so each sender is asked once.
 */
export function cloudflareWorkspace(env: { BUCKET: R2Bucket; DOMAINS?: string; MAILBOX?: unknown; GMAIL_ACCOUNTS?: unknown }) {
  const accounts = env.GMAIL_ACCOUNTS ? (env.GMAIL_ACCOUNTS as { getByName(name: string): AccountsObject }).getByName("workspace") : null;
  return {
    known: workspaceKnown({ ...cloudflareSources(env.BUCKET, env.MAILBOX as MailboxNamespace | undefined),
      ...(accounts ? { accountsKnow: (address: string) => accounts.knownSender(address) } : {}) }),
    ownDomains: () => readWorkspaceOwnDomains(env, async () => (accounts ? (await accounts.listAccounts()).accounts.map((a) => a.email) : [])),
  };
}

/** The workspace's own domains (workspaceOwnDomains); accounts that cannot be listed leave the served domains alone, said in the logs. */
export async function readWorkspaceOwnDomains(env: { BUCKET: R2Bucket; DOMAINS?: string }, accountAddresses: () => Promise<string[]>): Promise<string[]> {
  const served = await allServedDomains(env as Parameters<typeof allServedDomains>[0]);
  let addresses: string[] = [];
  try { addresses = await accountAddresses(); }
  catch (error) { console.warn(JSON.stringify({ event: "discard_own_domains_partial", error: (error as Error)?.message?.slice(0, 160) ?? "unknown" })); }
  return workspaceOwnDomains(served, addresses);
}
