/**
 * The values and places of the Outlook setup (Settings → Accounts → Outlook, SCN-057): what the owner
 * copies into a Microsoft Entra app registration, where in Microsoft Entra each step happens, and the
 * client secret's end date. One module for the wizard, the server's status answer, the OAuth flow
 * and the docs' tests.
 *
 * Microsoft's pages, read 2026-10-06:
 *  - registering an app, the supported account types ("Any Entra ID Tenant + Personal Microsoft
 *    accounts") and the Application (client) ID on Overview:
 *    https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
 *  - a Web redirect URI (Authentication → Add Redirect URI → Web):
 *    https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri
 *  - a client secret (Certificates & secrets → Client secrets → New client secret; at most 24 months;
 *    the Value is never shown again): https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials
 *  - the delegated permissions, none of which needs an administrator's consent:
 *    https://learn.microsoft.com/en-us/graph/permissions-reference
 *  - the admin consent endpoint (`{tenant}/v2.0/adminconsent`, `organizations` allowed, never `common`):
 *    https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent
 *  - Outlook.com ended basic authentication on 2024-09-16, so IMAP with a password no longer works:
 *    https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d
 *
 * Plain module: the app, the Worker and the tests load it directly.
 */
export const MICROSOFT_APP_NAME = "Fabric Inbox";
export const MICROSOFT_CALLBACK_PATH = "/api/accounts/outlook/callback";
export const OUTLOOK_CONNECT_PATH = "/api/accounts/outlook/connect";

/**
 * The delegated permissions the server asks for, as the authorization request names them (Microsoft
 * Graph's short names): read and change mail, send it, read who signed in, and keep access while
 * the person is away (a refresh token).
 */
export const MICROSOFT_SCOPES = ["offline_access", "Mail.ReadWrite", "Mail.Send", "User.Read"] as const;
/** The same permissions as the API permissions page of the app registration lists them. */
export const MICROSOFT_PERMISSIONS = [
  { name: "Mail.ReadWrite", type: "Delegated", why: "read your mail, mark it read, flag, move and delete it, keep drafts" },
  { name: "Mail.Send", type: "Delegated", why: "send mail as you" },
  { name: "User.Read", type: "Delegated", why: "learn the address of the account that signed in" },
  { name: "offline_access", type: "Delegated", why: "keep the access while you are away (a refresh token)" },
] as const;
/** The supported account types choice, exactly as Microsoft Entra names it. */
export const MICROSOFT_ACCOUNT_TYPES = "Any Entra ID Tenant + Personal Microsoft accounts";
/** Microsoft's authority for both kinds of account: work or school, and personal. */
export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
/** Admin consent takes a tenant; `organizations` lets the administrator's own sign-in choose it. */
export const MICROSOFT_ADMIN_CONSENT = "https://login.microsoftonline.com/organizations/v2.0/adminconsent";

/** Where the owner works in Microsoft Entra (the links Microsoft's own pages use). */
export const MICROSOFT_ENTRA = Object.freeze({
  /** Microsoft Entra admin center → App registrations (Microsoft's own link from the quickstart). */
  appRegistrations: "https://go.microsoft.com/fwlink/?linkid=2083908",
  adminCenter: "https://entra.microsoft.com",
  /** A free Azure account gives a personal Microsoft account a directory to register apps in. */
  freeAccount: "https://azure.microsoft.com/pricing/purchase-options/azure-account",
});

/** Microsoft's own explanations the wizard and the result pages link to, read 2026-10-06. */
export const MICROSOFT_HELP = Object.freeze({
  registerApp: "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app",
  redirectUri: "https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri",
  clientSecret: "https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials",
  adminConsent: "https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent",
  userConsent: "https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent",
  permissions: "https://learn.microsoft.com/en-us/graph/permissions-reference",
  basicAuthEnd: "https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d",
  /** Where a person removes an app's access to a personal Microsoft account. */
  personalAppAccess: "https://account.live.com/consent/Manage",
  /** Where a person sees the apps of a work or school account. */
  workAppAccess: "https://myapps.microsoft.com",
});

/** The Application (client) ID of an app registration: a GUID. */
export const MICROSOFT_CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A client secret's Value: one token of printable characters, no spaces. */
export const MICROSOFT_SECRET_PATTERN = /^[\x21-\x7e]{16,200}$/;
/** Days before a client secret ends when Settings starts warning about it. */
export const SECRET_WARNING_DAYS = 30;
/** Microsoft limits a client secret to 24 months; a date further off is a typo. */
export const SECRET_MAX_MONTHS = 24;

/** The values the owner copies into Microsoft Entra for a server at `origin`. */
export function microsoftSetupValues(origin: string) {
  const url = new URL(origin);
  return {
    appName: MICROSOFT_APP_NAME,
    origin: url.origin,
    redirectUri: url.origin + MICROSOFT_CALLBACK_PATH,
    platform: "Web",
    accountTypes: MICROSOFT_ACCOUNT_TYPES,
    permissions: MICROSOFT_PERMISSIONS.map((p) => p.name),
  };
}

/**
 * The link an organization's administrator opens to allow Fabric Inbox for everyone in it, when the
 * organization lets no one else allow apps. Every value in it is public.
 */
export function adminConsentUrl(clientId: string, redirectUri: string, state = "admin-consent"): string {
  const url = new URL(MICROSOFT_ADMIN_CONSENT);
  url.search = new URLSearchParams({
    client_id: clientId,
    scope: MICROSOFT_SCOPES.filter((s) => s !== "offline_access").map((s) => "https://graph.microsoft.com/" + s).join(" "),
    redirect_uri: redirectUri,
    state,
  }).toString();
  return url.href;
}

/** A date as Microsoft Entra shows a secret's end (YYYY-MM-DD), or null when it is not one. */
export function parseSecretExpiry(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const at = Date.parse(value.trim() + "T00:00:00Z");
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value.trim()) return null;
  return at;
}

export interface SecretExpiry {
  /** The end date as saved (YYYY-MM-DD). */
  date: string;
  /** Whole days from `now` to the end; negative once it has passed. */
  daysLeft: number;
  /** "ok", "soon" (within SECRET_WARNING_DAYS) or "expired". */
  state: "ok" | "soon" | "expired";
}

/** Where the saved client secret stands, or null when no end date is saved. */
export function secretExpiry(value: string | null | undefined, now = Date.now()): SecretExpiry | null {
  const at = parseSecretExpiry(value);
  if (at === null) return null;
  // The secret works through the day Microsoft shows; it ends when that day does.
  const daysLeft = Math.floor((at + 86_400_000 - now) / 86_400_000);
  return { date: value!.trim(), daysLeft, state: daysLeft < 0 ? "expired" : daysLeft <= SECRET_WARNING_DAYS ? "soon" : "ok" };
}

/** Why a pasted secret end date cannot be kept, or null when it can. */
export function secretExpiryProblem(value: unknown, now = Date.now()): string | null {
  const at = parseSecretExpiry(value);
  if (at === null) return "Enter the date in the Expires column of the client secret, as YYYY-MM-DD.";
  if (at + 86_400_000 <= now) return "That date has passed: this client secret no longer works. Add a new client secret and paste it with its date.";
  const max = new Date(now);
  max.setUTCMonth(max.getUTCMonth() + SECRET_MAX_MONTHS + 1);
  if (at > max.getTime()) return "Microsoft ends client secrets within 24 months. Copy the date from the Expires column again.";
  return null;
}
