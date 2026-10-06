/**
 * Why a Gmail account stopped working, and what the person does about it (SCN-003). One source
 * for the inbox banner, Settings → Accounts, the agent protocol and the OAuth result page.
 *
 * The server stores the reason on the account (`reason`) next to its error code (`error`), so a
 * cause found once — a revoked grant, the Gmail API switched off, an unticked box on Google's page
 * — is said in words everywhere until the account works again.
 *
 * Google's own descriptions, read 2026-10-06:
 *  - refresh tokens and the 7-day expiry of a Testing app: https://developers.google.com/identity/protocols/oauth2#expiration
 *  - gmail.modify is a restricted scope: https://developers.google.com/workspace/gmail/api/auth/scopes
 *  - personal use without verification: https://support.google.com/cloud/answer/13464323
 *
 * Plain module: the app, the Worker and the tests load it directly.
 */

export const GMAIL_REASONS = [
  "testing_expiry",
  "access_revoked",
  "insufficient_scope",
  "gmail_api_disabled",
  "client_rejected",
  "credentials_unreadable",
] as const;
export type GmailReason = (typeof GMAIL_REASONS)[number];

export const isGmailReason = (value: unknown): value is GmailReason =>
  typeof value === "string" && (GMAIL_REASONS as readonly string[]).includes(value);

/** What fixes it: connect the account again, change the server's Google setup, or switch the Gmail API on. */
export type GmailFix = "reconnect" | "setup" | "enable_api";

export interface GmailReasonText {
  /** Completes "<address> …" in a banner. */
  short: string;
  /** What happened, in one sentence. */
  explain: string;
  /** The one next action. */
  fix: string;
  action: GmailFix;
}

export const GMAIL_REASON_TEXT: Readonly<Record<GmailReason, GmailReasonText>> = Object.freeze({
  testing_expiry: {
    short: "lost its Gmail access after 7 days",
    explain: "Your Google Cloud app is in Testing, and Google ends a Testing app's access 7 days after it is given.",
    fix: "In Google Cloud, open Audience and choose Publish app (or make the app Internal for a Google Workspace account), then reconnect. Access then stays until it is removed.",
    action: "reconnect",
  },
  access_revoked: {
    short: "needs to be reconnected: Google no longer accepts its access",
    explain: "The access was removed in the Google account, its password changed, or it went unused for six months.",
    fix: "Reconnect it. If this happens every week, your Google Cloud app is still in Testing: publish it in Audience.",
    action: "reconnect",
  },
  insufficient_scope: {
    short: "was connected without Gmail access",
    explain: "On Google's page, the box that lets Fabric Inbox read, compose and send your Gmail was not ticked.",
    fix: "Reconnect it and tick the Gmail box on Google's page.",
    action: "reconnect",
  },
  gmail_api_disabled: {
    short: "cannot be read: the Gmail API is off in your Google Cloud project",
    explain: "Google refuses Gmail requests until the Gmail API is enabled in the project that holds your OAuth client.",
    fix: "Enable the Gmail API in that project, then choose Retry. The account does not need to be reconnected.",
    action: "enable_api",
  },
  client_rejected: {
    short: "cannot be read: Google refused this server's OAuth client",
    explain: "The OAuth client was deleted, or its secret was changed, in Google Cloud.",
    fix: "Check the Gmail setup in Settings → Accounts and save the client again; then reconnect the account.",
    action: "setup",
  },
  credentials_unreadable: {
    short: "needs to be reconnected: its saved access cannot be opened",
    explain: "The server's credential key changed, so the access saved for this account can no longer be read.",
    fix: "Reconnect it.",
    action: "reconnect",
  },
});

/** The reason an account carries, if it is one this module knows. */
export function gmailReason(account: { reason?: unknown } | null | undefined): GmailReasonText | null {
  return account && isGmailReason(account.reason) ? GMAIL_REASON_TEXT[account.reason] : null;
}

/**
 * The project number in an OAuth client id (`<project number>-<hash>.apps.googleusercontent.com`):
 * the number Google itself puts in its "enable the Gmail API" link.
 */
export function projectNumberOf(clientId: string | null | undefined): string | null {
  const match = /^(\d{6,20})-[a-z0-9]+\.apps\.googleusercontent\.com$/.exec((clientId ?? "").trim());
  return match ? match[1]! : null;
}

/** Where the Gmail API is switched on: the project's own page when its number is known. */
export function gmailApiUrl(projectNumber?: string | null): string {
  return projectNumber
    ? `https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=${encodeURIComponent(projectNumber)}`
    : "https://console.cloud.google.com/apis/library/gmail.googleapis.com";
}
