import { bodyLimit } from 'hono/body-limit';
import { MAX_SEND_REQUEST_BYTES } from '../../shared/mail/attachments';
import { Hono } from "hono";
import { z } from "zod";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { configuration } from "../providers/google-oauth";
import type { GmailBindings } from "../providers/accounts-do";
import type { GmailFolder, SendRequest } from "../providers/account-service";
import { ProviderError } from "../providers/gmail-client";

/** Mount behind the app's Cloudflare Access middleware, before the SSR fallback. */
export const accountsRouter = new Hono<{ Bindings: GmailBindings }>();
const cookie = "__Host-fabric-gmail-state";
accountsRouter.use("/api/accounts/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  if (c.req.method !== "GET") {
    const config = configuration(c.env);
    if (config.status !== "configured")
      return c.json({ error: "not_configured", configuration: config }, 503);
    // Browser mutations require the configured origin; server tools use DO RPC.
    if (c.req.header("Origin") !== config.origin)
      return c.json({ error: "invalid_origin" }, 403);
    const length = Number(c.req.header("Content-Length") || 0);
    if (length > MAX_SEND_REQUEST_BYTES) return c.json({ error: "message_too_large" }, 413);
  }
  await next();
});
accountsRouter.use('/api/accounts/*', bodyLimit({ maxSize: MAX_SEND_REQUEST_BYTES, onError: c => c.json({ error: 'message_too_large' }, 413) }));
accountsRouter.onError((error, c) => {
  // DO RPC may erase instanceof, so only use an explicit allowlist of public codes.
  const codes: Record<
    string,
    400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 | 503
  > = {
    not_configured: 503,
    receipt_not_found: 404,
    invalid_attachment: 400,
    invalid_state: 403,
    oauth_denied: 400,
    oauth_failed: 400,
    insufficient_scope: 403,
    account_not_found: 404,
    message_not_found: 404,
    draft_not_found: 404,
    draft_conflict: 409,
    invalid_id: 400,
    invalid_address: 400,
    invalid_header: 400,
    invalid_message: 400,
    sender_mismatch: 400,
    message_too_large: 413,
    idempotency_key_required: 400,
    idempotency_conflict: 409,
    reconnect_required: 401,
    rate_limited: 429,
    sync_backoff: 429,
    invalid_read_state: 400,
    invalid_starred_state: 400,
    invalid_trashed_state: 400,
    invalid_spam_state: 400,
    invalid_filter: 400,
    invalid_folder: 400,
    credential_store_unavailable: 503,
    message_store_unavailable: 503,
    provider_unavailable: 503,
    provider_failed: 502,
    provider_auth_failed: 503,
    too_many_connections: 429,
    // What a person or the server's Google setup must change (shared/mail/gmail-reasons.ts).
    gmail_api_disabled: 403,
    google_client_rejected: 502,
    redirect_uri_mismatch: 400,
    invalid_profile: 502,
  };
  const code = error instanceof ProviderError ? error.code : error.message;
  return c.json(
    { error: code in codes ? code : "account_service_unavailable" },
    codes[code] || 503,
  );
});
const stub = (env: GmailBindings) => {
  if (!env.GMAIL_ACCOUNTS) throw new ProviderError("not_configured", 503);
  return env.GMAIL_ACCOUNTS.getByName("workspace");
};
accountsRouter.get("/api/accounts", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!c.env.GMAIL_ACCOUNTS)
    return c.json({
      configuration: "not_configured",
      accounts: [],
      providers: [
        { id: "gmail", status: "not_configured" },
        { id: "imap", status: "not_configured" },
        { id: "outlook", status: "not_configured" },
      ],
    });
  // Where a person connects another Gmail account (gmail_connect_link): the configured origin only.
  const config = configuration(c.env);
  return c.json({ ...(await stub(c.env).listAccounts()),
    ...(config.status === "configured" ? { connectUrl: new URL("/api/accounts/gmail/connect", config.origin).href } : {}) });
});
accountsRouter.get("/api/accounts/gmail/connect", async (c) => {
  const config = configuration(c.env);
  if (config.status !== "configured")
    return c.json({ error: "not_configured" }, 503);
  if (new URL(c.req.url).origin !== config.origin)
    return c.json({ error: "invalid_origin" }, 403);
  const result = await stub(c.env).beginConnect();
  setCookie(c, cookie, result.browserToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  return c.redirect(result.authorizationUrl, 302);
});
accountsRouter.post("/api/accounts/gmail/connect", async (c) => {
  const result = await stub(c.env).beginConnect();
  setCookie(c, cookie, result.browserToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  return c.json({ authorizationUrl: result.authorizationUrl });
});
accountsRouter.get("/api/accounts/gmail/callback", async (c) => {
  const config = configuration(c.env);
  if (config.status !== "configured")
    return c.json({ error: "not_configured" }, 503);
  if (new URL(c.req.url).origin !== config.origin)
    return c.json({ error: "invalid_origin" }, 403);
  const browserToken = getCookie(c, cookie) || "";
  deleteCookie(c, cookie, { path: "/", secure: true });
  await stub(c.env).callback(
    c.req.query("state") || "",
    browserToken,
    c.req.query("code") || "",
    c.req.query("error"),
  );
  // Fixed relative path: OAuth parameters cannot choose a redirect destination.
  return c.redirect("/?gmail=connected", 303);
});
accountsRouter.post("/api/accounts/:accountId/disconnect", async (c) =>
  c.json(await stub(c.env).disconnect(c.req.param("accountId"))),
);
accountsRouter.post("/api/accounts/:accountId/sync", async (c) =>
  c.json(await stub(c.env).sync(c.req.param("accountId"))),
);
accountsRouter.get("/api/accounts/:accountId/messages", async (c) => {
  // Each field is its own filter; one that cannot be read is refused, never dropped.
  const text = (key: string) => c.req.query(key) || undefined;
  const flag = (key: string) => {
    const value = c.req.query(key);
    if (value === undefined || value === "") return undefined;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    throw new ProviderError("invalid_filter", 400);
  };
  const date = (key: string) => {
    const value = c.req.query(key);
    if (!value) return undefined;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new ProviderError("invalid_filter", 400);
    return time;
  };
  return c.json(
    await stub(c.env).listMessages(c.req.param("accountId"), {
      cursor: c.req.query("cursor"),
      limit: Number(c.req.query("limit")) || 50,
      query: text("q"), from: text("from"), to: text("to"), subject: text("subject"),
      after: date("after"), before: date("before"),
      unread: flag("unread"), starred: flag("starred"), hasAttachment: flag("hasAttachment"),
      folder: text("folder") as GmailFolder | undefined,
    }),
  );
});
accountsRouter.get("/api/accounts/:accountId/messages/:messageId", async (c) =>
  c.json(
    await stub(c.env).getMessage(
      c.req.param("accountId"),
      c.req.param("messageId"),
    ),
  ),
);
// Every header of the message, for an agent's read_message with includeHeaders ("View source").
accountsRouter.get("/api/accounts/:accountId/messages/:messageId/headers", async (c) =>
  c.json(await stub(c.env).getHeaders(c.req.param("accountId"), c.req.param("messageId"))),
);
accountsRouter.post("/api/accounts/:accountId/send", async (c) => {
  const body = await c.req.text();
  if (new TextEncoder().encode(body).length > MAX_SEND_REQUEST_BYTES) return c.json({ error: "message_too_large" }, 413);
  let input: SendRequest;
  try {
    input = JSON.parse(body);
  } catch {
    return c.json({ error: "invalid_message" }, 400);
  }
  if (!input || typeof input !== "object")
    return c.json({ error: "invalid_message" }, 400);
  const result = await stub(c.env).send(c.req.param("accountId"), input);
  return c.json(
    result,
    result.status === "accepted"
      ? 202
      : result.status === "unknown"
        ? 409
        : 400,
  );
});
accountsRouter.post(
  "/api/accounts/:accountId/messages/:messageId/read",
  async (c) => {
    const body = await c.req.json<{ read: boolean }>();
    return c.json(
      await stub(c.env).setRead(
        c.req.param("accountId"),
        c.req.param("messageId"),
        body.read,
      ),
    );
  },
);
accountsRouter.post(
  "/api/accounts/:accountId/messages/:messageId/archive",
  async (c) =>
    c.json(
      await stub(c.env).archive(
        c.req.param("accountId"),
        c.req.param("messageId"),
      ),
    ),
);
accountsRouter.post(
  "/api/accounts/:accountId/messages/:messageId/inbox",
  async (c) =>
    c.json(
      await stub(c.env).moveToInbox(
        c.req.param("accountId"),
        c.req.param("messageId"),
      ),
    ),
);
accountsRouter.get(
  "/api/accounts/:accountId/messages/:messageId/attachments/:attachmentId",
  async (c) =>
    c.json(
      await stub(c.env).getAttachment(
        c.req.param("accountId"),
        c.req.param("messageId"),
        c.req.param("attachmentId"),
      ),
    ),
);

accountsRouter.get(
  "/api/accounts/:accountId/sends/:idempotencyKey",
  async (c) =>
    c.json(
      await stub(c.env).getSendReceipt(
        c.req.param("accountId"),
        c.req.param("idempotencyKey"),
      ),
    ),
);
accountsRouter.get(
  "/api/accounts/:accountId/drafts/:idempotencyKey",
  async (c) =>
    c.json(
      await stub(c.env).getDraftReceipt(
        c.req.param("accountId"),
        c.req.param("idempotencyKey"),
      ),
    ),
);
accountsRouter.post("/api/accounts/:accountId/drafts", async (c) => {
  const body = await c.req.text();
  if (new TextEncoder().encode(body).length > MAX_SEND_REQUEST_BYTES) return c.json({ error: "message_too_large" }, 413);
  let input: SendRequest;
  try {
    input = JSON.parse(body);
  } catch {
    return c.json({ error: "invalid_message" }, 400);
  }
  if (!input || typeof input !== "object")
    return c.json({ error: "invalid_message" }, 400);
  const result = await stub(c.env).createDraft(c.req.param("accountId"), input);
  return c.json(
    result,
    result.status === "accepted"
      ? 201
      : result.status === "unknown"
        ? 409
        : 400,
  );
});

// ── Gmail's own drafts (B-50, B-52): listed, read, changed, deleted and sent in Gmail ──
/** PUT /drafts/:draftId — the whole message (as a send takes it), the revision read, the files kept. */
export const GmailDraftUpdateBody = z.object({
  to: z.array(z.string()).max(100).default([]), cc: z.array(z.string()).max(100).optional(), bcc: z.array(z.string()).max(100).optional(),
  subject: z.string().max(998).default(""), text: z.string().max(1_000_000), html: z.string().max(1_000_000).optional(),
  threadId: z.string().max(200).optional(), inReplyTo: z.string().max(998).optional(), references: z.string().max(998).optional(),
  attachments: z.array(z.unknown()).max(10).optional(),
  /** The draft's message id when it was read; absent overwrites. */
  expectedRevision: z.string().max(200).optional(),
  /** Ids of the draft's files to keep; absent keeps them all. */
  keepAttachments: z.array(z.string().max(2048)).max(10).optional(),
}).strict();
export const GmailDraftSendBody = z.object({ idempotencyKey: z.string().min(1).max(128), expectedRevision: z.string().max(200).optional() }).strict();

accountsRouter.get("/api/accounts/:accountId/drafts", async (c) =>
  c.json(await stub(c.env).listDrafts(c.req.param("accountId"), c.req.query("cursor") || undefined)),
);
// One draft in full; "/content" because /drafts/:idempotencyKey is a draft's creation receipt.
accountsRouter.get("/api/accounts/:accountId/drafts/:draftId/content", async (c) =>
  c.json(await stub(c.env).getDraft(c.req.param("accountId"), c.req.param("draftId"))),
);
accountsRouter.put("/api/accounts/:accountId/drafts/:draftId", async (c) => {
  const parsed = GmailDraftUpdateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_message" }, 400);
  return c.json(await stub(c.env).updateDraft(c.req.param("accountId"), c.req.param("draftId"), parsed.data as never));
});
accountsRouter.delete("/api/accounts/:accountId/drafts/:draftId", async (c) =>
  c.json(await stub(c.env).deleteDraft(c.req.param("accountId"), c.req.param("draftId"))),
);
accountsRouter.post("/api/accounts/:accountId/drafts/:draftId/send", async (c) => {
  const parsed = GmailDraftSendBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "idempotency_key_required" }, 400);
  const result = await stub(c.env).sendDraft(c.req.param("accountId"), c.req.param("draftId"), parsed.data.idempotencyKey, parsed.data.expectedRevision);
  return c.json(result, result.status === "accepted" ? 200 : result.status === "unknown" ? 409 : 400);
});

for (const field of ["starred", "trashed"] as const) {
  accountsRouter.post(`/api/accounts/:accountId/messages/:messageId/${field}`, async c => {
    const body = await c.req.json<unknown>().catch(() => null);
    const value = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)[field] : undefined;
    if (typeof value !== "boolean") return c.json({ error: `invalid_${field}_state` }, 400);
    const accountId = c.req.param("accountId"), messageId = c.req.param("messageId");
    if (![accountId, messageId].every(id => /^[A-Za-z0-9_-]{1,128}$/.test(id)))
      return c.json({ error: "invalid_id" }, 400);
    return c.json(await (field === "starred"
      ? stub(c.env).setStarred(accountId, messageId, value)
      : stub(c.env).setTrashed(accountId, messageId, value)));
  });
}
