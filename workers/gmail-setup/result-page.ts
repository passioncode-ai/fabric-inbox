/**
 * The page a person sees in the browser at the end of connecting Gmail (SCN-002, SCN-003): for a
 * connected account and for every way it can fail, what happened and the one thing to do next —
 * never raw JSON. The connect flow runs in the system browser (Google forbids its sign-in inside an
 * app's own web view: https://developers.google.com/identity/protocols/oauth2/policies), so this
 * page also says to go back to the app.
 *
 * Self-contained: inline styles in the Fabric palette, no script, nothing loaded from elsewhere;
 * every value is escaped. The response forbids framing and scripts outright.
 *
 * In the person's language (`t`, L10N-01): the callback renders in the language the connect started
 * with (workers/routes/accounts.ts keeps it beside the sign-in's state); `<html lang>` follows.
 * The dictionary's sentences are trusted text; every value put into them is escaped as before.
 */
import { englishT, type T } from "../../shared/i18n";
import { GMAIL_REASON_TEXT, gmailApiUrl } from "../../shared/mail/gmail-reasons";
import { GOOGLE_CONSOLE } from "../../shared/mail/gmail-setup";

export interface ResultInput {
  /** "connected", or the public error code the connect or callback route met. */
  outcome: string;
  /** The Gmail address, when connected. */
  email?: string;
  /** When Google said this access ends (Testing apps): the page warns about it. */
  accessUntil?: number;
  /** The `error` Google put on the redirect (access_denied, …), when it sent one. */
  googleError?: string;
  /** The server's configured address and redirect URI, for the steps that name them. */
  origin?: string;
  redirectUri?: string;
  /** The Google Cloud project number of the client (from its ID), for the Gmail API link. */
  projectNumber?: string | null;
}

export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const link = (href: string, text: string, external = false) =>
  `<a href="${esc(href)}"${external ? ' target="_blank" rel="noreferrer noopener"' : ""}>${esc(text)}${external ? " ↗" : ""}</a>`;

/** One result page: its status, title, tone, lines (already escaped HTML) and action links. */
export interface Page { status: number; title: string; tone: "ok" | "warn" | "bad"; body: string[]; actions: string[] }

const CONNECT = "/api/accounts/gmail/connect";
const ACCOUNTS = "/settings/accounts";
/**
 * The connect address for a page in `t`'s language: a Russian page asks for its language again
 * (`?lang=ru`), since the system browser carries none of the app's cookies; English stays bare.
 */
export const withLang = (path: string, t: T) => (t.locale === "en" ? path : `${path}?lang=${t.locale}`);

function page(input: ResultInput, t: T): Page {
  const again = () => link(withLang(CONNECT, t), t("Connect Gmail again"));
  const backToApp = t("You can close this tab and go back to Fabric Inbox.");
  const accounts = () => link(ACCOUNTS, t("Open Settings → Accounts here"));
  switch (input.outcome) {
    case "connected": {
      const body = [t("{email} is connected. Your server is importing its mail now; new mail arrives while the import runs.",
        { email: `<strong>${esc(input.email ?? t("Your Gmail account"))}</strong>` })];
      if (input.accessUntil) {
        const at = new Date(input.accessUntil);
        const until = t.locale === "en" ? at.toUTCString()
          : t.dateTime(at, { timeZone: "UTC", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
        body.push(`<span class="callout">${t("Google gave this access only until {until}. {why} {audience}, choose Publish app, then reconnect the account: access then lasts until it is removed.", {
          until: esc(until), why: esc(t.text(GMAIL_REASON_TEXT.testing_expiry.explain)), audience: link(GOOGLE_CONSOLE.audience, t("Open Audience in Google Cloud"), true) })}</span>`);
      }
      return { status: 200, title: t("Gmail is connected"), tone: input.accessUntil ? "warn" : "ok", body: [...body, backToApp],
        actions: [accounts()] };
    }
    case "oauth_denied":
      return input.googleError && input.googleError !== "access_denied"
        ? { status: 400, title: t("Google stopped the sign-in"), tone: "bad",
            body: [t("Google ended it with “{error}”, so Fabric Inbox has no access and nothing was saved.", { error: esc(input.googleError) }),
              t("A Google Workspace administrator may have to allow the app for your organization.")], actions: [again()] }
        : { status: 400, title: t("Gmail was not connected"), tone: "warn",
            body: [t("You chose not to allow access on Google's page, so nothing was saved."),
              t("If Google said the app “has not completed the Google verification process” or that you have no access: in Google Cloud, {audience} and add this Google account under Test users, or choose Publish app. On “Google hasn't verified this app”, choose Advanced, then continue: it is your own app.",
                { audience: link(GOOGLE_CONSOLE.audience, t("open Audience"), true) })],
            actions: [again()] };
    case "insufficient_scope":
      return { status: 403, title: t("The Gmail box was not ticked"), tone: "warn",
        body: [esc(t.text(GMAIL_REASON_TEXT.insufficient_scope.explain)) + " " + t("The account was not connected."),
          t("Connect again, and on Google's page tick the box for reading, composing and sending your email.")], actions: [again()] };
    case "gmail_api_disabled":
      return { status: 403, title: t("The Gmail API is off in your Google Cloud project"), tone: "bad",
        body: [esc(t.text(GMAIL_REASON_TEXT.gmail_api_disabled.explain)),
          t("{enable}, wait a minute, then connect again.", { enable: link(gmailApiUrl(input.projectNumber), t("Enable the Gmail API"), true) })], actions: [again()] };
    case "redirect_uri_mismatch":
      return { status: 400, title: t("Google does not know this server's redirect URI"), tone: "bad",
        body: [t("Your OAuth client in Google Cloud needs this address under Authorized redirect URIs:"),
          `<code>${esc(input.redirectUri ?? t("(the server's address)/api/accounts/gmail/callback"))}</code>`,
          t("{clients}, open your client, add it exactly, and save. Google can take a few minutes to apply it; then connect again.",
            { clients: link(GOOGLE_CONSOLE.clients, t("Open Clients in Google Cloud"), true) })],
        actions: [again()] };
    case "google_client_rejected":
      return { status: 502, title: t("Google refused this server's OAuth client"), tone: "bad",
        body: [esc(t.text(GMAIL_REASON_TEXT.client_rejected.explain)),
          t("In Fabric Inbox, open Settings → Accounts → Connect account → Gmail and save the client ID and secret again; then connect.")],
        actions: [accounts()] };
    case "invalid_state":
      return { status: 403, title: t("This sign-in has expired"), tone: "warn",
        body: [t("It was started more than ten minutes ago, was already used, or was opened in another browser than the one that started it.") + " " + t("Nothing was saved.")],
        actions: [again()] };
    case "oauth_failed":
      return { status: 400, title: t("Google did not finish the sign-in"), tone: "warn",
        body: [t("Google's answer could not be used: it came too late or was used already.") + " " + t("Nothing was saved.")], actions: [again()] };
    case "invalid_profile":
      return { status: 502, title: t("Google did not say which Gmail account this is"), tone: "bad",
        body: [t("Nothing was saved.") + " " + t("Connect again; if it happens again, this Google account may have no Gmail.")], actions: [again()] };
    case "not_configured":
      return { status: 503, title: t("Gmail is not set up on this server"), tone: "warn",
        body: [t("Set it up in Fabric Inbox: Settings → Accounts → Connect account → Gmail walks through Google Cloud step by step.")],
        actions: [link(ACCOUNTS + "?connect=gmail", t("Set up Gmail"))] };
    case "invalid_origin":
      return { status: 403, title: t("Open this from your server's own address"), tone: "warn",
        body: [t("Gmail is set up for {origin}; connecting works only there.", { origin: esc(input.origin ?? t("another address")) })],
        actions: input.origin ? [link(withLang(input.origin + CONNECT, t), t("Connect Gmail at {origin}", { origin: input.origin }))] : [] };
    case "too_many_connections":
      return { status: 429, title: t("Too many sign-ins are waiting"), tone: "warn",
        body: [t("Each one expires after ten minutes. Wait, then connect again.")], actions: [again()] };
    case "provider_unavailable":
      return { status: 503, title: t("Google could not be reached"), tone: "warn",
        body: [t("Nothing was saved.") + " " + t("Connect again in a minute.")], actions: [again()] };
    default:
      return { status: 502, title: t("Gmail was not connected"), tone: "bad",
        body: [t("Your server could not finish connecting ({outcome}).", { outcome: esc(input.outcome) }) + " " + t("Nothing was saved.")], actions: [again()] };
  }
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--panel:#f7f5f8;--text:#211725;--muted:#655769;--border:#ddd4df;--accent:#ffd21a;--on-accent:#211900;--link:#7a5a00;--ok:#1f7a45;--warn:#8a5300;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0a070d;--panel:#110c15;--text:#fff9f0;--muted:#b6aabc;--border:#342b3a;--link:#ffd21a;--ok:#79d49a;--warn:#f6ba75;--bad:#ff969f}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:14px/1.55 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px}
main{max-width:560px;width:100%;background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:32px}
.mark{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
h1{font-size:22px;line-height:1.25;margin:0 0 16px;padding-left:12px;border-left:4px solid var(--tone)}
p{margin:0 0 12px}code{display:block;font:13px ui-monospace,"SF Mono",Menlo,monospace;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;overflow-wrap:anywhere;user-select:all}
a{color:var(--link)}.callout{display:block;border:1px solid var(--border);border-left:4px solid var(--warn);border-radius:8px;padding:8px 12px;background:var(--bg)}
.actions{margin-top:24px;display:flex;gap:12px;flex-wrap:wrap}.actions a{display:inline-block;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:600;border-radius:8px;padding:8px 16px}
.actions a:focus-visible{outline:2px solid var(--text);outline-offset:2px}`;

/** The result page as a Response, with headers that let it do nothing but show itself. */
export function resultPage(input: ResultInput, t: T = englishT): Response {
  const { html, status, headers } = renderResult(input, t);
  return new Response(html, { status, headers });
}

/** The page's parts, for a route that adds headers of its own (a cleared cookie). */
export function renderResult(input: ResultInput, t: T = englishT): { html: string; status: number; headers: Record<string, string> } {
  return renderPage(page(input, t), "Gmail", t);
}

/** Any provider's result page in the same shell: `mark` names the provider ("Gmail", "Outlook"); `t` its language. */
export function renderPage(p: Page, mark: string, t: T = englishT): { html: string; status: number; headers: Record<string, string> } {
  const tone = p.tone === "ok" ? "var(--ok)" : p.tone === "warn" ? "var(--warn)" : "var(--bad)";
  const html = `<!doctype html>
<html lang="${t.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(p.title)} · Fabric Inbox</title><style>${STYLE}</style></head>
<body><main style="--tone:${tone}" role="${p.tone === "ok" ? "status" : "alert"}"><p class="mark">Fabric Inbox · ${esc(mark)}</p><h1>${esc(p.title)}</h1>
${p.body.map((line) => `<p>${line}</p>`).join("\n")}
${p.actions.length ? `<div class="actions">${p.actions.join("")}</div>` : ""}
</main></body></html>`;
  return {
    html,
    status: p.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  };
}
