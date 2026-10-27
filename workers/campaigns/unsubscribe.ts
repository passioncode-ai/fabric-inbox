/**
 * B-181: one-click unsubscribe for campaign messages (RFC 8058), the server's only page outside Cloudflare Access.
 *
 * A campaign message carries `List-Unsubscribe: <https://<server>/u/<token>>, <mailto:…>` with
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` once the server has its Bypass application on `<host>/u`
 * (made by the server itself at a campaign's launch, as the fabric-service application is). The token is the
 * address and an HMAC of it under a key derived from the server's credential key: nobody can make one for another
 * address. GET only shows a button (a link scanner that opens it changes nothing); POST puts the address on the
 * do-not-write list. Nothing else is reachable on this path, and it reads nothing but the token.
 */
import type { CloudflareApi } from "../routing/cloudflare-api";
import { cloudflareApi, accountIdFor } from "../routing/cloudflare-api";
import { createT, msg, type Locale } from "../../shared/i18n";

export const UNSUBSCRIBE_ACCESS_KEY = "config/unsubscribe-access.json";
export interface UnsubscribeAccess { host: string; appId: string; createdAt: string }
const LABEL = "fabric-inbox/unsubscribe/v1\n";
const WHAT = "let people unsubscribe from campaigns with one click (Access: Apps and Policies: Edit)";
export const UNSUBSCRIBE_POLICY = "Fabric Inbox unsubscribe (everyone)";
export const unsubscribeAppName = (host: string) => `Fabric Inbox unsubscribe ${host}`.slice(0, 120);
/** The path a token is served on; anything else under /u is not the unsubscribe page. */
export const UNSUBSCRIBE_PATH = /^\/u\/(1\.[A-Za-z0-9_-]{4,700}\.[A-Za-z0-9_-]{22})$/;

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** The secret the tokens are signed with: derived from the server's credential key; none, no one-click. */
export function unsubscribeSecret(env: { MAIL_CREDENTIAL_KEY?: string; GMAIL_TOKEN_ENCRYPTION_KEY?: string }): string | null {
  const key = env.MAIL_CREDENTIAL_KEY || env.GMAIL_TOKEN_ENCRYPTION_KEY;
  return key && key.length >= 16 ? key : null;
}
async function signature(secret: string, email: string): Promise<Uint8Array> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(LABEL + secret));
  const key = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email))).slice(0, 16);
}
export async function unsubscribeToken(secret: string, email: string): Promise<string> {
  return `1.${b64u(new TextEncoder().encode(email.toLowerCase()))}.${b64u(await signature(secret, email.toLowerCase()))}`;
}
/** The address a token was made for, or null when it was not made with this secret. */
export async function tokenAddress(secret: string, token: string): Promise<string | null> {
  const [version, address, sig] = token.split(".");
  if (version !== "1" || !address || !sig) return null;
  let email: string, given: Uint8Array;
  try { email = new TextDecoder("utf-8", { fatal: true }).decode(unb64u(address)); given = unb64u(sig); } catch { return null; }
  const expected = await signature(secret, email);
  if (given.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given[i]! ^ expected[i]!;
  return diff === 0 && /^[^\s@<>"]+@[^\s@<>"]+$/.test(email) ? email : null;
}

/** The one-click target for an address, when the server has its Bypass application and a secret; else null. */
export async function oneClickUrl(env: { BUCKET?: R2Bucket; MAIL_CREDENTIAL_KEY?: string; GMAIL_TOKEN_ENCRYPTION_KEY?: string }, email: string,
  access?: UnsubscribeAccess | null): Promise<string | null> {
  const secret = unsubscribeSecret(env);
  const config = access === undefined ? await readUnsubscribeAccess(env.BUCKET) : access;
  if (!secret || !config) return null;
  return `https://${config.host}/u/${await unsubscribeToken(secret, email)}`;
}
export async function readUnsubscribeAccess(bucket: R2Bucket | undefined): Promise<UnsubscribeAccess | null> {
  const object = await bucket?.get(UNSUBSCRIBE_ACCESS_KEY);
  if (!object) return null;
  const value = await object.json<Partial<UnsubscribeAccess>>().catch(() => null);
  return value && typeof value.host === "string" && /^[a-z0-9.-]+$/i.test(value.host) && typeof value.appId === "string" ? (value as UnsubscribeAccess) : null;
}

type AccessApp = { id: string; name?: string; domain?: string };
type AccessPolicy = { id: string; name: string };
/** Makes the Bypass application on `<host>/u` when it is missing; never touches any other application. */
export async function ensureUnsubscribeApp(api: CloudflareApi, account: string, host: string): Promise<{ state: "created" | "already"; access: UnsubscribeAccess }> {
  const domain = `${host}/u`;
  const apps = await api.list<AccessApp>(`/accounts/${account}/access/apps`, WHAT, 100);
  const found = apps.find((a) => a.name === unsubscribeAppName(host) || a.domain === domain);
  if (found) return { state: "already", access: { host, appId: found.id, createdAt: new Date().toISOString() } };
  const policies = await api.list<AccessPolicy>(`/accounts/${account}/access/policies`, WHAT, 100);
  const policy = policies.find((p) => p.name === UNSUBSCRIBE_POLICY)
    ?? await api.call<AccessPolicy>(`/accounts/${account}/access/policies`, { method: "POST", what: WHAT,
      body: { name: UNSUBSCRIBE_POLICY, decision: "bypass", include: [{ everyone: {} }] } });
  const app = await api.call<AccessApp>(`/accounts/${account}/access/apps`, { method: "POST", what: WHAT, body: {
    name: unsubscribeAppName(host), type: "self_hosted", domain, app_launcher_visible: false, session_duration: "24h",
    policies: [{ id: policy.id, precedence: 1 }],
  } });
  return { state: "created", access: { host, appId: app.id, createdAt: new Date().toISOString() } };
}

/** At a campaign's launch: the Bypass application for this host, once; a failure leaves the `mailto:` stop only. */
export async function provisionUnsubscribe(env: Parameters<typeof cloudflareApi>[0] & { BUCKET: R2Bucket }, host: string): Promise<string> {
  if (!/^[a-z0-9.-]+$/i.test(host) || /^(localhost|127\.)/.test(host)) return "local";
  const known = await readUnsubscribeAccess(env.BUCKET);
  if (known?.host === host) return "already";
  const api = cloudflareApi(env);
  if (!api) return "no_token";
  try {
    const result = await ensureUnsubscribeApp(api, await accountIdFor(api, env as never), host);
    await env.BUCKET.put(UNSUBSCRIBE_ACCESS_KEY, JSON.stringify(result.access));
    console.log(JSON.stringify({ event: "unsubscribe_access", state: result.state }));
    return result.state;
  } catch (error) {
    console.error(JSON.stringify({ event: "unsubscribe_access_failed", error: (error as Error).message.slice(0, 200) }));
    return "failed";
  }
}

const PAGE = {
  title: msg("Unsubscribe"),
  ask: msg("Stop emails to {email}?"),
  explain: msg("You will not get any more messages from this sender's campaigns."),
  button: msg("Unsubscribe"),
  done: msg("Done. {email} will not get any more messages from this sender's campaigns."),
  invalid: msg("This unsubscribe link is not valid. Reply to the message with \"unsubscribe\" instead."),
  unavailable: msg("Unsubscribing is not available right now. Reply to the message with \"unsubscribe\" instead."),
};
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function page(locale: Locale, body: string, status: number): Response {
  const t = createT(locale);
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${escape(t.text(PAGE.title))}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}`
    + `button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #888;background:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer" } });
}
const localeOf = (header: string | null): Locale => (/^\s*ru\b/i.test(header ?? "") ? "ru" : "en");

/** The page at /u/<token>: GET asks, POST (a form, or a mail client's one-click) puts the address on the list. */
export async function handleUnsubscribe(request: Request, env: { MAIL_CREDENTIAL_KEY?: string; GMAIL_TOKEN_ENCRYPTION_KEY?: string;
  CAMPAIGNS?: { getByName(name: string): { unsubscribe(email: string, reason: string): Promise<unknown> } } }, token: string): Promise<Response> {
  const locale = localeOf(request.headers.get("accept-language"));
  const t = createT(locale);
  const secret = unsubscribeSecret(env);
  if (!secret || !env.CAMPAIGNS) return page(locale, `<p>${escape(t.text(PAGE.unavailable))}</p>`, 503);
  const email = await tokenAddress(secret, token);
  if (!email) return page(locale, `<p>${escape(t.text(PAGE.invalid))}</p>`, 404);
  if (request.method === "GET" || request.method === "HEAD")
    return page(locale, `<h1>${escape(t.text(PAGE.ask).replace("{email}", email))}</h1><p>${escape(t.text(PAGE.explain))}</p>`
      + `<form method="post"><button type="submit">${escape(t.text(PAGE.button))}</button></form>`, 200);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  try { await env.CAMPAIGNS.getByName("workspace").unsubscribe(email, "one_click_unsubscribe"); }
  catch (error) {
    console.error(JSON.stringify({ event: "unsubscribe_failed", error: String((error as Error)?.message ?? error).slice(0, 200) }));
    return page(locale, `<p>${escape(t.text(PAGE.unavailable))}</p>`, 503);
  }
  console.log(JSON.stringify({ event: "unsubscribed", via: "one_click" }));
  return page(locale, `<p>${escape(t.text(PAGE.done).replace("{email}", email))}</p>`, 200);
}
