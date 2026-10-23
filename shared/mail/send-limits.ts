/**
 * B-06: how many messages one Gmail, IMAP or Outlook account sends through this server, an hour and a
 * day (rolling), whoever sends: the person, a rule or an agent. Below the providers' own daily caps
 * (Outlook.com about 300, Gmail 500), so a runaway sender is stopped here before the provider suspends
 * the account. The server enforces it (workers/providers/account-service.ts); the composer names it.
 */
export const REMOTE_SEND_LIMITS = { hour: 50, day: 250 } as const;
