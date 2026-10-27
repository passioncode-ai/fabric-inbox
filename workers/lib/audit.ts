/**
 * B-156 (consolidation report B3, Q12: the audit lives in Inbox): a durable record of who changed the list of
 * people and what members sent. One R2 object per entry under `audit/`, its key starting with an inverted
 * time so a listing reads newest first. Entries are only added; nothing here edits or deletes one. A send
 * entry names the mailbox, the recipients and the subject, never the message's text.
 */
export const AUDIT_PREFIX = "audit/";
const MAX_TIME = 9_999_999_999_999;

export type AuditEntry =
  | { kind: "member_saved"; person: string; role: "admin" | "member"; mailboxes: string[] | null; previous: { role: string; mailboxes: string[] | null } | null }
  | { kind: "member_removed"; person: string; previous: { role: string; mailboxes: string[] | null } }
  | { kind: "keys_revoked"; person: string; keys: string[] }
  | { kind: "member_sent"; mailbox: string; route: string; to: string[]; subject: string | null; message: string | null };

export type AuditRecord = AuditEntry & { id: string; at: string; actor: string | null };

/**
 * Who acted on a request the server made to itself for an agent (workers/mcp/handler.ts `inProcessApi`):
 * keyed by the Request object, so no header a caller sends can claim it.
 */
export const inProcessActors = new WeakMap<Request, string>();

/** The acting person's email, or the agent's caller id for an in-process request; null when unknown (local development). */
export function actorOf(raw: Request, standingEmail: string | null | undefined): string | null {
  return standingEmail ?? inProcessActors.get(raw) ?? null;
}

// Entries of one millisecond keep their order too: a later one gets a smaller sequence, so it lists first.
let sequence = 0;
const keyFor = (at: number, id: string) =>
  `${AUDIT_PREFIX}${String(MAX_TIME - at).padStart(13, "0")}-${String(999_999 - (sequence++ % 1_000_000)).padStart(6, "0")}-${id}`;

/** Adds one entry. A failure is logged and never undoes the act it records. */
export async function recordAudit(bucket: R2Bucket, actor: string | null, entry: AuditEntry, now = Date.now()): Promise<AuditRecord | null> {
  const id = crypto.randomUUID();
  const record = { ...entry, id, at: new Date(now).toISOString(), actor } as AuditRecord;
  try {
    await bucket.put(keyFor(now, id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
    return record;
  } catch (error) {
    console.error(JSON.stringify({ event: "audit_write_failed", kind: entry.kind, error: (error as Error).message.slice(0, 200) }));
    return null;
  }
}

/** A page of entries, newest first; `cursor` is the previous page's. */
export async function readAudit(bucket: R2Bucket, options: { limit?: number; cursor?: string } = {}): Promise<{ entries: AuditRecord[]; cursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const listed = await bucket.list({ prefix: AUDIT_PREFIX, limit, ...(options.cursor ? { cursor: options.cursor } : {}) });
  const entries: AuditRecord[] = [];
  for (const object of listed.objects) {
    const body = await bucket.get(object.key);
    if (!body) continue;
    try { entries.push(JSON.parse(await body.text()) as AuditRecord); } catch { /* a damaged entry is skipped, the rest still read */ }
  }
  return { entries, cursor: listed.truncated ? listed.cursor : null };
}

/** The routes that send mail (the agent tools marked `sends` that send mail; tests/audit.test.ts keeps them equal). */
export const SEND_ROUTES: readonly { route: string; pattern: RegExp }[] = [
  ["POST /api/v1/mailboxes/:mailboxId/emails", /^\/api\/v1\/mailboxes\/([^/]+)\/emails$/],
  ["POST /api/v1/mailboxes/:mailboxId/emails/:id/reply", /^\/api\/v1\/mailboxes\/([^/]+)\/emails\/[^/]+\/reply$/],
  ["POST /api/v1/mailboxes/:mailboxId/emails/:id/forward", /^\/api\/v1\/mailboxes\/([^/]+)\/emails\/[^/]+\/forward$/],
  ["POST /api/v1/mailboxes/:mailboxId/drafts/:id/send", /^\/api\/v1\/mailboxes\/([^/]+)\/drafts\/[^/]+\/send$/],
  ["POST /api/accounts/:accountId/send", /^\/api\/accounts\/([^/]+)\/send$/],
  ["POST /api/accounts/:accountId/drafts/:draftId/send", /^\/api\/accounts\/([^/]+)\/drafts\/[^/]+\/send$/],
  ["POST /api/automation/:account/runs/:id/approve", /^\/api\/automation\/([^/]+)\/runs\/[^/]+\/approve$/],
].map(([route, pattern]) => ({ route: route as string, pattern: pattern as RegExp }));

/** The send route a request is, with its mailbox, or null. */
export function sendRouteOf(method: string, pathname: string): { route: string; mailbox: string } | null {
  if (method !== "POST") return null;
  for (const { route, pattern } of SEND_ROUTES) {
    const m = pattern.exec(pathname);
    if (m) { try { return { route, mailbox: decodeURIComponent(m[1]!) }; } catch { return { route, mailbox: m[1]! }; } }
  }
  return null;
}

const addresses = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.flatMap((v) => typeof v === "string" ? v.split(",") : v && typeof v === "object" && typeof (v as { email?: unknown }).email === "string" ? [(v as { email: string }).email] : [])
    .map((a) => a.trim().toLowerCase()).filter(Boolean).slice(0, 100);
};

/** A member's send, from the request body and the answer: recipients and subject when the request names them (a draft's send does not), never the text. */
export function memberSent(send: { route: string; mailbox: string }, body: unknown, answer: unknown): AuditEntry {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const a = (answer && typeof answer === "object" ? answer : {}) as Record<string, unknown>;
  const message = [a.messageId, a.id, a.outboxId].find((v) => typeof v === "string" && v) as string | undefined;
  return { kind: "member_sent", mailbox: send.mailbox, route: send.route, to: [...new Set([...addresses(b.to), ...addresses(b.cc), ...addresses(b.bcc)])],
    subject: typeof b.subject === "string" ? b.subject.slice(0, 300) : null, message: message ? message.slice(0, 200) : null };
}
