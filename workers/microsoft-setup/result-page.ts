/**
 * The page a person sees in the browser at the end of connecting an Outlook account (SCN-057,
 * SCN-058, SCN-059): for a connected account and for every way it can fail, what happened and the
 * one thing to do next — never raw JSON. The sign-in runs in the system browser, so the page also
 * says to go back to the app. The same shell as Gmail's (workers/gmail-setup/result-page.ts):
 * inline styles, no script, nothing loaded from elsewhere, every value escaped.
 *
 * When an organization lets only its administrators allow apps, Microsoft stops the sign-in and the
 * person cannot finish it alone; the page gives the link their administrator opens (Microsoft's
 * admin consent endpoint: https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent),
 * which comes back here with `admin_consent=True` and nothing to keep.
 */
import { GMAIL_REASON_TEXT } from "../../shared/mail/gmail-reasons";
import { MICROSOFT_ACCOUNT_TYPES, MICROSOFT_ENTRA, MICROSOFT_HELP, OUTLOOK_CONNECT_PATH, adminConsentUrl } from "../../shared/mail/microsoft-setup";
import { esc, link, renderPage, type Page } from "../gmail-setup/result-page";

export interface OutlookResultInput {
  /** "connected", "admin_consented", or the public error code the connect or callback route met. */
  outcome: string;
  email?: string;
  /** The server's configured address, redirect URI and client ID, for the steps that name them. */
  origin?: string;
  redirectUri?: string;
  clientId?: string;
}

const ACCOUNTS = "/settings/accounts";
const SETUP = ACCOUNTS + "?connect=microsoft";
const again = () => link(OUTLOOK_CONNECT_PATH, "Connect Outlook again");
const setupLink = () => link(SETUP, "Open the Outlook setup");
const backToApp = "You can close this tab and go back to Fabric Inbox.";
const nothingSaved = "Nothing was saved.";

function page(input: OutlookResultInput): Page {
  switch (input.outcome) {
    case "connected":
      return { status: 200, title: "Outlook is connected", tone: "ok",
        body: [`<strong>${esc(input.email ?? "Your Outlook account")}</strong> is connected. Your server is importing its mail now, the Inbox first; new mail arrives while the import runs.`, backToApp],
        actions: [link(ACCOUNTS, "Open Settings → Accounts here")] };
    case "admin_consented":
      return { status: 200, title: "Your organization allows Fabric Inbox now", tone: "ok",
        body: ["The administrator allowed Fabric Inbox for everyone in the organization. Now connect the Outlook account itself: sign in with it and allow access."],
        actions: [again()] };
    case "admin_consent_declined":
      return { status: 403, title: "The administrator did not allow Fabric Inbox", tone: "warn",
        body: ["Microsoft ended the approval without allowing the app, so no one in the organization can connect it yet. " + nothingSaved,
          "Ask the administrator to open the approval link again and choose Accept."], actions: [] };
    case "oauth_denied":
      return { status: 400, title: "Outlook was not connected", tone: "warn",
        body: ["You chose not to allow access on Microsoft's page, so Fabric Inbox has no access. " + nothingSaved,
          "Fabric Inbox asks only to read, change and send your mail, and to keep that access while you are away; connect again and choose Accept to allow it."],
        actions: [again()] };
    case "admin_consent_required": {
      const approve = input.clientId && input.redirectUri ? adminConsentUrl(input.clientId, input.redirectUri) : null;
      return { status: 403, title: "Your organization's administrator must allow Fabric Inbox first", tone: "warn",
        body: ["Your work or school account belongs to an organization that lets only its administrators allow apps to read mail, so Microsoft stopped the sign-in. " + nothingSaved,
          ...(approve ? ["Send this link to an administrator of your organization. They sign in, read what Fabric Inbox asks for, and choose Accept; then connect again:",
            `<code>${esc(approve)}</code>`] : ["An administrator of your organization can allow it in the Microsoft Entra admin center, under Enterprise apps."]),
          `Personal accounts (Outlook.com, Hotmail, Live) never need this. ${link(MICROSOFT_HELP.userConsent, "How organizations decide who may allow apps", true)}`],
        actions: [again()] };
    }
    case "redirect_uri_mismatch":
      return { status: 400, title: "Microsoft does not know this server's redirect URI", tone: "bad",
        body: ["Your app registration in Microsoft Entra needs this address as a Web redirect URI:",
          `<code>${esc(input.redirectUri ?? "(the server's address)/api/accounts/outlook/callback")}</code>`,
          `${link(MICROSOFT_ENTRA.appRegistrations, "Open App registrations in Microsoft Entra", true)}, open your app, then Authentication → Add Redirect URI → Web, add it exactly, and save. Then connect again.`],
        actions: [again()] };
    case "microsoft_secret_expired":
      return { status: 502, title: "The client secret on your server has expired", tone: "bad",
        body: [esc(GMAIL_REASON_TEXT.microsoft_secret_expired.explain),
          `${link(MICROSOFT_ENTRA.appRegistrations, "Open App registrations in Microsoft Entra", true)}, open your app, then Certificates &amp; secrets → New client secret. In Fabric Inbox, save its Value and its end date in Settings → Accounts → Connect account → Outlook.`],
        actions: [setupLink()] };
    case "microsoft_client_rejected":
      return { status: 502, title: "Microsoft refused this server's app registration", tone: "bad",
        body: [esc(GMAIL_REASON_TEXT.microsoft_client_rejected.explain),
          "In Fabric Inbox, open Settings → Accounts → Connect account → Outlook and save the Application (client) ID and a client secret Value again; then connect."],
        actions: [setupLink()] };
    case "microsoft_account_type":
      return { status: 400, title: "This kind of Microsoft account cannot use your app registration", tone: "bad",
        body: [`Microsoft refused the sign-in for this account. The app registration must accept every kind of account: under Supported account types it needs “${esc(MICROSOFT_ACCOUNT_TYPES)}”.`,
          `${link(MICROSOFT_ENTRA.appRegistrations, "Open App registrations in Microsoft Entra", true)}, open your app and check Supported account types on its Authentication page (or register a new app with that choice and save it in Fabric Inbox). Then connect again.`],
        actions: [setupLink()] };
    case "signin_incomplete":
      return { status: 400, title: "Microsoft needs one more sign-in step", tone: "warn",
        body: ["The sign-in stopped before it was finished: a multi-factor step, a password change, or a sign-in rule of your organization. " + nothingSaved,
          "Connect again and finish every step Microsoft shows."], actions: [again()] };
    case "insufficient_scope":
      return { status: 403, title: "Microsoft did not give all the access Fabric Inbox needs", tone: "warn",
        body: ["Reading and sending mail, and keeping the access while you are away, are all needed; one of them was not given, so the account was not connected.",
          "Connect again and choose Accept on Microsoft's page."], actions: [again()] };
    case "mailbox_unavailable":
      return { status: 404, title: "This Microsoft account has no Outlook mailbox to read", tone: "bad",
        body: ["Microsoft accepted the sign-in, but Microsoft Graph has no mailbox for this account: a personal Microsoft account without Outlook.com mail, or a work mailbox that is not in Microsoft 365. " + nothingSaved,
          "Connect with the account whose mail you read in Outlook."], actions: [again()] };
    case "already_connected":
      return { status: 409, title: "This address is already connected another way", tone: "warn",
        body: ["It is connected as an IMAP or Gmail account, and the same mail is not read twice. Disconnect it in Settings → Accounts first, then connect it through Microsoft."],
        actions: [link(ACCOUNTS, "Open Settings → Accounts here")] };
    case "invalid_state":
      return { status: 403, title: "This sign-in has expired", tone: "warn",
        body: ["It was started more than ten minutes ago, was already used, or was opened in another browser than the one that started it. " + nothingSaved], actions: [again()] };
    case "oauth_failed":
      return { status: 400, title: "Microsoft did not finish the sign-in", tone: "warn",
        body: ["Microsoft's answer could not be used: it came too late or was used already. " + nothingSaved], actions: [again()] };
    case "invalid_profile":
      return { status: 502, title: "Microsoft did not say which mailbox this is", tone: "bad",
        body: [nothingSaved + " Connect again; if it happens again, this Microsoft account may have no email address."], actions: [again()] };
    case "not_configured":
      return { status: 503, title: "Outlook is not set up on this server", tone: "warn",
        body: ["Set it up in Fabric Inbox: Settings → Accounts → Connect account → Outlook walks through Microsoft Entra step by step."],
        actions: [link(SETUP, "Set up Outlook")] };
    case "invalid_origin":
      return { status: 403, title: "Open this from your server's own address", tone: "warn",
        body: [`Outlook is set up for ${esc(input.origin ?? "another address")}; connecting works only there.`],
        actions: input.origin ? [link(input.origin + OUTLOOK_CONNECT_PATH, "Connect Outlook at " + input.origin)] : [] };
    case "too_many_connections":
      return { status: 429, title: "Too many sign-ins are waiting", tone: "warn",
        body: ["Each one expires after ten minutes. Wait, then connect again."], actions: [again()] };
    case "rate_limited":
    case "provider_unavailable":
      return { status: 503, title: "Microsoft could not be reached", tone: "warn",
        body: [nothingSaved + " Connect again in a minute."], actions: [again()] };
    default:
      return { status: 502, title: "Outlook was not connected", tone: "bad",
        body: [`Your server could not finish connecting (${esc(input.outcome)}). ${nothingSaved}`], actions: [again()] };
  }
}

/** The page's parts, for a route that adds headers of its own (a cleared cookie). */
export function renderOutlookResult(input: OutlookResultInput) {
  return renderPage(page(input), "Outlook");
}

/** The result page as a Response, with headers that let it do nothing but show itself. */
export function outlookResultPage(input: OutlookResultInput): Response {
  const { html, status, headers } = renderOutlookResult(input);
  return new Response(html, { status, headers });
}
