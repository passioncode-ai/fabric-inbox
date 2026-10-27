import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";
import { createMailbox, readSettings, settingsKey } from "../lib/mailbox-store";
import { blobKeysOf, BLOB_KEY, decodeRows, encodeRows, fromBase64, isTable, MAX_BLOB_BYTES, MAX_PAGE, missingIds, toBase64 } from "../lib/mailbox-transfer";
import { RENAME_TABLES } from "../durableObject/rename-tables";

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
