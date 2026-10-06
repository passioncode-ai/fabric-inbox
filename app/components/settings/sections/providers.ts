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

export type ProviderId = "cloudflare" | "gmail" | "imap" | "microsoft";

/** How the Accounts section connects one: a token pasted here, or a sign-in in the browser. */
export type ConnectKind = "cloudflare-token" | "browser-oauth" | "none";

export interface ProviderEntry {
  id: ProviderId;
  name: string;
  /** One line on the card: what connecting it gives. */
  summary: string;
  connect: ConnectKind;
}

export const PROVIDERS: readonly ProviderEntry[] = [
  { id: "cloudflare", name: "Cloudflare", connect: "cloudflare-token",
    summary: "Your domains and the addresses on them. One more account, with its own token." },
  { id: "gmail", name: "Gmail", connect: "browser-oauth",
    summary: "A Google account's mail, read and sent through Google. Each account is connected separately." },
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
