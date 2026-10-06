/**
 * What went wrong connecting an IMAP account, or using one, in the person's words: the server's
 * code (workers/providers/imap/client.ts, smtp.ts) becomes one sentence that names who refused and
 * the one thing to do next (docs/brand/voice.md: the recovery action beside the state).
 *
 * Plain module: the tests load it directly.
 */
export interface ImapErrorContext {
  /** "iCloud Mail", "Fastmail", "your provider". */
  provider: string;
  imapHost?: string;
  smtpHost?: string;
}

export const IMAP_ERROR_CODES = [
  "auth_failed", "app_password_required", "imap_disabled", "auth_or_imap_disabled", "web_login_required", "smtp_auth_failed",
  "smtp_auth_unsupported", "tls_failed", "host_unreachable", "smtp_unreachable", "smtp_tls_failed", "smtp_refused", "invalid_server",
  "imap_tls_required", "port_blocked", "already_connected", "not_configured", "invalid_account_settings", "invalid_password",
  "reconnect_required", "provider_unavailable",
] as const;

/** The sentence for a code, or null for a code this module does not know (the caller shows the server's own text). */
export function imapErrorText(code: string, c: ImapErrorContext): string | null {
  const imap = c.imapHost ?? "the incoming mail server";
  const smtp = c.smtpHost ?? "the sending server";
  switch (code) {
    case "auth_failed": return `${c.provider} refused the address or the app password. Check both: it takes an app password, not the password you sign in with.`;
    case "app_password_required": return `${c.provider} needs an app password here, not the password you sign in with. Make one, then paste it here.`;
    case "imap_disabled": return `${c.provider} has IMAP switched off for this account. Switch it on in its settings, then try again.`;
    case "auth_or_imap_disabled": return `${c.provider} refused the sign-in: the app password is wrong, or IMAP is switched off in its settings. Check both, then try again.`;
    case "web_login_required": return `${c.provider} wants you to sign in on its website once before it lets a mail app in. Do that, then try again.`;
    case "smtp_auth_failed": return `${imap} took the app password, but ${smtp} refused it, so mail could not be sent. Check the sending server, or make a new app password.`;
    case "smtp_auth_unsupported": return `${smtp} offers no sign-in this app can use. Check the sending server.`;
    case "tls_failed": return `No secure connection to ${imap}: it does not offer SSL/TLS on that port. Check the server name and the port (usually 993).`;
    case "host_unreachable": return `${imap} did not answer. Check the server name and the port, or try again in a minute.`;
    case "smtp_unreachable": return `${smtp} did not answer. Check the server name and the port (465 or 587), or try again in a minute.`;
    case "smtp_tls_failed": return `No secure connection to ${smtp} on that port. Use 465 with SSL/TLS or 587 with STARTTLS.`;
    case "smtp_refused": return `${smtp} refused the connection. Try again in a minute, or check the sending server.`;
    case "invalid_server": return "Enter each server as a name, such as imap.example.com and smtp.example.com.";
    case "imap_tls_required": return "This app reads mail only over SSL/TLS, usually port 993. Port 143 and POP are not used.";
    case "port_blocked": return "Port 25 cannot be used: Cloudflare does not allow it. Use 465 (SSL/TLS) or 587 (STARTTLS).";
    case "already_connected": return "This address is already connected through Google sign-in. Disconnect that account first to use an app password instead.";
    case "not_configured": return "Your server has no credential key yet, so it cannot keep an app password. Update the server from the Mac app, which adds one, or set MAIL_CREDENTIAL_KEY on a server deployed by hand.";
    case "invalid_account_settings": return "Check the address, the app password and the server fields, then try again.";
    case "invalid_password": return "Paste the app password.";
    case "reconnect_required": return `${c.provider} no longer accepts the app password this server has. Enter a new one.`;
    case "provider_unavailable": return `${c.provider} could not be reached just now. It is tried again on its own.`;
    default: return null;
  }
}
