/**
 * B-241 (operator 2026-11-09, relayed on the board: people a message goes to are validated through the organization's
 * administrator agent, so nothing reaches the wrong person): before an agent key sends a message to an address of the
 * organization's own domains, the server asks the administrator agent's recipient check and sends only on `ok`.
 * Configured per server: `RECIPIENT_CHECK_URL` (https), the secret `RECIPIENT_CHECK_TOKEN`, and the domains it guards
 * (`RECIPIENT_CHECK_DOMAINS`, else `DOMAINS`). Unset: nothing is checked. Set: a check that cannot be read refuses
 * the send (fail-closed). The person's own sends, and a reply to a message's sender, are not checked.
 */
export const VERDICTS = ["ok", "mismatch", "ambiguous", "unknown", "left", "do-not-contact"] as const;
export type RecipientVerdict = (typeof VERDICTS)[number] | "unreachable";

export interface RecipientCheck {
  /** The guarded domains, lowercase. */
  domains: readonly string[];
  check(email: string): Promise<RecipientVerdict>;
}

const list = (value: string | undefined) => (value ?? "").split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);

/** Whether an address belongs to one of the guarded domains (or one of their subdomains). */
export function guarded(email: string, domains: readonly string[]): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase();
  return !!domain && domains.some((d) => domain === d || domain.endsWith("." + d));
}

/** The check this server is configured with, or null when it is not (or its URL is not https). */
export function recipientCheckFrom(env: { RECIPIENT_CHECK_URL?: string; RECIPIENT_CHECK_TOKEN?: string; RECIPIENT_CHECK_DOMAINS?: string; DOMAINS?: string },
  fetcher: typeof fetch = fetch, timeoutMs = 8000): RecipientCheck | null {
  const raw = env.RECIPIENT_CHECK_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { url = new URL("https://invalid.invalid/"); }
  const domains = list(env.RECIPIENT_CHECK_DOMAINS || env.DOMAINS);
  // A setting that cannot be used still guards: every guarded address is refused rather than sent unchecked.
  const usable = url.protocol === "https:" && url.hostname !== "invalid.invalid" && !!env.RECIPIENT_CHECK_TOKEN;
  return {
    domains,
    async check(email) {
      if (!usable) return "unreachable";
      const target = new URL(url);
      target.searchParams.set("email", email.trim().toLowerCase());
      try {
        // A redirect is never followed, so the token never reaches another host; it reads as no answer.
        const response = await fetcher(target.toString(), { headers: { Authorization: `Bearer ${env.RECIPIENT_CHECK_TOKEN}`, Accept: "application/json" },
          redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) return "unreachable";
        const verdict = ((await response.json()) as { verdict?: unknown })?.verdict;
        return (VERDICTS as readonly unknown[]).includes(verdict) ? verdict as RecipientVerdict : "unreachable";
      } catch {
        return "unreachable";
      }
    },
  };
}
