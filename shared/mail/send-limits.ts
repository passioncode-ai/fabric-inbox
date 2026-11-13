/**
 * B-06: how many messages one Gmail, IMAP or Outlook account sends through this server in a rolling
 * day, whoever sends: the person, a rule, an agent or a campaign. B-262 (operator, 2026-11-13: «не ставь
 * лимитов, по дефолту заданы 1000 емаилов в день но можно расширить по запросу»): 1000 a day by default,
 * no hourly cap, and a server raises it with `SEND_LIMIT_DAY` when it is asked to. The providers keep
 * their own caps (a consumer Gmail about 500 a day, Google Workspace 2000, Outlook.com about 300); a
 * send past theirs is the provider's refusal. The server enforces this one (workers/providers/account-service.ts).
 */
export const REMOTE_SEND_LIMITS = { day: 1000 } as const;
/** B-262: an agent key's sends a day, by default and at most (a key asked for more is given more, up to the most). */
export const KEY_DAILY_SENDS: { readonly default: number; readonly max: number } = { default: 1000, max: 100_000 };
/** The most `SEND_LIMIT_DAY` may set: a day's log of sends is one stored list. */
export const MAX_SEND_LIMIT_DAY = 100_000;

/** The daily budget of one account on this server: `SEND_LIMIT_DAY` when it is a whole number from 1, else 1000. */
export function sendLimitPerDay(env: { SEND_LIMIT_DAY?: string } | undefined): number {
  const given = Number(env?.SEND_LIMIT_DAY);
  return Number.isInteger(given) && given >= 1 ? Math.min(given, MAX_SEND_LIMIT_DAY) : REMOTE_SEND_LIMITS.day;
}
