import { ApiError } from "./api";
import { noteServerBuild } from "../lib/build-version";
import { msg } from "../../shared/i18n";
/**
 * JSON request to this app's API. Distinguishes an empty success (204), an
 * expired sign-in (Cloudflare Access answers with an HTML page or a redirect),
 * a network failure and a JSON error, so the UI can say which one happened.
 */
export async function fabric<T>(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    throw new ApiError(0, { error: timeout ? msg("The server did not answer in 30 seconds. Try again.") : msg("The server could not be reached. Check the connection and try again.") });
  }
  noteServerBuild(response.headers);
  if (response.status === 204) return undefined as T;
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))
    throw new ApiError(401, { error: msg("Your sign-in expired. Reload the page to sign in again.") });
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new ApiError(response.status, {
      error: [401, 403].includes(response.status) || type.includes("text/html")
        ? msg("Your sign-in expired. Reload the page to sign in again.")
        : msg("The server answered {status} without data. Try again.", { status: response.status }),
    });
  }
  const data = await response.json().catch(() => ({ error: msg("The server sent an unreadable answer. Try again.") }));
  if (!response.ok) throw new ApiError(response.status, data as Record<string, unknown>);
  return data as T;
}
export type Account = {
  id: string;
  email: string;
  status: string;
  lastSyncAt?: number;
  error?: string;
  /** Why it stopped working (shared/mail/gmail-reasons.ts). */
  reason?: string;
  /** When access was last given on Google's or Microsoft's page. */
  connectedAt?: number;
  /** When Google said this access ends (a Testing app's 7 days), if it gave an end. */
  accessUntil?: number;
  /** "gmail" (Google sign-in), "imap" (an app password) or "outlook" (Microsoft sign-in); absent on a server before 0.11: Gmail. */
  provider?: "gmail" | "imap" | "outlook";
  /** "Gmail", "iCloud Mail", "Fastmail"… */
  providerName?: string;
  /** The IMAP preset it was connected with (shared/mail/imap-presets.ts), or "custom". */
  preset?: string;
  /** An IMAP account's servers (no secret). */
  server?: { imap: { host: string; port: number }; smtp: { host: string; port: number; security: "tls" | "starttls" }; imapUser: string; smtpUser: string };
  /** What the account can do (workers/providers/provider.ts). */
  capabilities?: { archive: boolean; spam: boolean; trash: boolean; drafts: boolean; organization: "labels" | "folders" };
  /** The first import's progress in percent, while it runs. */
  importing?: number;
};
export type AccountList = {
  configuration: string;
  accounts: Account[];
  providers: { id: string; status: string }[];
};
export type Mail = {
  id: string;
  providerMessageId: string;
  accountId: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  timestamp: number;
  snippet: string;
  text?: string;
  html?: string;
  read: boolean;
  archived: boolean;
  labels: string[];
  rfcMessageId?: string;
  references?: string;
  attachments: {
    filename: string;
    mimeType: string;
    providerAttachmentId: string;
    size: number;
  }[];
};
export const accountPath = (id: string) =>
  "/api/accounts/" + encodeURIComponent(id);
