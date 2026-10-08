/**
 * What went wrong connecting an IMAP account, or using one, in the person's words: the server's
 * code (workers/providers/imap/client.ts, smtp.ts) becomes one sentence that names who refused and
 * the one thing to do next (docs/brand/voice.md: the recovery action beside the state).
 *
 * The sentence is in the language of `t` (the caller's useT(); English by default). The provider's
 * name and servers are filled in as they are.
 *
 * Plain module: the tests load it directly.
 */
import { englishT, type T } from "../../shared/i18n";

export interface ImapErrorContext {
  /** "iCloud Mail", "Fastmail", "your provider". */
  provider: string;
  imapHost?: string;
  smtpHost?: string;
  /** When the account is tried again on its own (a backoff), if the caller knows it. */
  retryAt?: number;
}

export const IMAP_ERROR_CODES = [
  "auth_failed", "app_password_required", "imap_disabled", "auth_or_imap_disabled", "web_login_required", "smtp_auth_failed",
  "smtp_auth_unsupported", "tls_failed", "host_unreachable", "smtp_unreachable", "smtp_tls_failed", "smtp_refused", "invalid_server",
  "imap_tls_required", "port_blocked", "already_connected", "not_configured", "invalid_account_settings", "invalid_password",
  "reconnect_required", "provider_unavailable", "sync_backoff", "rate_limited",
] as const;

/** The sentence for a code, or null for a code this module does not know (the caller shows the server's own text). */
export function imapErrorText(code: string, c: ImapErrorContext, t: T = englishT): string | null {
  const provider = c.provider;
  const imap = c.imapHost ?? t("the incoming mail server");
  const smtp = c.smtpHost ?? t("the sending server");
  const at = c.retryAt ? t.time(c.retryAt, { hour: "2-digit", minute: "2-digit" }) : null;
  switch (code) {
    case "auth_failed": return t("{provider} refused the address or the app password. Check both: it takes an app password, not the password you sign in with.", { provider });
    case "app_password_required": return t("{provider} needs an app password here, not the password you sign in with. Make one, then paste it here.", { provider });
    case "imap_disabled": return t("{provider} has IMAP switched off for this account. Switch it on in its settings, then try again.", { provider });
    case "auth_or_imap_disabled": return t("{provider} refused the sign-in: the app password is wrong, or IMAP is switched off in its settings. Check both, then try again.", { provider });
    case "web_login_required": return t("{provider} wants you to sign in on its website once before it lets a mail app in. Do that, then try again.", { provider });
    case "smtp_auth_failed": return t("{imap} took the app password, but {smtp} refused it, so mail could not be sent. Check the sending server, or make a new app password.", { imap, smtp });
    case "smtp_auth_unsupported": return t("{smtp} offers no sign-in this app can use. Check the sending server.", { smtp });
    case "tls_failed": return t("No secure connection to {imap}: it does not offer SSL/TLS on that port. Check the server name and the port (usually 993).", { imap });
    case "host_unreachable": return t("{imap} did not answer. Check the server name and the port, or try again in a minute.", { imap });
    case "smtp_unreachable": return t("{smtp} did not answer. Check the server name and the port (465 or 587), or try again in a minute.", { smtp });
    case "smtp_tls_failed": return t("No secure connection to {smtp} on that port. Use 465 with SSL/TLS or 587 with STARTTLS.", { smtp });
    case "smtp_refused": return t("{smtp} refused the connection. Try again in a minute, or check the sending server.", { smtp });
    case "invalid_server": return t("Enter each server as a name, such as imap.example.com and smtp.example.com.");
    case "imap_tls_required": return t("This app reads mail only over SSL/TLS, usually port 993. Port 143 and POP are not used.");
    case "port_blocked": return t("Port 25 cannot be used: Cloudflare does not allow it. Use 465 (SSL/TLS) or 587 (STARTTLS).");
    case "already_connected": return t("This address is already connected through Google sign-in. Disconnect that account first to use an app password instead.");
    case "not_configured": return t("Your server has no credential key yet, so it cannot keep an app password. Make one in Settings → Accounts → Connect account → Other mail, or set MAIL_CREDENTIAL_KEY on a server deployed by hand.");
    case "invalid_account_settings": return t("Check the address, the app password and the server fields, then try again.");
    case "invalid_password": return t("Paste the app password.");
    case "reconnect_required": return t("{provider} no longer accepts the app password this server has. Enter a new one.", { provider });
    case "provider_unavailable": return t("{provider} could not be reached just now. It is tried again on its own.", { provider });
    case "sync_backoff": return at
      ? t("The last try failed a moment ago; the next one is tried on its own at {time}.", { time: at })
      : t("The last try failed a moment ago; the next one is tried on its own.");
    case "rate_limited": return at
      ? t("{provider} asked to slow down; it is tried again on its own at {time}.", { provider, time: at })
      : t("{provider} asked to slow down; it is tried again on its own.", { provider });
    default: return null;
  }
}
