// B-27, second half: rename or move an address keeping its mail (spec: docs/app-store/tasks/b-27-rename.md).
// A mailbox is a Durable Object named by its address, so a rename copies its rows into the new address's
// object, page by page, with the same ids. Bodies and attachments in R2 are keyed by message id, so they
// are not copied and the old object is emptied without deleting them. Every step is recorded in a journal
// (`renames/<from>.json`) before the next begins, so a request cut off anywhere is continued by the next
// call with the same addresses, and nothing is copied twice. The old address stays an alias of the new
// one for ALIAS_DAYS: its mail is delivered to the new address, then it follows the catch-all.
import type { Env } from "../types";
import { checkLocalPart } from "../../shared/address-name";
import { msg } from "../../shared/i18n";
import { RENAME_TABLES } from "../durableObject/rename-tables";
import { allowedAddresses, allServedDomains, createMailbox, readSettings, settingsKey } from "./mailbox-store";
import { effectiveCatchAll, pausedKey, type OpResult } from "./address-ops";
import { readCreated, recordCreated, forgetCreated } from "./address-created";
import { routingClient, ZoneNotVisible, type RoutingStatus } from "../routing/email-routing";

export const ALIAS_DAYS = 30;
export const renameKey = (from: string) => `renames/${from.toLowerCase()}.json`;
export const aliasKey = (from: string) => `renamed/${from.toLowerCase()}.json`;
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
/** Pages one call copies before it hands back (each page is two object calls and one journal write). */
const PAGES_PER_CALL = 40;

type Step = "create" | "copy" | "verify" | "route" | "carry" | "empty" | "done";
export interface RenameJournal { from: string; to: string; step: Step; table: number; after: number; copied: number; startedAt: string; routing?: string }

const box = (env: Env, email: string) => env.MAILBOX.get(env.MAILBOX.idFromName(email));
async function readJournal(env: Env, from: string): Promise<RenameJournal | null> {
  return (await env.BUCKET.get(renameKey(from)).then((o) => o?.json<RenameJournal>()).catch(() => null)) ?? null;
}
const saveJournal = (env: Env, j: RenameJournal) => env.BUCKET.put(renameKey(j.from), JSON.stringify(j));

/** Where mail to a renamed address goes, while its alias lasts; null after it, or when it was never renamed. */
export async function renamedTo(bucket: R2Bucket, address: string, now = Date.now()): Promise<string | null> {
  const alias = await bucket.get(aliasKey(address)).then((o) => o?.json<{ to?: string; until?: string }>()).catch(() => null);
  return alias?.to && alias.until && Date.parse(alias.until) > now ? alias.to : null;
}

/** What a person reads about a rename in progress or done; the journal's step names it. */
export async function renameStatus(env: Env, rawFrom: string): Promise<OpResult> {
  const from = rawFrom.trim().toLowerCase();
  const journal = await readJournal(env, from);
  if (journal) return { status: 200, body: { from, to: journal.to, state: "running", step: journal.step, copied: journal.copied } };
  const to = await renamedTo(env.BUCKET, from);
  return to ? { status: 200, body: { from, to, state: "done" } } : { status: 404, body: { error: msg("No rename of {email} is in progress or recent", { email: from }) } };
}

/**
 * Renames `from` to `to`, or continues the rename already started for `from` (then `to` must be the same).
 * Answers `running` with the step reached when its share of work for this call is used up (call again),
 * `done` when it is finished, or an error before anything was written.
 */
export async function renameAddress(env: Env, rawFrom: string, rawTo: string, now = Date.now()): Promise<OpResult> {
  const from = rawFrom.trim().toLowerCase();
  const to = rawTo.trim().toLowerCase();
  let journal = await readJournal(env, from);
  if (journal && journal.to !== to)
    return { status: 409, body: { error: msg("{from} is already being renamed to {to}; finish that first", { from, to: journal.to }) } };
  if (!journal) {
    const refused = await check(env, from, to);
    if (refused) return refused;
    journal = { from, to, step: "create", table: 0, after: 0, copied: 0, startedAt: new Date(now).toISOString() };
    await saveJournal(env, journal);
    console.log(JSON.stringify({ event: "address_rename_started", from_domain: domainOf(from), to_domain: domainOf(to) }));
  }
  let pages = 0;
  for (;;) {
    switch (journal.step) {
      case "create": {
        const settings = (await readSettings(env.BUCKET, from)) ?? {};
        const name = typeof settings.fromName === "string" && settings.fromName.trim() ? settings.fromName : to;
        const made = await createMailbox(env, to, name, { ...settings });
        // "exists" here is this rename's own mailbox from a call that was cut off after writing it.
        if (made.status === "forbidden") return { status: 403, body: { error: made.reason } };
        journal.step = "copy";
        break;
      }
      case "copy": {
        if (journal.table >= RENAME_TABLES.length) { journal.step = "verify"; break; }
        if (pages >= PAGES_PER_CALL) { await saveJournal(env, journal); return running(journal); }
        const table = RENAME_TABLES[journal.table]!;
        const page = await box(env, from).exportPage(table, journal.after, 200);
        if (page.rows.length) journal.copied += await box(env, to).importRows(table, page.rows);
        pages++;
        if (page.next === null) { journal.table++; journal.after = 0; } else journal.after = page.next;
        break;
      }
      case "verify": {
        const [a, b] = await Promise.all([box(env, from).renameCounts(), box(env, to).renameCounts()]);
        const missing = Object.entries(a.folders).filter(([f, n]) => (b.folders[f] ?? 0) < n).map(([f]) => f);
        if (missing.length || b.attachments < a.attachments) {
          // Copy again from the start: rows already there are kept as they are, so this only fills the gaps.
          console.warn(JSON.stringify({ event: "address_rename_verify_retry", folders: missing.length }));
          journal.step = "copy"; journal.table = 0; journal.after = 0;
          await saveJournal(env, journal);
          return running(journal);
        }
        journal.step = "route";
        break;
      }
      case "route": {
        const client = routingClient(env);
        let routing: RoutingStatus | null = null;
        if (client) {
          try { routing = (await client.ensureRule(to)).status; }
          catch (error) {
            if (!(error instanceof ZoneNotVisible)) { await saveJournal(env, journal); return { status: 502, body: { error: msg("{reason}. The rename stops here; call it again to go on.", { reason: (error as Error).message }), step: journal.step } }; }
          }
        }
        journal.routing = routing?.state ?? "unknown";
        await env.BUCKET.put(aliasKey(from), JSON.stringify({ to, until: new Date(now + ALIAS_DAYS * 86_400_000).toISOString() }));
        journal.step = "carry";
        break;
      }
      case "carry": {
        if (env.CATEGORIES) await env.CATEGORIES.getByName("workspace").moveAccount(`cloudflare:${from}`, `cloudflare:${to}`)
          .catch((error: unknown) => console.warn(JSON.stringify({ event: "address_rename_categories_failed", error: (error as Error).message?.slice(0, 200) })));
        const created = (await readCreated(env.BUCKET).catch(() => ({} as Record<string, number>)))[from];
        if (created) await recordCreated(env.BUCKET, to, created).catch(() => undefined);
        journal.step = "empty";
        break;
      }
      case "empty": {
        await box(env, from).emptyKeepingFiles();
        await env.BUCKET.delete([settingsKey(from), pausedKey(from), `delivery-issues/${from}.json`]);
        await forgetCreated(env.BUCKET, from).catch(() => undefined);
        journal.step = "done";
        break;
      }
      case "done": {
        await env.BUCKET.delete(renameKey(from));
        console.log(JSON.stringify({ event: "address_renamed", copied: journal.copied }));
        return { status: 200, body: { from, to, state: "done", copied: journal.copied, routing: journal.routing ?? "unknown",
          afterwards: msg("Mail to {from} goes to {to} for {days} days, then follows the domain's catch-all.", { from, to, days: ALIAS_DAYS }) } };
      }
    }
    if (journal.step !== "copy" || pages % 10 === 0) await saveJournal(env, journal);
  }
}

const running = (j: RenameJournal): OpResult => ({ status: 202, body: { from: j.from, to: j.to, state: "running", step: j.step, copied: j.copied } });

async function check(env: Env, from: string, to: string): Promise<OpResult | null> {
  if (from === to) return { status: 400, body: { error: msg("The new address is the same as the old one") } };
  if (!(await env.BUCKET.head(settingsKey(from)))) return { status: 404, body: { error: msg("Address not found") } };
  const local = checkLocalPart(to.slice(0, to.lastIndexOf("@")));
  if (!to.includes("@") || !local.valid) return { status: 400, body: { error: local.valid ? msg("Not an email address") : local.problem } };
  const domain = domainOf(to);
  if (!(await allServedDomains(env)).includes(domain)) return { status: 400, body: { error: msg("{domain} is not served here; receive its mail here first (Settings → Domains)", { domain }) } };
  if (await env.BUCKET.head(settingsKey(to))) return { status: 409, body: { error: msg("This address already exists"), email: to } };
  const allowed = allowedAddresses(env);
  if (allowed.length && !allowed.includes(to)) return { status: 403, body: { error: msg("Mailbox creation is restricted to configured EMAIL_ADDRESSES") } };
  const catchAll = await effectiveCatchAll(env, domainOf(from));
  if (catchAll?.mailbox === from)
    return { status: 409, body: { error: msg("{email} keeps mail for every other address on {domain}. Choose another catch-all (or none) first.", { email: from, domain: domainOf(from) }) } };
  if (await env.BUCKET.head(pausedKey(from))) return { status: 409, body: { error: msg("{email} is paused. Resume it before renaming it.", { email: from }) } };
  const counts = await box(env, from).renameCounts();
  if (counts.pendingSends) return { status: 409, body: { error: msg("{email} is still sending a message. Try again in a minute.", { email: from }) } };
  return null;
}
