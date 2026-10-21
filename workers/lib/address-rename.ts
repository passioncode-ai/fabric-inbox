// B-27, second half: rename or move an address keeping its mail (spec: docs/app-store/tasks/b-27-rename.md).
// A mailbox is a Durable Object named by its address, so a rename copies its rows into the new address's
// object with the same ids. Bodies and attachments in R2 are keyed by message id, so they are not copied,
// and the old object is emptied without deleting them.
//
// Nothing is lost by construction (review 2026-10-21):
// - from the first step, delivery puts mail for the old address into the new one (the alias is written
//   before any copy), so no message lands in an object that is about to be emptied;
// - the old mailbox is frozen while it is copied: its routes refuse changes and its purges wait;
// - the copy replaces rows (a message that moved since is brought up to date), and the old mailbox is
//   emptied only after every message and attachment id was found in the new one;
// - an address taking part in a rename cannot be removed, paused, renamed again or made the catch-all.
// Every step is recorded in `renames/<from>.json` before the next; a cut-off call is continued by the
// next call with the same addresses, and a rename not yet routed can be cancelled.
import type { Env } from "../types";
import { checkLocalPart } from "../../shared/address-name";
import { msg } from "../../shared/i18n";
import { RENAME_TABLES } from "../durableObject/rename-tables";
import { allowedAddresses, allServedDomains, createMailbox, readSettings, settingsKey } from "./mailbox-store";
import { effectiveCatchAll, pausedKey, type OpResult } from "./address-ops";
import { readCreated, recordCreated, forgetCreated } from "./address-created";
import { routingClient, ZoneNotVisible, type RoutingStatus } from "../routing/email-routing";
import { AGENT_KEYS_KEY } from "../mcp/keys";
import { HIDDEN_KEY } from "./hidden-accounts";

export const ALIAS_DAYS = 30;
import { aliasKey, renameKey, renamesInProgress } from "./rename-journal";
export { aliasKey, renameKey, renameOf } from "./rename-journal";
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
/** Pages one call copies before it hands back (each page is two object calls). */
const PAGES_PER_CALL = 40;

type Step = "create" | "copy" | "verify" | "route" | "carry" | "empty" | "done";
const STEPS: Step[] = ["create", "copy", "verify", "route", "carry", "empty", "done"];
export interface RenameJournal { from: string; to: string; step: Step; table: number; after: number; copied: number; startedAt: string; routing?: string; createdTo?: boolean }

const box = (env: Env, email: string) => env.MAILBOX.get(env.MAILBOX.idFromName(email));
async function readJournal(bucket: R2Bucket, from: string): Promise<RenameJournal | null> {
  return (await bucket.get(renameKey(from)).then((o) => o?.json<RenameJournal>()).catch(() => null)) ?? null;
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
  const journal = await readJournal(env.BUCKET, from);
  if (journal) return { status: 200, body: { from, to: journal.to, state: "running", step: journal.step, copied: journal.copied, cancellable: canCancel(journal) } };
  const to = await renamedTo(env.BUCKET, from);
  return to ? { status: 200, body: { from, to, state: "done" } } : { status: 404, body: { error: msg("No rename of {email} is in progress or recent", { email: from }) } };
}

const canCancel = (j: RenameJournal) => STEPS.indexOf(j.step) <= STEPS.indexOf("route") && !j.routing;

/**
 * Cancels a rename that has not routed the new address yet: the old address takes its mail again, the
 * new mailbox this rename made is emptied (keeping the files the old one names) and removed.
 */
export async function cancelRename(env: Env, rawFrom: string): Promise<OpResult> {
  const from = rawFrom.trim().toLowerCase();
  const journal = await readJournal(env.BUCKET, from);
  if (!journal) return { status: 404, body: { error: msg("No rename of {email} is in progress or recent", { email: from }) } };
  if (!canCancel(journal)) return { status: 409, body: { error: msg("The rename of {email} is past the point where it can be cancelled; call it again to finish it.", { email: from }) } };
  if (journal.createdTo) {
    await box(env, journal.to).emptyKeepingFiles();
    await env.BUCKET.delete([settingsKey(journal.to)]);
    await forgetCreated(env.BUCKET, journal.to).catch(() => undefined);
  }
  await box(env, from).setRenaming(false);
  await env.BUCKET.delete([aliasKey(from), renameKey(from)]);
  console.log(JSON.stringify({ event: "address_rename_cancelled", step: journal.step }));
  return { status: 200, body: { from, to: journal.to, state: "cancelled" } };
}

/**
 * Renames `from` to `to`, or continues the rename already started for `from` (then `to` must be the same).
 * Answers `running` with the step reached when its share of work for this call is used up (call again),
 * `done` when it is finished, or an error before anything was written.
 */
export async function renameAddress(env: Env, rawFrom: string, rawTo: string, now = Date.now()): Promise<OpResult> {
  const from = rawFrom.trim().toLowerCase();
  const to = rawTo.trim().toLowerCase();
  let journal = await readJournal(env.BUCKET, from);
  if (journal && journal.to !== to)
    return { status: 409, body: { error: msg("{from} is already being renamed to {to}; finish that first", { from, to: journal.to }) } };
  if (!journal) {
    const refused = await check(env, from, to);
    if (refused) return refused;
    journal = { from, to, step: "create", table: 0, after: 0, copied: 0, startedAt: new Date(now).toISOString() };
    // From here on, mail for the old address is delivered to the new one, and the old mailbox is frozen.
    await env.BUCKET.put(aliasKey(from), JSON.stringify({ to, until: new Date(now + ALIAS_DAYS * 86_400_000).toISOString() }));
    await box(env, from).setRenaming(true);
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
        if (made.status === "forbidden") return { status: 403, body: { error: made.reason } };
        // "exists" here is this rename's own mailbox from a call that was cut off after writing it:
        // check() refused a target that existed before the rename started.
        journal.createdTo = true;
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
        const [a, b] = await Promise.all([box(env, from).renameIds(), box(env, to).renameIds()]);
        const have = { emails: new Set(b.emails), attachments: new Set(b.attachments) };
        const missing = a.emails.filter((id) => !have.emails.has(id)).length + a.attachments.filter((id) => !have.attachments.has(id)).length;
        if (missing) {
          // Copy again from the start: rows are replaced, so this fills the gaps and changes nothing else.
          console.warn(JSON.stringify({ event: "address_rename_verify_retry", missing }));
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
            if (!(error instanceof ZoneNotVisible)) {
              await saveJournal(env, journal);
              return { status: 502, body: { error: msg("{reason}. The rename stops here; call it again to go on, or cancel it.", { reason: (error as Error).message }), step: journal.step } };
            }
          }
        }
        journal.routing = routing?.state ?? "unknown";
        journal.step = "carry";
        break;
      }
      case "carry": {
        if (env.CATEGORIES) await env.CATEGORIES.getByName("workspace").moveAccount(`cloudflare:${from}`, `cloudflare:${to}`)
          .catch((error: unknown) => console.warn(JSON.stringify({ event: "address_rename_categories_failed", error: (error as Error).message?.slice(0, 200) })));
        const created = (await readCreated(env.BUCKET).catch(() => ({} as Record<string, number>)))[from];
        if (created) await recordCreated(env.BUCKET, to, created).catch(() => undefined);
        await renameAccountIn(env.BUCKET, AGENT_KEYS_KEY, from, to);
        await renameAccountIn(env.BUCKET, HIDDEN_KEY, from, to);
        journal.step = "empty";
        break;
      }
      case "empty": {
        // A last look: everything the old mailbox holds must be in the new one before it is emptied.
        const [a, b] = await Promise.all([box(env, from).renameIds(), box(env, to).renameIds()]);
        const have = new Set(b.emails);
        if (a.emails.some((id) => !have.has(id))) { journal.step = "copy"; journal.table = 0; journal.after = 0; break; }
        await box(env, to).armPurges();
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

const running = (j: RenameJournal): OpResult => ({ status: 202, body: { from: j.from, to: j.to, state: "running", step: j.step, copied: j.copied, cancellable: canCancel(j) } });

/** Replaces `cloudflare:<from>` with `cloudflare:<to>` wherever a stored JSON names the account. */
async function renameAccountIn(bucket: R2Bucket, key: string, from: string, to: string) {
  const object = await bucket.get(key).catch(() => null);
  if (!object) return;
  const text = await object.text();
  const next = text.split(JSON.stringify(`cloudflare:${from}`)).join(JSON.stringify(`cloudflare:${to}`));
  if (next !== text) await bucket.put(key, next, { onlyIf: { etagMatches: object.etag } });
}

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
  const other = (await renamesInProgress<RenameJournal>(env.BUCKET)).find((j) => [j.from, j.to].some((a) => a === from || a === to));
  if (other) return { status: 409, body: { error: msg("{email} takes part in another rename ({from} to {to}); finish or cancel it first.", { email: [from, to].find((a) => a === other.from || a === other.to)!, from: other.from, to: other.to }) } };
  if (await renamedTo(env.BUCKET, to)) return { status: 409, body: { error: msg("{email} was renamed recently and still delivers to its new address; choose another name.", { email: to }) } };
  // The new address must be routable here: a rule that sends it elsewhere would stop the rename after the copy.
  const client = routingClient(env);
  if (client) {
    const status = await client.status(to).catch(() => null);
    if (status?.state === "missing" && status.via === "rule")
      return { status: 409, body: { error: msg("A routing rule for {email} already sends its mail elsewhere; choose another name or bring that address here first.", { email: to }) } };
  }
  const blockers = await box(env, from).renameBlockers();
  if (blockers.sends) return { status: 409, body: { error: msg("{email} is still sending a message. Try again in a minute.", { email: from }) } };
  if (blockers.incoming) return { status: 409, body: { error: msg("{email} is still handling mail that just came. Try again in a minute.", { email: from }) } };
  return null;
}
