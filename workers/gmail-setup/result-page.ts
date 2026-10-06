/**
 * The page a person sees in the browser at the end of connecting Gmail (SCN-002, SCN-003): for a
 * connected account and for every way it can fail, what happened and the one thing to do next —
 * never raw JSON. The connect flow runs in the system browser (Google forbids its sign-in inside an
 * app's own web view: https://developers.google.com/identity/protocols/oauth2/policies), so this
 * page also says to go back to the app.
 *
 * Self-contained: inline styles in the Fabric palette, no script, nothing loaded from elsewhere;
 * every value is escaped. The response forbids framing and scripts outright.
 */
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

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const link = (href: string, text: string, external = false) =>
  `<a href="${esc(href)}"${external ? ' target="_blank" rel="noreferrer noopener"' : ""}>${esc(text)}${external ? " ↗" : ""}</a>`;

interface Page { status: number; title: string; tone: "ok" | "warn" | "bad"; body: string[]; actions: string[] }

const CONNECT = "/api/accounts/gmail/connect";
const ACCOUNTS = "/settings/accounts";
const again = () => link(CONNECT, "Connect Gmail again");
const backToApp = "You can close this tab and go back to Fabric Inbox.";

function page(input: ResultInput): Page {
  switch (input.outcome) {
    case "connected": {
      const body = [`<strong>${esc(input.email ?? "Your Gmail account")}</strong> is connected. Your server is importing its mail now; new mail arrives while the import runs.`];
      if (input.accessUntil) {
        const until = new Date(input.accessUntil).toUTCString();
        body.push(`<span class="callout">Google gave this access only until ${esc(until)}. ${esc(GMAIL_REASON_TEXT.testing_expiry.explain)} ${link(GOOGLE_CONSOLE.audience, "Open Audience in Google Cloud", true)}, choose Publish app, then reconnect the account: access then lasts until it is removed.</span>`);
      }
      return { status: 200, title: "Gmail is connected", tone: input.accessUntil ? "warn" : "ok", body: [...body, backToApp],
        actions: [link(ACCOUNTS, "Open Settings → Accounts here")] };
    }
    case "oauth_denied":
      return input.googleError && input.googleError !== "access_denied"
        ? { status: 400, title: "Google stopped the sign-in", tone: "bad",
            body: [`Google ended it with “${esc(input.googleError)}”, so Fabric Inbox has no access and nothing was saved.`,
              "A Google Workspace administrator may have to allow the app for your organization."], actions: [again()] }
        : { status: 400, title: "Gmail was not connected", tone: "warn",
            body: ["You chose not to allow access on Google's page, so nothing was saved.",
              `If Google said the app “has not completed the Google verification process” or that you have no access: in Google Cloud, ${link(GOOGLE_CONSOLE.audience, "open Audience", true)} and add this Google account under Test users, or choose Publish app. On “Google hasn't verified this app”, choose Advanced, then continue: it is your own app.`],
            actions: [again()] };
    case "insufficient_scope":
      return { status: 403, title: "The Gmail box was not ticked", tone: "warn",
        body: [esc(GMAIL_REASON_TEXT.insufficient_scope.explain) + " The account was not connected.",
          "Connect again, and on Google's page tick the box for reading, composing and sending your email."], actions: [again()] };
    case "gmail_api_disabled":
      return { status: 403, title: "The Gmail API is off in your Google Cloud project", tone: "bad",
        body: [esc(GMAIL_REASON_TEXT.gmail_api_disabled.explain),
          `${link(gmailApiUrl(input.projectNumber), "Enable the Gmail API", true)}, wait a minute, then connect again.`], actions: [again()] };
    case "redirect_uri_mismatch":
      return { status: 400, title: "Google does not know this server's redirect URI", tone: "bad",
        body: [`Your OAuth client in Google Cloud needs this address under Authorized redirect URIs:`,
          `<code>${esc(input.redirectUri ?? "(the server's address)/api/accounts/gmail/callback")}</code>`,
          `${link(GOOGLE_CONSOLE.clients, "Open Clients in Google Cloud", true)}, open your client, add it exactly, and save. Google can take a few minutes to apply it; then connect again.`],
        actions: [again()] };
    case "google_client_rejected":
      return { status: 502, title: "Google refused this server's OAuth client", tone: "bad",
        body: [esc(GMAIL_REASON_TEXT.client_rejected.explain),
          "In Fabric Inbox, open Settings → Accounts → Connect account → Gmail and save the client ID and secret again; then connect."],
        actions: [link(ACCOUNTS, "Open Settings → Accounts here")] };
    case "invalid_state":
      return { status: 403, title: "This sign-in has expired", tone: "warn",
        body: ["It was started more than ten minutes ago, was already used, or was opened in another browser than the one that started it. Nothing was saved."],
        actions: [again()] };
    case "oauth_failed":
      return { status: 400, title: "Google did not finish the sign-in", tone: "warn",
        body: ["Google's answer could not be used: it came too late or was used already. Nothing was saved."], actions: [again()] };
    case "invalid_profile":
      return { status: 502, title: "Google did not say which Gmail account this is", tone: "bad",
        body: ["Nothing was saved. Connect again; if it happens again, this Google account may have no Gmail."], actions: [again()] };
    case "not_configured":
      return { status: 503, title: "Gmail is not set up on this server", tone: "warn",
        body: ["Set it up in Fabric Inbox: Settings → Accounts → Connect account → Gmail walks through Google Cloud step by step."],
        actions: [link(ACCOUNTS + "?connect=gmail", "Set up Gmail")] };
    case "invalid_origin":
      return { status: 403, title: "Open this from your server's own address", tone: "warn",
        body: [`Gmail is set up for ${esc(input.origin ?? "another address")}; connecting works only there.`],
        actions: input.origin ? [link(input.origin + CONNECT, "Connect Gmail at " + input.origin)] : [] };
    case "too_many_connections":
      return { status: 429, title: "Too many sign-ins are waiting", tone: "warn",
        body: ["Each one expires after ten minutes. Wait, then connect again."], actions: [again()] };
    case "provider_unavailable":
      return { status: 503, title: "Google could not be reached", tone: "warn",
        body: ["Nothing was saved. Connect again in a minute."], actions: [again()] };
    default:
      return { status: 502, title: "Gmail was not connected", tone: "bad",
        body: [`Your server could not finish connecting (${esc(input.outcome)}). Nothing was saved.`], actions: [again()] };
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
export function resultPage(input: ResultInput): Response {
  const { html, status, headers } = renderResult(input);
  return new Response(html, { status, headers });
}

/** The page's parts, for a route that adds headers of its own (a cleared cookie). */
export function renderResult(input: ResultInput): { html: string; status: number; headers: Record<string, string> } {
  const p = page(input);
  const tone = p.tone === "ok" ? "var(--ok)" : p.tone === "warn" ? "var(--warn)" : "var(--bad)";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(p.title)} · Fabric Inbox</title><style>${STYLE}</style></head>
<body><main style="--tone:${tone}" role="${p.tone === "ok" ? "status" : "alert"}"><p class="mark">Fabric Inbox · Gmail</p><h1>${esc(p.title)}</h1>
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
