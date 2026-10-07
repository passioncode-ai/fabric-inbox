/**
 * The page a person sees in the browser at the end of connecting an Outlook account (SCN-058,
 * SCN-059, SCN-060): for a connected account and for every way it can fail, what happened and the
 * one thing to do next — never raw JSON. The sign-in runs in the system browser, so the page also
 * says to go back to the app. The same shell as Gmail's (workers/gmail-setup/result-page.ts):
 * inline styles, no script, nothing loaded from elsewhere, every value escaped.
 *
 * When an organization lets only its administrators allow apps, Microsoft stops the sign-in and the
 * person cannot finish it alone; the page gives the link their administrator opens (Microsoft's
 * admin consent endpoint: https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent),
 * which comes back here with `admin_consent=True` and nothing to keep.
 *
 * In the person's language (`t`), as Gmail's page is: the language the connect started with.
 */
import { GMAIL_REASON_TEXT } from "../../shared/mail/gmail-reasons";
import { MICROSOFT_ACCOUNT_TYPES, MICROSOFT_ENTRA, MICROSOFT_HELP, OUTLOOK_CONNECT_PATH, adminConsentUrl } from "../../shared/mail/microsoft-setup";
import { englishT, type T } from "../../shared/i18n";
import { esc, link, renderPage, withLang, type Page } from "../gmail-setup/result-page";

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

function page(input: OutlookResultInput, t: T): Page {
  const again = () => link(withLang(OUTLOOK_CONNECT_PATH, t), t("Connect Outlook again"));
  const setupLink = () => link(SETUP, t("Open the Outlook setup"));
  const backToApp = t("You can close this tab and go back to Fabric Inbox.");
  const nothingSaved = t("Nothing was saved.");
  const entra = () => link(MICROSOFT_ENTRA.appRegistrations, t("Open App registrations in Microsoft Entra"), true);
  switch (input.outcome) {
    case "connected":
      return { status: 200, title: t("Outlook is connected"), tone: "ok",
        body: [t("{email} is connected. Your server is importing its mail now, the Inbox first; new mail arrives while the import runs.",
          { email: `<strong>${esc(input.email ?? t("Your Outlook account"))}</strong>` }), backToApp],
        actions: [link(ACCOUNTS, t("Open Settings → Accounts here"))] };
    case "admin_consented":
      return { status: 200, title: t("Your organization allows Fabric Inbox now"), tone: "ok",
        body: [t("The administrator allowed Fabric Inbox for everyone in the organization. Now connect the Outlook account itself: sign in with it and allow access.")],
        actions: [again()] };
    case "admin_consent_declined":
      return { status: 403, title: t("The administrator did not allow Fabric Inbox"), tone: "warn",
        body: [t("Microsoft ended the approval without allowing the app, so no one in the organization can connect it yet.") + " " + nothingSaved,
          t("Ask the administrator to open the approval link again and choose Accept.")], actions: [] };
    case "oauth_denied":
      return { status: 400, title: t("Outlook was not connected"), tone: "warn",
        body: [t("You chose not to allow access on Microsoft's page, so Fabric Inbox has no access.") + " " + nothingSaved,
          t("Fabric Inbox asks only to read, change and send your mail, and to keep that access while you are away; connect again and choose Accept to allow it.")],
        actions: [again()] };
    case "admin_consent_required": {
      const approve = input.clientId && input.redirectUri ? adminConsentUrl(input.clientId, input.redirectUri) : null;
      return { status: 403, title: t("Your organization's administrator must allow Fabric Inbox first"), tone: "warn",
        body: [t("Your work or school account belongs to an organization that lets only its administrators allow apps to read mail, so Microsoft stopped the sign-in.") + " " + nothingSaved,
          ...(approve ? [t("Send this link to an administrator of your organization. They sign in, read what Fabric Inbox asks for, and choose Accept; then connect again:"),
            `<code>${esc(approve)}</code>`] : [t("An administrator of your organization can allow it in the Microsoft Entra admin center, under Enterprise apps.")]),
          t("Personal accounts (Outlook.com, Hotmail, Live) never need this. {link}", { link: link(MICROSOFT_HELP.userConsent, t("How organizations decide who may allow apps"), true) })],
        actions: [again()] };
    }
    case "redirect_uri_mismatch":
      return { status: 400, title: t("Microsoft does not know this server's redirect URI"), tone: "bad",
        body: [t("Your app registration in Microsoft Entra needs this address as a Web redirect URI:"),
          `<code>${esc(input.redirectUri ?? t("(the server's address)/api/accounts/outlook/callback"))}</code>`,
          t("{link}, open your app, then Authentication → Add Redirect URI → Web, add it exactly, and save. Then connect again.", { link: entra() })],
        actions: [again()] };
    case "microsoft_secret_expired":
      return { status: 502, title: t("The client secret on your server has expired"), tone: "bad",
        body: [esc(t.text(GMAIL_REASON_TEXT.microsoft_secret_expired.explain)),
          t("{link}, open your app, then Certificates &amp; secrets → New client secret. In Fabric Inbox, save its Value and its end date in Settings → Accounts → Connect account → Outlook.", { link: entra() })],
        actions: [setupLink()] };
    case "microsoft_client_rejected":
      return { status: 502, title: t("Microsoft refused this server's app registration"), tone: "bad",
        body: [esc(t.text(GMAIL_REASON_TEXT.microsoft_client_rejected.explain)),
          t("In Fabric Inbox, open Settings → Accounts → Connect account → Outlook and save the Application (client) ID and a client secret Value again; then connect.")],
        actions: [setupLink()] };
    case "microsoft_account_type":
      return { status: 400, title: t("This kind of Microsoft account cannot use your app registration"), tone: "bad",
        body: [t("Microsoft refused the sign-in for this account. The app registration must accept every kind of account: under Supported account types it needs “{types}”.", { types: esc(MICROSOFT_ACCOUNT_TYPES) }),
          t("{link}, open your app and check Supported account types on its Authentication page (or register a new app with that choice and save it in Fabric Inbox). Then connect again.", { link: entra() })],
        actions: [setupLink()] };
    case "signin_incomplete":
      return { status: 400, title: t("Microsoft needs one more sign-in step"), tone: "warn",
        body: [t("The sign-in stopped before it was finished: a multi-factor step, a password change, or a sign-in rule of your organization.") + " " + nothingSaved,
          t("Connect again and finish every step Microsoft shows.")], actions: [again()] };
    case "insufficient_scope":
      return { status: 403, title: t("Microsoft did not give all the access Fabric Inbox needs"), tone: "warn",
        body: [t("Reading and sending mail, and keeping the access while you are away, are all needed; one of them was not given, so the account was not connected."),
          t("Connect again and choose Accept on Microsoft's page.")], actions: [again()] };
    case "mailbox_unavailable":
      return { status: 404, title: t("This Microsoft account has no Outlook mailbox to read"), tone: "bad",
        body: [t("Microsoft accepted the sign-in, but Microsoft Graph has no mailbox for this account: a personal Microsoft account without Outlook.com mail, or a work mailbox that is not in Microsoft 365.") + " " + nothingSaved,
          t("Connect with the account whose mail you read in Outlook.")], actions: [again()] };
    case "already_connected":
      return { status: 409, title: t("This address is already connected another way"), tone: "warn",
        body: [t("It is connected as an IMAP or Gmail account, and the same mail is not read twice. Disconnect it in Settings → Accounts first, then connect it through Microsoft.")],
        actions: [link(ACCOUNTS, t("Open Settings → Accounts here"))] };
    case "invalid_state":
      return { status: 403, title: t("This sign-in has expired"), tone: "warn",
        body: [t("It was started more than ten minutes ago, was already used, or was opened in another browser than the one that started it.") + " " + nothingSaved], actions: [again()] };
    case "oauth_failed":
      return { status: 400, title: t("Microsoft did not finish the sign-in"), tone: "warn",
        body: [t("Microsoft's answer could not be used: it came too late or was used already.") + " " + nothingSaved], actions: [again()] };
    case "invalid_profile":
      return { status: 502, title: t("Microsoft did not say which mailbox this is"), tone: "bad",
        body: [nothingSaved + " " + t("Connect again; if it happens again, this Microsoft account may have no email address.")], actions: [again()] };
    case "not_configured":
      return { status: 503, title: t("Outlook is not set up on this server"), tone: "warn",
        body: [t("Set it up in Fabric Inbox: Settings → Accounts → Connect account → Outlook walks through Microsoft Entra step by step.")],
        actions: [link(SETUP, t("Set up Outlook"))] };
    case "invalid_origin":
      return { status: 403, title: t("Open this from your server's own address"), tone: "warn",
        body: [t("Outlook is set up for {origin}; connecting works only there.", { origin: esc(input.origin ?? t("another address")) })],
        actions: input.origin ? [link(withLang(input.origin + OUTLOOK_CONNECT_PATH, t), t("Connect Outlook at {origin}", { origin: input.origin }))] : [] };
    case "too_many_connections":
      return { status: 429, title: t("Too many sign-ins are waiting"), tone: "warn",
        body: [t("Each one expires after ten minutes. Wait, then connect again.")], actions: [again()] };
    case "rate_limited":
    case "provider_unavailable":
      return { status: 503, title: t("Microsoft could not be reached"), tone: "warn",
        body: [nothingSaved + " " + t("Connect again in a minute.")], actions: [again()] };
    default:
      return { status: 502, title: t("Outlook was not connected"), tone: "bad",
        body: [t("Your server could not finish connecting ({outcome}).", { outcome: esc(input.outcome) }) + " " + nothingSaved], actions: [again()] };
  }
}

/** The page's parts, for a route that adds headers of its own (a cleared cookie). */
export function renderOutlookResult(input: OutlookResultInput, t: T = englishT) {
  return renderPage(page(input, t), "Outlook", t);
}

/** The result page as a Response, with headers that let it do nothing but show itself. */
export function outlookResultPage(input: OutlookResultInput, t: T = englishT): Response {
  const { html, status, headers } = renderOutlookResult(input, t);
  return new Response(html, { status, headers });
}
