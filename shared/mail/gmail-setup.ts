/**
 * The values and places of the Gmail setup wizard (Settings → Accounts → Gmail, SCN-051): what the
 * person copies into Google Cloud, and where in Google Cloud each step happens. One module for the
 * wizard, the server's status answer and the docs' tests.
 *
 * Google Cloud's pages, read 2026-10-06: the Google Auth Platform (Branding, Audience, Clients,
 * Data Access) is at console.cloud.google.com/auth/…
 * (https://support.google.com/cloud/answer/15544987); Publish app is on Audience
 * (https://support.google.com/cloud/answer/15549945).
 *
 * Plain module: the app, the Worker and the tests load it directly.
 */
export const GMAIL_APP_NAME = "Fabric Inbox";
/** The one scope the server asks for (workers/providers/google-oauth.ts GMAIL_SCOPE; a test keeps them equal). */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_CALLBACK_PATH = "/api/accounts/gmail/callback";

/** Deep links into Google Cloud, in the order the wizard uses them. */
export const GOOGLE_CONSOLE = Object.freeze({
  createProject: "https://console.cloud.google.com/projectcreate",
  gmailApi: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  overview: "https://console.cloud.google.com/auth/overview",
  branding: "https://console.cloud.google.com/auth/branding",
  audience: "https://console.cloud.google.com/auth/audience",
  dataAccess: "https://console.cloud.google.com/auth/scopes",
  clients: "https://console.cloud.google.com/auth/clients",
  createClient: "https://console.cloud.google.com/auth/clients/create",
});

/** Google's own explanations the wizard links to, read 2026-10-06. */
export const GOOGLE_HELP = Object.freeze({
  testingExpiry: "https://developers.google.com/identity/protocols/oauth2#expiration",
  personalUse: "https://support.google.com/cloud/answer/13464323",
  restrictedScope: "https://developers.google.com/workspace/gmail/api/auth/scopes",
  appPasswords: "https://support.google.com/accounts/answer/185833",
});

/**
 * Domains under which every name belongs to a different owner (a Public Suffix List excerpt):
 * the authorized domain is one label more than these. Covers the hosts a Fabric Inbox server
 * runs on (workers.dev) and the common two-part country suffixes.
 */
const SHARED_SUFFIXES = ["workers.dev", "pages.dev", "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
  "co.nz", "co.jp", "co.in", "co.za", "com.br", "com.mx", "com.tr", "com.cn", "com.sg", "com.hk", "co.il", "co.kr"];

/**
 * The domain Google asks for under Branding → Authorized domains for this host: its registrable
 * domain (`fabric-inbox.name.workers.dev` → `name.workers.dev`, `mail.example.com` → `example.com`).
 */
export function authorizedDomainOf(host: string): string {
  const name = host.toLowerCase().replace(/\.$/, "");
  const labels = name.split(".");
  for (const suffix of SHARED_SUFFIXES)
    if (name.endsWith("." + suffix)) return labels.slice(-(suffix.split(".").length + 1)).join(".");
  return labels.slice(-2).join(".");
}

/** The values the person copies into Google Cloud for a server at `origin`. */
export function gmailSetupValues(origin: string) {
  const url = new URL(origin);
  return {
    appName: GMAIL_APP_NAME,
    origin: url.origin,
    redirectUri: url.origin + GMAIL_CALLBACK_PATH,
    authorizedDomain: authorizedDomainOf(url.hostname),
    scope: GMAIL_SCOPE,
  };
}

/** `<project number>-<id>.apps.googleusercontent.com`, as Google Auth Platform → Clients shows it. */
export const CLIENT_ID_PATTERN = /^\d{6,20}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;
/** A client secret as Google issues it (GOCSPX-… today): one token, no spaces. */
export const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;
