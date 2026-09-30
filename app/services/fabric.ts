import { ApiError } from "./api";
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
    throw new ApiError(0, { error: timeout ? "The server did not answer in 30 seconds. Try again." : "The server could not be reached. Check the connection and try again." });
  }
  if (response.status === 204) return undefined as T;
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))
    throw new ApiError(401, { error: "Your sign-in expired. Reload the page to sign in again." });
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new ApiError(response.status, {
      error: [401, 403].includes(response.status) || type.includes("text/html")
        ? "Your sign-in expired. Reload the page to sign in again."
        : `The server answered ${response.status} without data. Try again.`,
    });
  }
  const data = await response.json().catch(() => ({ error: "The server sent an unreadable answer. Try again." }));
  if (!response.ok) throw new ApiError(response.status, data as Record<string, unknown>);
  return data as T;
}
export type Account = {
  id: string;
  email: string;
  status: string;
  lastSyncAt?: number;
  error?: string;
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
