import { configuration } from "./google-oauth";
import { microsoftConfiguration } from "./outlook/oauth";

/**
 * The origin the account routes take changes from: the app's configured one (PUBLIC_APP_URL, which Gmail and
 * Outlook share), else the server's own. The route and the agent protocol's in-process calls read it here,
 * so a server with only Outlook set up does not refuse its agents (P-3).
 */
export function expectedAccountOrigin(env: Parameters<typeof configuration>[0] & Parameters<typeof microsoftConfiguration>[0], requestUrl: string): string {
  const gmail = configuration(env);
  if (gmail.status === "configured") return gmail.origin;
  const microsoft = microsoftConfiguration(env);
  return microsoft.status === "configured" ? microsoft.origin : new URL(requestUrl).origin;
}
