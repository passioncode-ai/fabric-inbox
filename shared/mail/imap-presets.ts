/**
 * Mail services a person can connect with an app password, each with the servers its own help
 * page names. Every value here was read from the source URL in `source` on 2026-10-06 and is not
 * to be changed without reading it again; `appPasswordUrl` is the provider's page on creating one.
 *
 * IMAP is always TLS from the first byte (993): this server does not rely on IMAP STARTTLS.
 * SMTP is TLS from the first byte (465) unless the provider's page names only 587 (STARTTLS).
 * Port 25 is never used: Workers cannot reach it.
 *
 * `sentCopy`: "provider" only where the provider's own page says a message sent through its SMTP
 * server is put in Sent by the provider (Gmail); everywhere else this server appends the copy,
 * after checking Sent for one the server may have made itself (imap/provider.ts).
 *
 * `name` and `steps` are English marked with msg() where they hold words: the server and agents
 * read them as they are, and Settings shows them in its language with t.text() (shared/i18n).
 *
 * Plain module: the Worker (workers/providers/imap/), the app (Settings → Accounts) and the tests read it.
 */
import { msg } from "../i18n";

export type PresetId = "icloud" | "yahoo" | "aol" | "fastmail" | "zoho" | "zoho-org" | "yandex" | "mailru" | "gmx-com" | "gmx-net" | "gmail" | "custom";

export interface Preset {
  id: PresetId;
  /** How the card names it. */
  name: string;
  /** Addresses it serves, for suggesting the card from an address; empty for any domain. */
  domains: string[];
  imap: { host: string; port: number };
  smtp: { host: string; port: number; security: "tls" | "starttls" };
  /** The IMAP login: the whole address, or the part before @ (iCloud). SMTP always takes the whole address. */
  imapUser: "address" | "local-part";
  /** The provider's page these settings were read from. */
  source: string;
  /** The provider's page on making an app password (or on the setting the person must switch on). */
  appPasswordUrl: string;
  /** What the person must do at the provider before connecting, said once on the form. */
  steps: string[];
  sentCopy: "provider" | "server";
}

export const PRESETS: readonly Preset[] = [
  {
    id: "icloud", name: "iCloud Mail", domains: ["icloud.com", "me.com", "mac.com"],
    imap: { host: "imap.mail.me.com", port: 993 }, smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
    imapUser: "local-part", source: "https://support.apple.com/en-us/102525",
    appPasswordUrl: "https://support.apple.com/en-us/102654",
    steps: [msg("Your Apple Account needs two-factor authentication."), msg("At account.apple.com, open Sign-In and Security, then App-Specific Passwords, and generate one.")],
    sentCopy: "server",
  },
  {
    id: "yahoo", name: "Yahoo Mail", domains: ["yahoo.com", "ymail.com", "rocketmail.com"],
    imap: { host: "imap.mail.yahoo.com", port: 993 }, smtp: { host: "smtp.mail.yahoo.com", port: 465, security: "tls" },
    imapUser: "address", source: "https://help.yahoo.com/kb/SLN4075.html",
    appPasswordUrl: "https://help.yahoo.com/kb/SLN15241.html",
    steps: [msg("On your Yahoo Account Security page, under External connections, choose Create app password.")],
    sentCopy: "server",
  },
  {
    id: "aol", name: "AOL Mail", domains: ["aol.com"],
    imap: { host: "imap.aol.com", port: 993 }, smtp: { host: "smtp.aol.com", port: 465, security: "tls" },
    imapUser: "address", source: "https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail",
    appPasswordUrl: "https://help.aol.com/articles/create-and-manage-app-password",
    steps: [msg("On your AOL Account Security page, choose Generate app password.")],
    sentCopy: "server",
  },
  {
    id: "fastmail", name: "Fastmail", domains: ["fastmail.com", "fastmail.fm"],
    imap: { host: "imap.fastmail.com", port: 993 }, smtp: { host: "smtp.fastmail.com", port: 465, security: "tls" },
    imapUser: "address", source: "https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports",
    appPasswordUrl: "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords",
    steps: [msg("In Fastmail, open Settings → Privacy & Security → Manage app passwords and access, and make a new app password with access to Mail.")],
    sentCopy: "server",
  },
  {
    id: "zoho", name: "Zoho Mail", domains: ["zohomail.com", "zoho.com"],
    imap: { host: "imap.zoho.com", port: 993 }, smtp: { host: "smtp.zoho.com", port: 465, security: "tls" },
    imapUser: "address", source: "https://www.zoho.com/mail/help/imap-access.html",
    appPasswordUrl: "https://www.zoho.com/mail/help/adminconsole/two-factor-authentication.html",
    steps: [msg("In Zoho Mail, turn on IMAP access in Settings."), msg("With two-factor authentication on, make an app password in Zoho Accounts → Security → App passwords.")],
    sentCopy: "server",
  },
  {
    id: "zoho-org", name: msg("Zoho Mail (your domain)"), domains: [],
    imap: { host: "imappro.zoho.com", port: 993 }, smtp: { host: "smtppro.zoho.com", port: 465, security: "tls" },
    imapUser: "address", source: "https://www.zoho.com/mail/help/imap-access.html",
    appPasswordUrl: "https://www.zoho.com/mail/help/adminconsole/two-factor-authentication.html",
    steps: [msg("In Zoho Mail, turn on IMAP access in Settings."), msg("With two-factor authentication on, make an app password in Zoho Accounts → Security → App passwords.")],
    sentCopy: "server",
  },
  {
    id: "yandex", name: "Yandex Mail", domains: ["yandex.com", "yandex.ru", "ya.ru"],
    imap: { host: "imap.yandex.com", port: 993 }, smtp: { host: "smtp.yandex.com", port: 465, security: "tls" },
    imapUser: "address", source: "https://yandex.com/support/yandex-360/customers/mail/en/mail-clients/others",
    appPasswordUrl: "https://yandex.com/support/id/en/authorization/app-passwords",
    steps: [msg("In Yandex Mail settings, allow mail clients to read your mail from the imap.yandex.com server via IMAP."), msg("In Yandex ID → Security → App passwords, make one for mail. It starts working within 2 to 3 hours.")],
    sentCopy: "server",
  },
  {
    id: "mailru", name: "Mail.ru", domains: ["mail.ru", "inbox.ru", "list.ru", "bk.ru"],
    imap: { host: "imap.mail.ru", port: 993 }, smtp: { host: "smtp.mail.ru", port: 465, security: "tls" },
    imapUser: "address", source: "https://help.mail.ru/mail/login/mailer/",
    appPasswordUrl: "https://help.mail.ru/mail/login/mailer/#password",
    steps: [msg("Your mailbox needs a phone number attached."), msg("In Mail.ru, open Settings → Security → Passwords for external applications, and make one with full access to Mail.")],
    sentCopy: "server",
  },
  {
    id: "gmx-com", name: "GMX (gmx.com)", domains: ["gmx.com", "gmx.us"],
    imap: { host: "imap.gmx.com", port: 993 }, smtp: { host: "mail.gmx.com", port: 465, security: "tls" },
    imapUser: "address", source: "https://support.gmx.com/pop-imap/imap/server.html",
    appPasswordUrl: "https://support.gmx.com/pop-imap/toggle.html",
    steps: [msg("IMAP is off at GMX until you switch it on: Email → Settings → POP3 & IMAP → Enable access to this account via POP3 and IMAP.")],
    sentCopy: "server",
  },
  {
    id: "gmx-net", name: "GMX (gmx.net, gmx.de)", domains: ["gmx.net", "gmx.de", "gmx.at", "gmx.ch"],
    imap: { host: "imap.gmx.net", port: 993 }, smtp: { host: "mail.gmx.net", port: 465, security: "tls" },
    imapUser: "address", source: "https://hilfe.gmx.net/pop-imap/imap/imap-serverdaten.html",
    appPasswordUrl: "https://hilfe.gmx.net/pop-imap/einschalten.html",
    steps: [msg("IMAP is off at GMX until you switch it on: E-Mail-Einstellungen → POP3/IMAP → POP3- und IMAP-Zugriff erlauben. GMX switches it off again after a long time unused.")],
    sentCopy: "server",
  },
  {
    id: "gmail", name: msg("Gmail (app password)"), domains: ["gmail.com", "googlemail.com"],
    imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
    imapUser: "address", source: "https://developers.google.com/workspace/gmail/imap/imap-smtp",
    appPasswordUrl: "https://support.google.com/accounts/answer/185833",
    steps: [msg("Your Google Account needs 2-Step Verification."), msg("Make an app password at myaccount.google.com/apppasswords. Signing in with Google (Connect Gmail) needs no password at all where this server has it set up.")],
    // "Sent messages are automatically copied to the Gmail/Sent folder if your email client uses SMTP."
    // — https://support.google.com/mail/answer/78892
    sentCopy: "provider",
  },
];

/** The custom server card: the person types the servers their provider names. */
export const CUSTOM: Omit<Preset, "imap" | "smtp"> = {
  id: "custom", name: msg("Other mail (IMAP)"), domains: [], imapUser: "address",
  source: "", appPasswordUrl: "", steps: [msg("Ask your provider for its IMAP server (with SSL/TLS, usually port 993) and its SMTP server (465 with SSL/TLS, or 587 with STARTTLS).")],
  sentCopy: "server",
};

export function preset(id: string | undefined): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
export function presetName(id: string | undefined): string {
  return preset(id)?.name ?? (id === "custom" ? "IMAP" : "IMAP");
}
/** The preset an address belongs to, by its domain; undefined for any other domain. */
export function presetFor(email: string): Preset | undefined {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  return PRESETS.find((p) => p.domains.includes(domain));
}
