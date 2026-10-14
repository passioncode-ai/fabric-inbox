/**
 * A link that opens one message in the inbox, with its reply agent's run (B-119): the voice-of-the-
 * customer dashboard's "open in source" and the agent-events feed's `link` (a path under the server's
 * origin, fabric-service/0.1). `open` is `<accountId>|<providerMessageId>`; `run` the run's id.
 */
export function messageLink(accountId: string, providerMessageId: string, runId?: string): string {
  const q = new URLSearchParams({ open: `${accountId}|${providerMessageId}` });
  if (runId) q.set("run", runId);
  return "/?" + q.toString().replace(/\+/g, "%20");
}
