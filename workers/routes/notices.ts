/**
 * B-308: GET /api/notices, what on this server waits on a person as `notice/1` records (workers/notices/notices.ts,
 * docs/agents/notice.schema.json), for Fabric's home screen. Each read gathers the sources that exist (mail accounts'
 * states, reply agents' waiting runs, access requests, messages held by the safety check), keeps them against the
 * last read in R2 `notices/state.json` (written on the version read, so a change is stamped once and a cleared
 * condition is served once more as resolved), and answers the records changed after `since`.
 *
 * `accounts` (a comma list of account ids) narrows the answer to those mailboxes' notices; the scoped API sets it for a
 * member and for a key limited to mailboxes (workers/mcp/scope.ts), and the whole set is still kept, so a narrowed read
 * never resolves another mailbox's notice. A source that fails is named in `degraded` and keeps its notices as they were.
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { createT } from "../../shared/i18n";
import { requestLocale } from "../../shared/i18n/server";
import { msg } from "../../shared/i18n";
import { bodyForUpdate } from "../lib/r2-json";
import { readRequests } from "../mcp/access-requests";
import { readAgentKeys } from "../mcp/keys";
import { mergeNotices, noticeFacts, noticeFeed, normaliseState, type NoticeSource, type NoticeSources, type NoticeState } from "../notices/notices";

export const NOTICES_KEY = "notices/state.json";
export const noticesRouter = new Hono<{ Bindings: Env }>();

const failed = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 120);

/** Every source that exists on this server; one that fails is left out and named. */
export async function readSources(env: Env): Promise<{ sources: NoticeSources; unavailable: Set<NoticeSource> }> {
  const unavailable = new Set<NoticeSource>();
  const sources: NoticeSources = {};
  const attempt = async (source: NoticeSource, work: () => Promise<void>) => {
    try { await work(); }
    catch (error) {
      unavailable.add(source);
      console.warn(JSON.stringify({ event: "notices_source_unreadable", source, error: failed(error) }));
    }
  };
  await Promise.all([
    attempt("accounts", async () => {
      if (!env.GMAIL_ACCOUNTS) return;
      const listed = await env.GMAIL_ACCOUNTS.getByName("workspace").listAccounts();
      sources.accounts = listed.accounts.map((a) => ({ id: a.id, provider: a.provider, email: a.email, status: a.status, error: a.error, failures: a.failures }));
    }),
    attempt("agents", async () => {
      if (!env.AGENT_REGISTRY) return;
      const registry = env.AGENT_REGISTRY.getByName("workspace");
      const [waiting, agents] = await Promise.all([registry.waitingOnPeople(), registry.listAgents()]);
      sources.waiting = waiting;
      sources.agents = agents.map((a) => ({ id: a.id, name: a.name }));
    }),
    attempt("access", async () => {
      const [requests, keys] = await Promise.all([readRequests(env.BUCKET), readAgentKeys(env.BUCKET).catch(() => [])]);
      sources.accessRequests = requests.map((r) => ({ id: r.id, keyName: keys.find((k) => k.id === r.holder.id)?.name ?? null, holderId: r.holder.id,
        mailboxes: r.mailboxes, expiresAt: r.expiresAt, state: r.state }));
    }),
    attempt("safety", async () => {
      if (!env.CATEGORIES) return;
      sources.held = (await env.CATEGORIES.getByName("workspace").heldMessages(500)).map((h) => ({ accountId: h.accountId, state: h.state }));
    }),
  ]);
  return { sources, unavailable };
}

/**
 * Keeps the facts of now against the stored state, on the version read. A write that loses to another read's is
 * read and merged again; after 3 tries the merged state is answered unwritten (the next read writes it).
 */
export async function updateState(bucket: R2Bucket, sources: NoticeSources, unavailable: ReadonlySet<NoticeSource>, now: Date): Promise<NoticeState> {
  const facts = noticeFacts(sources);
  let merged: NoticeState = { v: 1, records: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    const object = await bucket.get(NOTICES_KEY);
    const previous = normaliseState(object ? await bodyForUpdate(object) : null);
    const { state, changed } = mergeNotices(previous, facts, now, unavailable);
    merged = state;
    if (!changed) return state;
    const written = await bucket.put(NOTICES_KEY, JSON.stringify(state), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" }),
    });
    if (written) return state;
  }
  console.warn(JSON.stringify({ event: "notices_state_conflict" }));
  return merged;
}

noticesRouter.get("/api/notices", async (c) => {
  c.header("Cache-Control", "no-store");
  const since = c.req.query("since");
  if (since !== undefined && since !== "" && Number.isNaN(Date.parse(since)))
    return c.json({ error: msg("since is a date and time in ISO 8601, as the last answer's cursor") }, 400);
  const narrowed = c.req.query("accounts");
  const accounts = narrowed === undefined ? undefined : new Set(narrowed.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean));
  const now = new Date();
  const { sources, unavailable } = await readSources(c.env);
  let state: NoticeState;
  try {
    state = await updateState(c.env.BUCKET, sources, unavailable, now);
  } catch (error) {
    console.error(JSON.stringify({ event: "notices_state_unreadable", error: failed(error) }));
    return c.json({ error: msg("The notices could not be read right now") }, 503);
  }
  const feed = noticeFeed(state, createT(requestLocale(c.req.raw)), new URL(c.req.url).origin, { since: since || undefined, accounts });
  return c.json({ ...feed, ...(unavailable.size ? { degraded: [...unavailable].sort() } : {}) });
});
