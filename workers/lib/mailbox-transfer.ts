// B-158 M1 step 3a (docs/app-store/tasks/2026-10-27-organizations.md, "Moving a mailbox between servers"): a mailbox is
// read out of one server and written into another, page by page, keeping every id, so the copy can be counted against
// the source. The same mail tables a rename copies (RENAME_TABLES), its settings, and the R2 files its rows name
// (a message's stored body, its attachments). Rows and files are only added or brought up to date on the receiving
// server; nothing here deletes, routes or changes the sending server.
import { RENAME_TABLES, type RenameRow, type RenameTable } from "../durableObject/rename-tables";

/** The largest file a transfer carries in one call; an attachment over it is refused by name, never cut. */
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;
export const MAX_PAGE = 100;

/** Only a message body or an attachment is a mailbox's file in the shared bucket. */
export const BLOB_KEY = /^(?:attachments\/[^/]+\/[^/]+\/[^/].*|bodies\/[^/]+)$/;

export const isTable = (value: unknown): value is RenameTable => typeof value === "string" && (RENAME_TABLES as readonly string[]).includes(value);

const toBase64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Rows as JSON carries them: bytes become `{ $bytes: base64 }`. */
export function encodeRows(rows: RenameRow[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof ArrayBuffer ? { $bytes: toBase64(new Uint8Array(v)) } : v])));
}

/** The rows back from JSON; anything that is not text, a number, null or `{ $bytes }` refuses the page. */
export function decodeRows(value: unknown): RenameRow[] {
  if (!Array.isArray(value) || value.length > MAX_PAGE * 5) throw new TypeError("rows must be a list of at most 500 rows");
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError("a row must be an object");
    return Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([k, v]) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new TypeError(`not a column name: ${k.slice(0, 40)}`);
      if (v === null || typeof v === "string" || typeof v === "number") return [k, v];
      if (v && typeof v === "object" && typeof (v as { $bytes?: unknown }).$bytes === "string") return [k, fromBase64((v as { $bytes: string }).$bytes).buffer as ArrayBuffer];
      throw new TypeError(`a value of ${k} is not text, a number, null or bytes`);
    }));
  });
}

/** The R2 files the rows of a page name: an attachment row's file and a message's stored body. */
export function blobKeysOf(table: RenameTable, rows: Record<string, unknown>[]): string[] {
  if (table === "attachments") return rows.flatMap((r) => (typeof r.email_id === "string" && typeof r.id === "string" && typeof r.filename === "string" ? [`attachments/${r.email_id}/${r.id}/${r.filename}`] : []));
  if (table === "emails") return rows.flatMap((r) => (typeof r.body_key === "string" && BLOB_KEY.test(r.body_key) ? [r.body_key] : []));
  return [];
}

/** What is missing on the receiving side: ids the source has that the copy lacks. Extra ids on the copy are its own mail. */
export function missingIds(source: { emails: string[]; attachments: string[] }, copy: { emails: string[]; attachments: string[] }) {
  const have = { emails: new Set(copy.emails), attachments: new Set(copy.attachments) };
  return { emails: source.emails.filter((id) => !have.emails.has(id)), attachments: source.attachments.filter((id) => !have.attachments.has(id)) };
}

/**
 * Step 3b: an agent's definition as another server takes it: what it says and grants, never its id, version or the
 * schema and read-only mark the registry reads from the tool's endpoint itself. Collections are renamed through
 * `map` (the sending server's id to the receiving one's); an id the map does not name is kept.
 */
export function agentInputOf(agent: Record<string, unknown>, map: Record<string, unknown>) {
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    name: agent.name, instructions: agent.instructions, knowledge: agent.knowledge ?? "",
    collections: list(agent.collections).map((id) => (typeof map[String(id)] === "string" ? String(map[String(id)]) : String(id))),
    tools: list(agent.tools).map((t) => { const { inputSchema: _s, readOnly: _r, ...grant } = (t ?? {}) as Record<string, unknown>; return grant; }),
    replyPolicy: agent.replyPolicy ?? {},
  } as { name: unknown; instructions: unknown; knowledge: unknown; collections: string[]; tools: Record<string, unknown>[]; replyPolicy: unknown };
}

/** Whether an agent here already says and grants what `input` does (so a repeat reuses it). */
export function sameAgent(existing: Record<string, unknown>, input: ReturnType<typeof agentInputOf>): boolean {
  const key = (a: ReturnType<typeof agentInputOf>) => JSON.stringify([a.name, a.instructions, a.knowledge, a.collections, a.tools, a.replyPolicy]);
  return key(agentInputOf(existing, {})) === key(input);
}

export { toBase64, fromBase64 };
