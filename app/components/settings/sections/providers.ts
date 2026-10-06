/**
 * The ways to connect an account, as cards on Settings → Accounts (SCN-002, SCN-003, SCN-046).
 *
 * This list is the extension point for more providers: an IMAP preset (iCloud, Yahoo, Fastmail)
 * or Microsoft becomes available by giving its entry a `connect` kind the Accounts section knows
 * how to run, and a server answer that says it is configured. Until then a provider is listed as
 * unavailable, never as connectable: the app does not simulate an account it cannot reach.
 *
 * Plain module: the tests load it directly.
 */

export type ProviderId = "cloudflare" | "gmail" | "gmail-app-password" | "imap" | "microsoft";

/** How the Accounts section connects one: a token pasted here, or a sign-in in the browser. */
export type ConnectKind = "cloudflare-token" | "browser-oauth" | "none";

export interface ProviderEntry {
  id: ProviderId;
  name: string;
  /** One line on the card: what connecting it gives. */
  summary: string;
  connect: ConnectKind;
  /** What it gives up next to another way of connecting the same mail, said before choosing it. */
  tradeoff?: string;
  /** The provider's own help page for what the person must do there first. */
  helpUrl?: string;
}

export const PROVIDERS: readonly ProviderEntry[] = [
  { id: "cloudflare", name: "Cloudflare", connect: "cloudflare-token",
    summary: "Your domains and the addresses on them. One more account, with its own token." },
  { id: "gmail", name: "Gmail", connect: "browser-oauth",
    summary: "A Google account's mail, read and sent through Google. Each account is connected separately." },
  // STUB for WS4 (0.11.0, IMAP/SMTP providers): Gmail over IMAP with an app password, the route
  // that needs no Google Cloud project. WS4 gives it a connect kind of its own (an IMAP preset:
  // imap.gmail.com / smtp.gmail.com) and the server's answer that says IMAP is available; until
  // then it is listed as unavailable, never as connectable.
  { id: "gmail-app-password", name: "Gmail with an app password", connect: "none",
    summary: "Gmail without Google Cloud: an app password from your Google account. Needs 2-Step Verification; not for work or school accounts.",
    tradeoff: "Gmail's labels appear as folders, and mail is read over IMAP rather than through Google's API.",
    helpUrl: "https://support.google.com/accounts/answer/185833" },
  { id: "imap", name: "Other mail (IMAP)", connect: "none",
    summary: "iCloud, Yahoo, Fastmail and other IMAP mail." },
  { id: "microsoft", name: "Outlook", connect: "none",
    summary: "Microsoft 365 and Outlook.com mail." },
];

export type Availability = "available" | "not-configured" | "checking" | "unknown" | "unavailable";

/**
 * Whether a card can connect now. Gmail needs the server's Google sign-in setup, known only once
 * the account list has loaded; a provider with no way to connect in this build is unavailable.
 */
export function availability(provider: Pick<ProviderEntry, "id" | "connect">, state: {
  cloudflareConnected: boolean | null; gmail: "loading" | "unavailable" | "configured" | "not-configured";
}): Availability {
  if (provider.connect === "none") return "unavailable";
  if (provider.connect === "cloudflare-token") return state.cloudflareConnected === null ? "checking" : state.cloudflareConnected ? "available" : "not-configured";
  if (state.gmail === "configured") return "available";
  if (state.gmail === "not-configured") return "not-configured";
  return state.gmail === "loading" ? "checking" : "unknown";
}

export const AVAILABILITY_TEXT: Record<Availability, string> = {
  available: "",
  "not-configured": "Not set up on this server",
  checking: "Checking…",
  unknown: "Unknown until the accounts load",
  unavailable: "Not available in this build",
};
