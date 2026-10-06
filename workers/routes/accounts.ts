import { bodyLimit } from 'hono/body-limit';
import { MAX_SEND_REQUEST_BYTES } from '../../shared/mail/attachments';
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { configuration } from "../providers/google-oauth";
import type { GmailBindings } from "../providers/accounts-do";
import type { GmailFolder, SendRequest } from "../providers/account-service";
import { ProviderError } from "../providers/gmail-client";
import { renderResult } from "../gmail-setup/result-page";
import { authorizationProblem } from "../gmail-setup/google-check";
import { projectNumberOf } from "../../shared/mail/gmail-reasons";
import { ImapConnectBody, ImapPasswordBody } from "../providers/imap/connect";
import { authorizeOutcome, microsoftConfiguration } from "../providers/outlook/oauth";
import { renderOutlookResult } from "../microsoft-setup/result-page";
import { OUTLOOK_CONNECT_PATH } from "../../shared/mail/microsoft-setup";
import { createT, type Locale, type T } from "../../shared/i18n";
import { requestLocale } from "../../shared/i18n/server";

/** Mount behind the app's Cloudflare Access middleware, before the SSR fallback. */
export const accountsRouter = new Hono<{ Bindings: GmailBindings }>();
const cookie = "__Host-fabric-gmail-state";
const outlookCookie = "__Host-fabric-outlook-state";
/**
 * The language a sign-in started in, kept beside its state cookie for the same ten minutes: the
 * callback's page speaks it (L10N-01). Google and Microsoft send the person back to the callback
 * with no language of their own, and the system browser has none of the app's cookies, so the
 * connect request's `?lang=`, `fabric-inbox-locale` cookie or Accept-Language is what is kept.
 */
const gmailLocaleCookie = "__Host-fabric-gmail-lang";
const outlookLocaleCookie = "__Host-fabric-outlook-lang";
accountsRouter.use("/api/accounts/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  if (c.req.method !== "GET") {
    const config = configuration(c.env);
    const microsoft = microsoftConfiguration(c.env);
    const path = new URL(c.req.url).pathname;
    // Connecting Gmail needs Google's setup, connecting Outlook Microsoft's; every other change (an
    // IMAP account, a mail action on any account) needs neither.
    if (config.status !== "configured" && path.startsWith("/api/accounts/gmail/"))
      return c.json({ error: "not_configured", configuration: config }, 503);
    if (microsoft.status !== "configured" && path.startsWith("/api/accounts/outlook/"))
      return c.json({ error: "not_configured", configuration: microsoft }, 503);
    // Browser mutations require the app's own origin: the configured one (PUBLIC_APP_URL, which Gmail
    // and Outlook share), else the server's. Server tools use DO RPC or set it themselves (mcp/handler.ts).
    const expected = config.status === "configured" ? config.origin : microsoft.status === "configured" ? microsoft.origin : new URL(c.req.url).origin;
    if (c.req.header("Origin") !== expected)
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
    // Connecting an IMAP account, or giving it a new password (imap/client.ts, imap/smtp.ts): what
    // the person changes (400), what the server could not reach (502), what is already there (409).
    auth_failed: 400,
    app_password_required: 400,
    imap_disabled: 400,
    auth_or_imap_disabled: 400,
    web_login_required: 400,
    smtp_auth_failed: 400,
    smtp_auth_unsupported: 502,
    tls_failed: 502,
    host_unreachable: 502,
    smtp_unreachable: 502,
    smtp_tls_failed: 502,
    smtp_refused: 502,
    invalid_server: 400,
    imap_tls_required: 400,
    port_blocked: 400,
    invalid_password: 400,
    already_connected: 409,
    not_supported: 400,
    // Sending through SMTP: refused before anything left (safe to retry with the same key).
    recipient_rejected: 400,
    sender_rejected: 400,
    message_rejected: 400,
    smtputf8_unsupported: 400,
    smtp_temporary_failure: 503,
    smtp_connection_lost: 503,
    attachment_not_found: 404,
    folder_missing: 404,
    // Outlook (Microsoft Graph): the server's app registration, the mailbox, Graph's refusals.
    microsoft_secret_expired: 502,
    microsoft_client_rejected: 502,
    mailbox_unavailable: 404,
    admin_consent_required: 403,
    access_denied: 403,
    provider_rejected: 400,
    delta_reset: 503,
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
  // Where a person connects another Gmail (gmail_connect_link) or Outlook account
  // (outlook_connect_link): the configured origin only.
  const config = configuration(c.env);
  const microsoft = microsoftConfiguration(c.env);
  return c.json({ ...(await stub(c.env).listAccounts()),
    ...(config.status === "configured" ? { connectUrl: new URL("/api/accounts/gmail/connect", config.origin).href } : {}),
    ...(microsoft.status === "configured" ? { outlookConnectUrl: new URL(OUTLOOK_CONNECT_PATH, microsoft.origin).href } : {}) });
});
/**
 * The providers this server can connect and the IMAP presets with their help pages: no account,
 * no secret. Settings → Accounts reads it for its cards, list_mail_providers for agents.
 */
accountsRouter.get("/api/accounts/providers", async (c) => {
  if (!c.env.GMAIL_ACCOUNTS) return c.json({ providers: [], presets: [] });
  return c.json(await stub(c.env).mailProviders());
});
/**
 * Connects an IMAP account with an app password (SCN-053): checked with the provider's IMAP and
 * SMTP servers before it is kept, sealed, on this server. Not an agent tool: an agent never
 * receives a person's password (mcp/tools.ts NOT_TOOLS).
 */
accountsRouter.post("/api/accounts/imap", async (c) => {
  const parsed = ImapConnectBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_account_settings" }, 400);
  return c.json(await stub(c.env).connectImap(parsed.data), 201);
});
/** A new app password for an IMAP account, checked before it replaces the old one. Not an agent tool either. */
accountsRouter.put("/api/accounts/:accountId/password", async (c) => {
  const parsed = ImapPasswordBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_password" }, 400);
  return c.json(await stub(c.env).updateImapPassword(c.req.param("accountId"), parsed.data.password));
});
/** The browser's side of connecting: every answer is a page a person can act on (result-page.ts). */
const pageFor = (c: Context<{ Bindings: GmailBindings }>, t: T, outcome: string, extra: { email?: string; accessUntil?: number; googleError?: string } = {}) => {
  const config = configuration(c.env);
  const page = renderResult({ outcome, ...extra, projectNumber: projectNumberOf(c.env.GOOGLE_CLIENT_ID),
    ...(config.status === "configured" ? { origin: config.origin, redirectUri: config.redirectUri } : {}) }, t);
  // Through the context, so a cookie set or cleared on it travels with the page.
  return c.body(page.html, page.status as 200, page.headers);
};
/** The translator for this request's own language (`?lang=`, the app's cookie, Accept-Language). */
const requestT = (c: Context<{ Bindings: GmailBindings }>) => createT(requestLocale(c.req.raw));
/** Keeps the language a sign-in starts in, beside its state cookie. */
const keepLocale = (c: Context<{ Bindings: GmailBindings }>, name: string) => setCookie(c, name, requestLocale(c.req.raw), browserCookie);
/**
 * The language a sign-in started in; the callback request's own when none was kept (another
 * browser, more than ten minutes) or the value is not a language this app speaks.
 */
const startedT = (c: Context<{ Bindings: GmailBindings }>, name: string, clear: boolean): T => {
  const kept = getCookie(c, name);
  if (clear) deleteCookie(c, name, { path: "/", secure: true });
  return kept === "en" || kept === "ru" ? createT(kept satisfies Locale) : requestT(c);
};
const codeOf = (error: unknown) => (error instanceof ProviderError ? error.code : (error as Error)?.message) || "account_service_unavailable";
accountsRouter.get("/api/accounts/gmail/connect", async (c) => {
  const t = requestT(c);
  const config = configuration(c.env);
  if (config.status !== "configured") return pageFor(c, t, "not_configured");
  if (new URL(c.req.url).origin !== config.origin) return pageFor(c, t, "invalid_origin");
  let result: { authorizationUrl: string; browserToken: string };
  try {
    result = await stub(c.env).beginConnect();
  } catch (error) {
    return pageFor(c, t, codeOf(error));
  }
  // Google shows a dead end of its own for a redirect URI or client it does not know; this server
  // says what to change instead, before the person leaves for Google.
  const problem = await authorizationProblem(result.authorizationUrl);
  if (problem) {
    console.warn(JSON.stringify({ event: "gmail_connect_blocked", problem }));
    return pageFor(c, t, problem);
  }
  setCookie(c, cookie, result.browserToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  keepLocale(c, gmailLocaleCookie);
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
  keepLocale(c, gmailLocaleCookie);
  return c.json({ authorizationUrl: result.authorizationUrl });
});
accountsRouter.get("/api/accounts/gmail/callback", async (c) => {
  const config = configuration(c.env);
  if (config.status !== "configured") return pageFor(c, startedT(c, gmailLocaleCookie, false), "not_configured");
  if (new URL(c.req.url).origin !== config.origin) return pageFor(c, startedT(c, gmailLocaleCookie, false), "invalid_origin");
  const browserToken = getCookie(c, cookie) || "";
  deleteCookie(c, cookie, { path: "/", secure: true });
  const t = startedT(c, gmailLocaleCookie, true);
  // Google's own word for a refusal, shown only from a fixed list: the query is not page content.
  const googleError = c.req.query("error");
  const known = googleError && /^[a-z_]{1,40}$/.test(googleError) ? googleError : googleError ? "unknown_error" : undefined;
  try {
    const account = await stub(c.env).callback(
      c.req.query("state") || "",
      browserToken,
      c.req.query("code") || "",
      googleError,
    );
    console.log(JSON.stringify({ event: "gmail_connected", limited: !!account.accessUntil }));
    // A fixed page, not a redirect: OAuth parameters cannot choose where the browser goes next.
    return pageFor(c, t, "connected", { email: account.email, accessUntil: account.accessUntil });
  } catch (error) {
    const code = codeOf(error);
    console.warn(JSON.stringify({ event: "gmail_connect_failed", error: code, googleError: known ?? null }));
    return pageFor(c, t, code, { googleError: known });
  }
});
// ── Outlook (Microsoft Graph): the same browser flow as Gmail's, against Microsoft's sign-in ──
const outlookPage = (c: Context<{ Bindings: GmailBindings }>, t: T, outcome: string, extra: { email?: string } = {}) => {
  const config = microsoftConfiguration(c.env);
  const page = renderOutlookResult({ outcome, ...extra,
    ...(config.status === "configured" ? { origin: config.origin, redirectUri: config.redirectUri, clientId: config.clientId } : {}) }, t);
  return c.body(page.html, page.status as 200, page.headers);
};
const browserCookie = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/", maxAge: 600 };
/** SCN-058: opens Microsoft's sign-in for a new (or the same) Outlook account. */
accountsRouter.get("/api/accounts/outlook/connect", async (c) => {
  const t = requestT(c);
  const config = microsoftConfiguration(c.env);
  if (config.status !== "configured") return outlookPage(c, t, "not_configured");
  if (new URL(c.req.url).origin !== config.origin) return outlookPage(c, t, "invalid_origin");
  let result: { authorizationUrl: string; browserToken: string };
  try {
    result = await stub(c.env).beginOutlookConnect();
  } catch (error) {
    return outlookPage(c, t, codeOf(error));
  }
  setCookie(c, outlookCookie, result.browserToken, browserCookie);
  keepLocale(c, outlookLocaleCookie);
  return c.redirect(result.authorizationUrl, 302);
});
accountsRouter.post("/api/accounts/outlook/connect", async (c) => {
  const result = await stub(c.env).beginOutlookConnect();
  setCookie(c, outlookCookie, result.browserToken, browserCookie);
  keepLocale(c, outlookLocaleCookie);
  return c.json({ authorizationUrl: result.authorizationUrl });
});
/**
 * Microsoft's redirect back (SCN-058, SCN-059): a code to redeem, an error instead of one (read into
 * the page's outcome, never shown as Microsoft wrote it), or the end of an administrator's approval
 * (`admin_consent=True`), which keeps nothing and says to connect now.
 */
accountsRouter.get("/api/accounts/outlook/callback", async (c) => {
  const config = microsoftConfiguration(c.env);
  if (config.status !== "configured") return outlookPage(c, startedT(c, outlookLocaleCookie, false), "not_configured");
  if (new URL(c.req.url).origin !== config.origin) return outlookPage(c, startedT(c, outlookLocaleCookie, false), "invalid_origin");
  const error = c.req.query("error");
  if (c.req.query("admin_consent") !== undefined) {
    // Microsoft's own warning: the tenant on this redirect is never proof of anything, so it is not read.
    const approved = /^true$/i.test(c.req.query("admin_consent") ?? "") && !error;
    console.log(JSON.stringify({ event: "outlook_admin_consent", approved }));
    // An administrator's approval usually ends in their own browser: its language, unless this one kept one.
    return outlookPage(c, startedT(c, outlookLocaleCookie, false), approved ? "admin_consented" : "admin_consent_declined");
  }
  const browserToken = getCookie(c, outlookCookie) || "";
  deleteCookie(c, outlookCookie, { path: "/", secure: true });
  const t = startedT(c, outlookLocaleCookie, true);
  const outcome = error ? authorizeOutcome(error.slice(0, 64), (c.req.query("error_description") ?? "").slice(0, 2000)) : undefined;
  try {
    const account = await stub(c.env).outlookCallback(c.req.query("state") || "", browserToken, c.req.query("code") || "", outcome);
    // A fixed page, not a redirect: OAuth parameters cannot choose where the browser goes next.
    return outlookPage(c, t, "connected", { email: account.email });
  } catch (failure) {
    const code = codeOf(failure);
    console.warn(JSON.stringify({ event: "outlook_connect_failed", error: code }));
    return outlookPage(c, t, code);
  }
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
      ...(text("threadId") ? { threadId: text("threadId") } : {}),
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
