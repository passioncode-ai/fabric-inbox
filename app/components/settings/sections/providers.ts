/**
 * The ways to connect an account, as cards on Settings → Accounts (SCN-002, SCN-003, SCN-046).
 *
 * This list is the extension point for more providers: a provider becomes available by giving its
 * entry a `connect` kind the Accounts section knows how to run, and a server answer that says it is
 * configured. IMAP accounts (`app-password`) connect with an address and an app password checked
 * on the server; Gmail (`browser-oauth`) and Outlook (`microsoft-oauth`, SCN-057) with a sign-in in
 * the browser, after the owner's one-time setup. The app never simulates an account it cannot reach.
 *
 * Names, summaries and the availability words are English marked with msg(); the cards show them
 * in the interface's language with t.text() (shared/i18n).
 *
 * Plain module: the tests load it directly.
 */
import { englishT, msg, type T } from "../../../../shared/i18n";

export type ProviderId = "cloudflare" | "gmail" | "gmail-app-password" | "imap" | "microsoft";

/** How the Accounts section connects one: a token pasted here, a sign-in in the browser (Google's or Microsoft's), or an app password typed here. */
export type ConnectKind = "cloudflare-token" | "browser-oauth" | "microsoft-oauth" | "app-password" | "none";

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
  /** An app-password card that is one preset (shared/mail/imap-presets.ts); absent offers the choice of preset. */
  preset?: string;
}

export const PROVIDERS: readonly ProviderEntry[] = [
  { id: "cloudflare", name: "Cloudflare", connect: "cloudflare-token",
    summary: msg("Your domains and the addresses on them. One more account, with its own token.") },
  { id: "gmail", name: "Gmail", connect: "browser-oauth",
    summary: msg("A Google account's mail, read and sent through Google. Each account is connected separately.") },
  // Gmail over IMAP with an app password: the route that needs no Google Cloud project (the IMAP
  // preset "gmail": imap.gmail.com and smtp.gmail.com, shared/mail/imap-presets.ts).
  { id: "gmail-app-password", name: msg("Gmail with an app password"), connect: "app-password", preset: "gmail",
    summary: msg("Gmail without Google Cloud: an app password from your Google account. Needs 2-Step Verification; not for work or school accounts."),
    tradeoff: msg("Gmail's labels appear as folders, and mail is read over IMAP rather than through Google's API."),
    helpUrl: "https://support.google.com/accounts/answer/185833" },
  { id: "imap", name: msg("Other mail (IMAP)"), connect: "app-password",
    summary: msg("iCloud, Yahoo, AOL, Fastmail, Zoho, Yandex, Mail.ru, GMX or your own server, with an app password. Each account is connected separately.") },
  { id: "microsoft", name: "Outlook", connect: "microsoft-oauth",
    summary: msg("Outlook.com, Hotmail and Microsoft 365 mail, read and sent through Microsoft. Each account is connected separately."),
    helpUrl: "https://support.microsoft.com/en-us/office/modern-authentication-methods-now-needed-to-continue-syncing-outlook-email-in-non-microsoft-email-apps-c5d65390-9676-4763-b41f-d7986499a90d" },
];

export type Availability = "available" | "not-configured" | "checking" | "unknown" | "unavailable";

/**
 * Whether a card can connect now. Gmail needs the server's Google sign-in setup, Outlook its
 * Microsoft setup, an IMAP account the server's credential key, each known only once the server has
 * answered; a provider with no way to connect in this build is unavailable.
 */
export type SetupState = "loading" | "unavailable" | "configured" | "not-configured";
export function availability(provider: Pick<ProviderEntry, "id" | "connect">, state: {
  cloudflareConnected: boolean | null; gmail: SetupState; imap?: SetupState; outlook?: SetupState;
}): Availability {
  if (provider.connect === "none") return "unavailable";
  if (provider.connect === "microsoft-oauth") {
    const outlook = state.outlook ?? "loading";
    return outlook === "configured" ? "available" : outlook === "not-configured" ? "not-configured" : outlook === "loading" ? "checking" : "unknown";
  }
  if (provider.connect === "app-password") {
    const imap = state.imap ?? "loading";
    return imap === "configured" ? "available" : imap === "not-configured" ? "not-configured" : imap === "loading" ? "checking" : "unknown";
  }
  if (provider.connect === "cloudflare-token") return state.cloudflareConnected === null ? "checking" : state.cloudflareConnected ? "available" : "not-configured";
  if (state.gmail === "configured") return "available";
  if (state.gmail === "not-configured") return "not-configured";
  return state.gmail === "loading" ? "checking" : "unknown";
}

export const AVAILABILITY_TEXT: Record<Availability, string> = {
  available: "",
  "not-configured": msg("Not set up on this server"),
  checking: msg("Checking…"),
  unknown: msg("Unknown until the accounts load"),
  unavailable: msg("Not available in this build"),
};

/**
 * An account's state as its badge says it (`reconnect_required` → "reconnect required"), in the
 * language of `t`; a state this list does not know is shown as the server named it.
 */
export function accountStatusText(status: string, t: T = englishT): string {
  switch (status) {
    case "connected": return t("connected");
    case "syncing": return t("syncing");
    case "reconnect_required": return t("reconnect required");
    case "error": return t("error");
    case "rate_limited": return t("rate limited");
    case "disconnected": return t("disconnected");
    default: return status.replaceAll("_", " ");
  }
}
