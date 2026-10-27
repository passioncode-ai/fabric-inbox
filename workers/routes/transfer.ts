import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";
import { createMailbox, readSettings, settingsKey, updateSettings } from "../lib/mailbox-store";
import { CloudflareAccounts } from "../routing/accounts";
import { BringRefused, DomainManager, type Rule } from "../routing/domains";
import { CloudflareApiError } from "../routing/cloudflare-api";
import { blobKeysOf, BLOB_KEY, decodeRows, encodeRows, fromBase64, isTable, MAX_BLOB_BYTES, MAX_PAGE, missingIds, toBase64 } from "../lib/mailbox-transfer";
import { RENAME_TABLES } from "../durableObject/rename-tables";
import { readAssignment } from "../agents/definition";
import { registryError } from "../agents/errors";
import { agentInputOf, sameAgent } from "../lib/mailbox-transfer";

/**
 * B-158 M1 step 3a: a mailbox read out of this server, and a mailbox written into it, page by page with its ids kept
 * (workers/lib/mailbox-transfer.ts). An administrator's only: the paths name no mailbox the member gate or a limited
 * key could match (`accountOfPath`), so both refuse them. Reading changes nothing; writing only adds or updates rows
 * and files of the named mailbox, which must exist here first (`POST …/open`).
 */
export const transferRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;

const addressOf = (c: C) => { try { return decodeURIComponent(c.req.param("email") ?? "").trim().toLowerCase(); } catch { return ""; } };
const box = (env: Env, email: string) => env.MAILBOX.get(env.MAILBOX.idFromName(email));
const valid = (email: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 254;
const nothing = (c: C, email: string) => c.json({ error: msg("No mailbox {email} on this server", { email }) }, 404);

async function exists(env: Env, email: string) { return !!(await env.BUCKET.head(settingsKey(email))); }

/** What a move starts from: the settings, how much there is, and what still holds it (sends, new mail being handled). */
transferRouter.get("/api/transfer/:email", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const stub = box(c.env, email);
  const [settings, ids, blockers] = await Promise.all([readSettings(c.env.BUCKET, email), stub.renameIds(), stub.renameBlockers()]);
  return c.json({ address: email, settings, counts: { emails: ids.emails.length, attachments: ids.attachments.length }, blockers, tables: RENAME_TABLES });
});

/** One page of a mail table, with the files its rows name. */
transferRouter.get("/api/transfer/:email/rows", async (c) => {
  const email = addressOf(c);
  const table = c.req.query("table");
  if (!isTable(table)) return c.json({ error: msg("Choose a table: {tables}", { tables: RENAME_TABLES.join(", ") }) }, 400);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? MAX_PAGE) || MAX_PAGE, 1), MAX_PAGE);
  const page = await box(c.env, email).exportPage(table, after, limit);
  const rows = encodeRows(page.rows);
  return c.json({ table, rows, next: page.next, files: blobKeysOf(table, rows) });
});

/** One file of the mailbox, as base64; only a file one of its rows names. */
transferRouter.get("/api/transfer/:email/file", async (c) => {
  const email = addressOf(c);
  const key = c.req.query("key") ?? "";
  if (!BLOB_KEY.test(key) || !valid(email) || !(await box(c.env, email).ownsBlob(key))) return c.json({ error: msg("No such file in {email}", { email }) }, 404);
  const object = await c.env.BUCKET.get(key);
  if (!object) return c.json({ error: msg("The file {key} is missing from storage", { key }), missing: true }, 404);
  if (object.size > MAX_BLOB_BYTES) return c.json({ error: msg("The file {key} is larger than a transfer carries ({size} bytes)", { key, size: String(object.size) }) }, 413);
  return c.json({ key, size: object.size, contentType: object.httpMetadata?.contentType ?? null, data: toBase64(new Uint8Array(await object.arrayBuffer())) });
});

/** Every message and attachment id, to count a copy against. */
transferRouter.get("/api/transfer/:email/ids", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  return c.json(await box(c.env, email).renameIds());
});

/** The receiving side: makes the mailbox with the settings it had (no agent answers it until one is chosen here). */
transferRouter.post("/api/transfer/:email/open", async (c) => {
  const email = addressOf(c);
  if (!valid(email)) return c.json({ error: msg("Enter a valid email address") }, 400);
  const body = await c.req.json<{ settings?: Record<string, unknown> }>().catch(() => ({}) as { settings?: Record<string, unknown> });
  const settings = body.settings && typeof body.settings === "object" && !Array.isArray(body.settings) ? body.settings : {};
  const result = await createMailbox(c.env, email, typeof settings.fromName === "string" ? settings.fromName : "", { ...settings, agent: "off" });
  if (result.status === "forbidden") return c.json({ error: result.reason }, 403);
  return c.json({ address: email, created: result.status !== "exists" });
});

/** The receiving side: one page of rows from the sending server's `rows`, ids kept. */
transferRouter.post("/api/transfer/:email/rows", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const body = await c.req.json<{ table?: unknown; rows?: unknown }>().catch(() => ({}) as { table?: unknown; rows?: unknown });
  if (!isTable(body.table)) return c.json({ error: msg("Choose a table: {tables}", { tables: RENAME_TABLES.join(", ") }) }, 400);
  let rows;
  try { rows = decodeRows(body.rows); } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  const written = await box(c.env, email).importRows(body.table, rows);
  return c.json({ table: body.table, received: rows.length, written });
});

/** The receiving side: one file, after the row that names it; one already here with the same size is left as it is. */
transferRouter.put("/api/transfer/:email/file", async (c) => {
  const email = addressOf(c);
  const body = await c.req.json<{ key?: unknown; data?: unknown; contentType?: unknown }>().catch(() => ({}) as { key?: unknown; data?: unknown; contentType?: unknown });
  const key = typeof body.key === "string" ? body.key : "";
  if (!BLOB_KEY.test(key) || typeof body.data !== "string") return c.json({ error: msg("Send the file's key and its data as base64") }, 400);
  if (!valid(email) || !(await box(c.env, email).ownsBlob(key))) return c.json({ error: msg("Copy the row that names {key} first", { key }) }, 409);
  let bytes: Uint8Array;
  try { bytes = fromBase64(body.data); } catch { return c.json({ error: msg("Send the file's key and its data as base64") }, 400); }
  if (bytes.byteLength > MAX_BLOB_BYTES) return c.json({ error: msg("The file {key} is larger than a transfer carries ({size} bytes)", { key, size: String(bytes.byteLength) }) }, 413);
  const here = await c.env.BUCKET.head(key);
  if (here && here.size === bytes.byteLength) return c.json({ key, written: false });
  await c.env.BUCKET.put(key, bytes, typeof body.contentType === "string" ? { httpMetadata: { contentType: body.contentType.slice(0, 200) } } : undefined);
  return c.json({ key, written: true });
});

/** The receiving side: which of the sending server's ids this copy still lacks. */
transferRouter.post("/api/transfer/:email/check", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const body = await c.req.json<{ emails?: unknown; attachments?: unknown }>().catch(() => ({}) as { emails?: unknown; attachments?: unknown });
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 200_000) : []);
  const source = { emails: list(body.emails), attachments: list(body.attachments) };
  const missing = missingIds(source, await box(c.env, email).renameIds());
  return c.json({ complete: !missing.emails.length && !missing.attachments.length, missing: { emails: missing.emails.slice(0, 100), attachments: missing.attachments.slice(0, 100) },
    counts: { emails: missing.emails.length, attachments: missing.attachments.length } });
});

// Step 3b: what a mailbox carries besides mail. Its rules (AutomationDO, named by the address), the agent its settings
// name and that agent's knowledge collections. Workspace-wide things (agents, collections) are matched on the
// receiving server, so a repeat finds what the first call made instead of adding another.

const registry = (env: Env) => env.AGENT_REGISTRY.getByName("workspace");
const knowledge = (env: Env) => env.KNOWLEDGE.getByName("workspace");
const rulesOf = (env: Env, email: string) => env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(email));

/** The agent the mailbox's settings name, if it is live here. */
async function agentOf(env: Env, email: string) {
  const assignment = readAssignment(await readSettings(env.BUCKET, email));
  return assignment && assignment !== "off" ? registry(env).getAgent(assignment.id) : null;
}

/** A knowledge store error crosses RPC as `code: detail`. */
function knowledgeFailure(c: C, error: unknown) {
  const m = ((error as Error)?.message ?? "").match(/(not_found|invalid|conflict|limit): (.*)$/s);
  if (m) return c.json({ error: m[2] }, m[1] === "not_found" ? 404 : m[1] === "conflict" ? 409 : 400);
  console.error(JSON.stringify({ event: "transfer_knowledge_error", error: String((error as Error)?.message).slice(0, 300) }));
  return c.json({ error: msg("Knowledge is unavailable right now. Try again.") }, 503);
}

/** The sending side: the mailbox's rules, its agent, and the agent's collections with their documents listed. */
transferRouter.get("/api/transfer/:email/setup", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const [rules, agent] = await Promise.all([rulesOf(c.env, email).rules(), agentOf(c.env, email)]);
  const collections: { id: string; name: string; description: string; documents: { id: string; sourceUri: string; title: string; revision: string; chars: number }[] }[] = [];
  for (const id of agent?.collections ?? []) {
    const collection = await knowledge(c.env).getCollection(id);
    if (!collection) continue;
    const documents = await knowledge(c.env).listDocuments(id);
    collections.push({ id, name: collection.name, description: collection.description,
      documents: documents.map((d) => ({ id: d.id, sourceUri: d.sourceUri, title: d.title, revision: d.revision, chars: d.chars })) });
  }
  return c.json({ address: email, rules, agent, collections });
});

/** The sending side: one document's text, only of a collection the mailbox's agent reads. */
transferRouter.get("/api/transfer/:email/document", async (c) => {
  const email = addressOf(c);
  const collection = c.req.query("collection") ?? "";
  const document = c.req.query("document") ?? "";
  const agent = valid(email) && (await exists(c.env, email)) ? await agentOf(c.env, email) : null;
  const read = agent?.collections.includes(collection) ? await knowledge(c.env).readDocument(collection, document) : null;
  if (!read) return c.json({ error: msg("No such document in the knowledge of {email}", { email }) }, 404);
  return c.json({ collection, sourceUri: read.document.sourceUri, title: read.document.title, revision: read.document.revision, text: read.text });
});

/** The receiving side: the rules, as they were (each was reviewed and enabled on the sending server). */
transferRouter.post("/api/transfer/:email/rules", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const body = await c.req.json<{ rules?: unknown }>().catch(() => ({}) as { rules?: unknown });
  if (!Array.isArray(body.rules) || body.rules.length > 50) return c.json({ error: msg("Send the rules as a list of at most 50") }, 400);
  const saved: string[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const rule of body.rules) {
    const id = String((rule as { id?: unknown })?.id ?? "");
    try { saved.push((await rulesOf(c.env, email).saveRule(rule)).id); }
    catch (error) {
      // A schema refusal arrives as Zod's issue list; a tool host this server does not allow arrives in words.
      const text = (error as Error)?.message ?? "";
      refused.push({ id, reason: !text || text.startsWith("[") || text === "ZodError" ? msg("Invalid rule or tool host is not enabled") : text.slice(0, 300) });
    }
  }
  return c.json({ saved, refused });
});

/** The receiving side: a collection for the documents; one here with the same name is used again. */
transferRouter.post("/api/transfer/:email/collection", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const body = await c.req.json<{ name?: unknown; description?: unknown }>().catch(() => ({}) as { name?: unknown; description?: unknown });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: msg("A collection needs a name") }, 400);
  try {
    const here = (await knowledge(c.env).listCollections()).find((x) => x.name === name.slice(0, 80));
    if (here) return c.json({ id: here.id, created: false });
    const made = await knowledge(c.env).createCollection({ name, description: typeof body.description === "string" ? body.description : "" });
    return c.json({ id: made.id, created: true });
  } catch (error) { return knowledgeFailure(c, error); }
});

/** The receiving side: up to 100 documents into a collection, by source URI (a repeat changes nothing). */
transferRouter.post("/api/transfer/:email/documents", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const body = await c.req.json<{ collection?: unknown; documents?: unknown }>().catch(() => ({}) as { collection?: unknown; documents?: unknown });
  if (typeof body.collection !== "string" || !Array.isArray(body.documents)) return c.json({ error: msg("Send a collection and its documents") }, 400);
  // A copy for a move, not a change of the knowledge: no events, and the copied text is not sent back.
  try { const { changed: _changed, pruned: _pruned, ...result } = await knowledge(c.env).upsertDocuments(body.collection, body.documents); return c.json(result); }
  catch (error) { return knowledgeFailure(c, error); }
});

/**
 * The receiving side: the agent, its collections named as they are here (`collections` maps the sending server's
 * ids to these). An agent here with the same definition is used again; otherwise a new one is made. It is not
 * assigned: the address keeps no agent until its mail comes here (step 3c, or update_address).
 */
transferRouter.post("/api/transfer/:email/agent", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const body = await c.req.json<{ agent?: unknown; collections?: unknown }>().catch(() => ({}) as { agent?: unknown; collections?: unknown });
  const map = body.collections && typeof body.collections === "object" && !Array.isArray(body.collections) ? body.collections as Record<string, unknown> : {};
  const agent = body.agent as { id?: unknown } | undefined;
  if (!agent || typeof agent !== "object" || typeof agent.id !== "string") return c.json({ error: msg("Send the agent as export_mailbox gave it") }, 400);
  const input = agentInputOf(agent, map);
  const known = new Set((await knowledge(c.env).listCollections()).map((x) => x.id));
  const missing = input.collections.filter((id) => !known.has(id));
  if (missing.length) return c.json({ error: msg("No such knowledge collection: {names}", { names: missing.join(", ") }) }, 400);
  try {
    const same = (await registry(c.env).listAgents()).find((a) => sameAgent(a, input));
    if (same) return c.json({ id: same.id, created: false });
    return c.json({ id: (await registry(c.env).createAgent(input, agent.id)).id, created: true });
  } catch (error) {
    const known = registryError(error);
    if (known) return c.json({ error: known.detail, code: known.code }, known.code === "agent_conflict" ? 409 : 400);
    console.error(JSON.stringify({ event: "transfer_agent_error", error: String((error as Error)?.message).slice(0, 300) }));
    return c.json({ error: msg("Agents are unavailable right now") }, 503);
  }
});

// Step 3b part 2: the mailbox's category labels, spam checks and safety checks (CategoriesDO rows of the account
// `cloudflare:<address>`, the same id on both servers).
const LABEL_TABLES = ["verdicts", "spam_checks", "safety"] as const;
const categories = (env: Env) => env.CATEGORIES.getByName("workspace");
const labelsAccount = (email: string) => `cloudflare:${email}`;

/** The sending side: without `table`, the categories its labels name; with one, a page of that table. */
transferRouter.get("/api/transfer/:email/labels", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const table = c.req.query("table");
  if (!table) return c.json({ categories: await categories(c.env).labelCategories(labelsAccount(email)), tables: LABEL_TABLES });
  if (!(LABEL_TABLES as readonly string[]).includes(table)) return c.json({ error: msg("Choose a table: {tables}", { tables: LABEL_TABLES.join(", ") }) }, 400);
  const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 500) || 500, 1), 500);
  return c.json({ table, ...(await categories(c.env).exportLabels(labelsAccount(email), table, after, limit)) });
});

/** The receiving side: one page of a labels table, with the sending server's categories to match against. */
transferRouter.post("/api/transfer/:email/labels", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const body = await c.req.json<{ table?: unknown; rows?: unknown; categories?: unknown }>().catch(() => ({}) as { table?: unknown; rows?: unknown; categories?: unknown });
  if (typeof body.table !== "string" || !(LABEL_TABLES as readonly string[]).includes(body.table)) return c.json({ error: msg("Choose a table: {tables}", { tables: LABEL_TABLES.join(", ") }) }, 400);
  const plain = (row: unknown) => !!row && typeof row === "object" && !Array.isArray(row)
    && Object.values(row as Record<string, unknown>).every((v) => v === null || typeof v === "string" || typeof v === "number");
  if (!Array.isArray(body.rows) || body.rows.length > 500 || !body.rows.every(plain)) return c.json({ error: msg("Send the rows as export_mailbox gave them") }, 400);
  const sources = (Array.isArray(body.categories) ? body.categories : []).flatMap((x) => {
    const v = x as { id?: unknown; version?: unknown; description?: unknown; conditions?: unknown };
    return typeof v?.id === "string" && typeof v.version === "number" ? [{ id: v.id, version: v.version, description: String(v.description ?? ""), conditions: v.conditions ?? {} }] : [];
  });
  return c.json({ table: body.table, received: body.rows.length,
    ...(await categories(c.env).importLabels(labelsAccount(email), body.table, body.rows as Record<string, string | number | null>[], sources)) });
});

// Step 3c: the address's mail moves. On the sending server a hold stops new sends from the copy there and turns its
// agent off; on the receiving server its Cloudflare rule is pointed at this server's Worker, with the rule as it was
// kept for the way back. Delivery is then checked with send_test_message and check_test_message here.

const routeKey = (email: string) => `transfer-routes/${email}.json`;
interface RouteJournal { address: string; previous: Rule; worker: string; routedAt: string; backAt?: string }

function domains(env: Env): DomainManager | null {
  const accounts = new CloudflareAccounts(env);
  return accounts.connected ? new DomainManager(accounts, env) : null;
}
function routeFailure(c: C, error: unknown) {
  if (error instanceof BringRefused) return c.json({ error: error.message }, error.status);
  if (error instanceof CloudflareApiError) return c.json({ error: error.message }, 502);
  console.error(JSON.stringify({ event: "transfer_route_error", error: String((error as Error)?.message).slice(0, 300) }));
  return c.json({ error: msg("Unexpected error: {error}", { error: (error as Error)?.message ?? "" }) }, 500);
}

/** The sending side: hold the copy here while its mail moves (no new sends, no agent), or release the hold. */
transferRouter.post("/api/transfer/:email/hold", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const body = await c.req.json<{ release?: unknown }>().catch(() => ({}) as { release?: unknown });
  const stub = box(c.env, email);
  const held = await stub.movedState();
  if (body.release === true) {
    if (!held) return c.json({ address: email, held: false, changed: false });
    // The agent as it was, kept as JSON text (an RPC value must have a known shape); null: the settings named none.
    if (held.agent !== null) await updateSettings(c.env.BUCKET, email, (s) => ({ ...s, agent: JSON.parse(held.agent as string) }));
    await stub.setMoved(null);
    return c.json({ address: email, held: false, changed: true });
  }
  if (held) return c.json({ address: email, held: true, changed: false, since: held.at });
  const at = new Date().toISOString();
  const agent = (await readSettings(c.env.BUCKET, email))?.agent;
  await stub.setMoved({ at, agent: agent === undefined ? null : JSON.stringify(agent) });
  await updateSettings(c.env.BUCKET, email, (s) => ({ ...s, agent: "off" }));
  return c.json({ address: email, held: true, changed: true, since: at });
});

/** The receiving side: where the move of the address's mail stands. */
transferRouter.get("/api/transfer/:email/route", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const journal = await (await c.env.BUCKET.get(routeKey(email)))?.json<RouteJournal>() ?? null;
  const manager = domains(c.env);
  let here: boolean | null = null;
  if (manager) try { here = (await manager.addressRule(email)).here; } catch { here = null; }
  return c.json({ address: email, routed: !!journal && !journal.backAt, here, journal: journal && { worker: journal.worker, routedAt: journal.routedAt, backAt: journal.backAt ?? null,
    previous: { enabled: journal.previous.enabled !== false, actions: journal.previous.actions } } });
});

/**
 * The receiving side: point the address's rule here once the copy has every message and attachment the sending
 * server counted (`expect`, from export_mailbox manifest's counts). The rule as it was is written down first.
 */
transferRouter.post("/api/transfer/:email/route", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const body = await c.req.json<{ expect?: { emails?: unknown; attachments?: unknown } }>().catch(() => ({}) as { expect?: { emails?: unknown; attachments?: unknown } });
  const want = { emails: Number(body.expect?.emails), attachments: Number(body.expect?.attachments) };
  if (!Number.isInteger(want.emails) || !Number.isInteger(want.attachments)) return c.json({ error: msg("Give expect: the manifest's counts of messages and attachments") }, 400);
  const ids = await box(c.env, email).renameIds();
  if (ids.emails.length < want.emails || ids.attachments.length < want.attachments)
    return c.json({ error: msg("The copy is not complete yet: {emails} of {wantEmails} messages, {attachments} of {wantAttachments} attachments", {
      emails: String(ids.emails.length), wantEmails: String(want.emails), attachments: String(ids.attachments.length), wantAttachments: String(want.attachments) }) }, 409);
  const manager = domains(c.env);
  if (!manager) return c.json({ error: msg("This server has no Cloudflare token yet. Create one with the permissions listed, then save it on the server as CLOUDFLARE_API_TOKEN.") }, 503);
  try {
    const before = await manager.addressRule(email);
    const old = await (await c.env.BUCKET.get(routeKey(email)))?.json<RouteJournal>();
    if (before.here && old && !old.backAt) return c.json({ address: email, routed: true, changed: false });
    if (!before.here) await c.env.BUCKET.put(routeKey(email), JSON.stringify({ address: email, previous: before.rule, worker: before.ctx.worker, routedAt: new Date().toISOString() } satisfies RouteJournal));
    const done = await manager.pointAddressHere(email);
    return c.json({ address: email, routed: true, changed: !done.here, from: before.action.value ?? null });
  } catch (error) { return routeFailure(c, error); }
});

/** The receiving side: the way back, the rule as it was before `route`, while it still points here. */
transferRouter.post("/api/transfer/:email/unroute", async (c) => {
  const email = addressOf(c);
  if (!valid(email) || !(await exists(c.env, email))) return nothing(c, email);
  const journal = await (await c.env.BUCKET.get(routeKey(email)))?.json<RouteJournal>();
  if (!journal) return c.json({ error: msg("{email} was not routed here by a move", { email }) }, 404);
  const manager = domains(c.env);
  if (!manager) return c.json({ error: msg("This server has no Cloudflare token yet. Create one with the permissions listed, then save it on the server as CLOUDFLARE_API_TOKEN.") }, 503);
  try {
    const outcome = await manager.pointAddressBack(email, journal.previous);
    if (outcome === "changed") return c.json({ error: msg("The rule for {email} was changed since the move; it is left as it is", { email }) }, 409);
    if (!journal.backAt) await c.env.BUCKET.put(routeKey(email), JSON.stringify({ ...journal, backAt: new Date().toISOString() }));
    return c.json({ address: email, routed: false, changed: outcome === "back" });
  } catch (error) { return routeFailure(c, error); }
});
