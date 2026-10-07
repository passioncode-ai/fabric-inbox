import type { Env } from "../types";
import { msg } from "../../shared/i18n";

/**
 * Cloudflare mailbox records: `mailboxes/<address>.json` in R2 holds the
 * settings; the mail itself lives in that address's MailboxDO.
 */
export const settingsKey = (email: string) => `mailboxes/${email.toLowerCase()}.json`;

/** DOMAINS accepts commas and/or whitespace; every reader uses this one parser. */
export function servedDomains(env: Pick<Env, "DOMAINS">): string[] {
  return [...new Set(String(env.DOMAINS ?? "").split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

const DOMAIN_NAME = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const DOMAINS_KEY = "config/domains.json";

export function isDomainName(value: string): boolean {
  return DOMAIN_NAME.test(value);
}

/**
 * Domains served: DOMAINS from the deployment plus the ones a setup added
 * (R2 `config/domains.json`), so an applied setup receives mail without a
 * redeploy. An unreadable registry falls back to DOMAINS alone.
 */
export async function allServedDomains(env: Pick<Env, "DOMAINS" | "BUCKET">): Promise<string[]> {
  const fixed = servedDomains(env);
  try {
    const object = await env.BUCKET.get(DOMAINS_KEY);
    const stored = object ? await object.json<unknown>() : [];
    const extra = Array.isArray(stored) ? stored.filter((d): d is string => typeof d === "string" && isDomainName(d)) : [];
    return [...new Set([...fixed, ...extra])];
  } catch (error) {
    console.error(JSON.stringify({ event: "domain_registry_unreadable", error: (error as Error).message }));
    return fixed;
  }
}

/** Adds domains to the registry; returns the ones that were new. */
export async function addServedDomains(env: Pick<Env, "DOMAINS" | "BUCKET">, domains: string[]): Promise<string[]> {
  const wanted = [...new Set(domains.map((d) => d.trim().toLowerCase()))].filter(isDomainName);
  const object = await env.BUCKET.get(DOMAINS_KEY);
  const stored = object ? await object.json<unknown>() : [];
  const current = Array.isArray(stored) ? stored.filter((d): d is string => typeof d === "string") : [];
  const known = new Set([...current, ...servedDomains(env)]);
  const added = wanted.filter((d) => !known.has(d));
  if (added.length) await env.BUCKET.put(DOMAINS_KEY, JSON.stringify([...current, ...added].sort()));
  return added;
}

/**
 * Removes a domain added at runtime; true when it was there. A domain from the
 * deployment's DOMAINS cannot be removed here (the caller says so).
 */
export async function removeServedDomain(env: Pick<Env, "DOMAINS" | "BUCKET">, domain: string): Promise<boolean> {
  const object = await env.BUCKET.get(DOMAINS_KEY);
  const stored = object ? await object.json<unknown>() : [];
  const current = Array.isArray(stored) ? stored.filter((d): d is string => typeof d === "string") : [];
  if (!current.includes(domain)) return false;
  await env.BUCKET.put(DOMAINS_KEY, JSON.stringify(current.filter((d) => d !== domain)));
  return true;
}

export const CATCH_ALL_KEY = "config/catch-all.json";

/** Runtime catch-all mailboxes per domain, written by an applied setup. */
export async function storedCatchAll(bucket: R2Bucket): Promise<Record<string, string>> {
  try {
    const object = await bucket.get(CATCH_ALL_KEY);
    const value = object ? await object.json<unknown>() : {};
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
  } catch (error) {
    console.error(JSON.stringify({ event: "catch_all_registry_unreadable", error: (error as Error).message }));
    return {};
  }
}

export async function setCatchAll(bucket: R2Bucket, entries: { domain: string; mailbox: string }[]): Promise<string[]> {
  const current = await storedCatchAll(bucket);
  const changed = entries.filter((e) => current[e.domain] !== e.mailbox).map((e) => e.domain);
  if (changed.length) {
    for (const e of entries) current[e.domain] = e.mailbox;
    await bucket.put(CATCH_ALL_KEY, JSON.stringify(current));
  }
  return changed;
}

/** Removes a domain's catch-all mailbox; true when one was set. */
export async function removeCatchAll(bucket: R2Bucket, domain: string): Promise<boolean> {
  const current = await storedCatchAll(bucket);
  if (!(domain in current)) return false;
  delete current[domain];
  await bucket.put(CATCH_ALL_KEY, JSON.stringify(current));
  return true;
}

/**
 * Deletes a mailbox with its mail and attachments. Mail first, the settings
 * file last: a failure part-way leaves the mailbox listed, so deleting again
 * finishes the job.
 */
export async function deleteMailbox(env: Pick<Env, "BUCKET" | "MAILBOX">, email: string): Promise<boolean> {
  const key = settingsKey(email);
  if (!(await env.BUCKET.head(key))) return false;
  const attachmentKeys = await env.MAILBOX.get(env.MAILBOX.idFromName(email.toLowerCase())).purge();
  for (let i = 0; i < attachmentKeys.length; i += 1000) await env.BUCKET.delete(attachmentKeys.slice(i, i + 1000));
  await env.BUCKET.delete(key);
  return true;
}

const MAX_MAILBOXES = 5000;

/** Every mailbox address, following R2 pagination (a single list stops at 1000 keys). */
export async function listMailboxAddresses(bucket: R2Bucket): Promise<string[]> {
  const addresses: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "mailboxes/", cursor });
    for (const object of page.objects)
      if (object.key.endsWith(".json")) addresses.push(object.key.slice("mailboxes/".length, -".json".length));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && addresses.length < MAX_MAILBOXES);
  return addresses;
}

export async function readSettings(bucket: R2Bucket, email: string): Promise<Record<string, unknown> | null> {
  const object = await bucket.get(settingsKey(email));
  return object ? await object.json<Record<string, unknown>>() : null;
}

/** Settings of every mailbox, read in small parallel batches. */
export async function readAllSettings(bucket: R2Bucket): Promise<{ email: string; settings: Record<string, unknown> }[]> {
  const addresses = await listMailboxAddresses(bucket);
  const result: { email: string; settings: Record<string, unknown> }[] = [];
  for (let i = 0; i < addresses.length; i += 20) {
    // One unreadable file is reported and skipped over, never the whole list (audit MB-4, finding 4).
    const batch = await Promise.all(addresses.slice(i, i + 20).map(async (email) => ({ email, settings: (await readSettings(bucket, email).catch((error: unknown) => {
      console.error(JSON.stringify({ event: "mailbox_settings_unreadable", email, error: (error as Error).message }));
      return null;
    })) ?? {} })));
    result.push(...batch);
  }
  return result;
}

/**
 * EMAIL_ADDRESSES as a lowercase list, whatever shape the variable has: a JSON array
 * (wrangler vars), a JSON string of one, or a comma- or space-separated list (the
 * dashboard). A shape it cannot read restricts nothing and is logged.
 */
export function allowedAddresses(env: Pick<Env, "EMAIL_ADDRESSES">): string[] {
  const raw = env.EMAIL_ADDRESSES as unknown;
  let list: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    try { list = text.startsWith("[") ? JSON.parse(text) : text.split(/[\s,]+/); }
    catch { console.warn(JSON.stringify({ event: "email_addresses_unreadable" })); return []; }
  }
  return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string" && !!a.trim()).map((a) => a.trim().toLowerCase()) : [];
}

export type CreateMailboxResult =
  | { status: "created"; settings: Record<string, unknown> }
  | { status: "exists" }
  | { status: "forbidden"; reason: string };

/**
 * The one way a mailbox is created (settings UI, project addresses, config).
 * Respects EMAIL_ADDRESSES and, when DOMAINS is set, only accepts its domains.
 */
export async function createMailbox(env: Env, rawEmail: string, name: string, settings: Record<string, unknown> = {}): Promise<CreateMailboxResult> {
  const email = rawEmail.trim().toLowerCase();
  const allowed = allowedAddresses(env);
  if (allowed.length && !allowed.includes(email)) return { status: "forbidden", reason: msg("Mailbox creation is restricted to configured EMAIL_ADDRESSES") };
  const domains = await allServedDomains(env);
  if (domains.length && !domains.includes(email.slice(email.lastIndexOf("@") + 1)))
    return { status: "forbidden", reason: msg("The domain is not served here; add it to DOMAINS first ({domains})", { domains: domains.join(", ") }) };
  if (await env.BUCKET.head(settingsKey(email))) return { status: "exists" };
  const finalSettings = {
    fromName: name,
    forwarding: { enabled: false, email: "" },
    signature: { enabled: false, text: "" },
    autoReply: { enabled: false, subject: "", message: "" },
    // No agent answers a new address until one is chosen; only mailboxes from before
    // the agent registry (no key at all) are migrated to their old drafting agent.
    agent: "off",
    ...settings,
  };
  // Written only if no other request wrote it since the check above: of two creates at once, one
  // wins and the other is told the address exists.
  const written = await env.BUCKET.put(settingsKey(email), JSON.stringify(finalSettings), { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (written === null) return { status: "exists" };
  // Creating the folders now makes the mailbox usable before its first message; the mailbox makes
  // them itself on first use, so a failure here does not undo the address.
  await env.MAILBOX.get(env.MAILBOX.idFromName(email)).getFolders().catch((error: unknown) =>
    console.warn(JSON.stringify({ event: "mailbox_folders_deferred", error: (error as Error).message })));
  return { status: "created", settings: finalSettings };
}

/** Read-modify-write of one mailbox's settings; returns null when the mailbox does not exist. */
export async function updateSettings(
  bucket: R2Bucket,
  email: string,
  change: (settings: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  // Conditional on the version read, so two screens saving at once never lose one change.
  for (let attempt = 0; attempt < 5; attempt++) {
    const object = await bucket.get(settingsKey(email));
    if (!object) return null;
    const next = change(await object.json<Record<string, unknown>>());
    if (await bucket.put(settingsKey(email), JSON.stringify(next), { onlyIf: { etagMatches: object.etag } })) return next;
  }
  throw new Error(msg("The settings of {email} changed several times at once; try again", { email }));
}
