/**
 * S06 (B-271): "Tune the agent" opens its own conversation with the panel's agent, named `<mailboxId>:tune:<runId>`
 * (the ordinary one is named by the mailbox alone), so the fenced block it carries never enters the ordinary history.
 * The server decides everything about such a session from its name: the mailbox is the part before the last `:tune:`,
 * the run must be that mailbox's, the session has no tools at all (KIMI-35) and its own fixed prompt (TUNING_PROMPT,
 * R6-8), and it is forgotten when the panel closes it or 24 hours after it began.
 */
export const TUNE_MARK = ":tune:";
/** How long a tuning conversation is kept when the panel never closes it. */
export const TUNING_TTL_SECONDS = 24 * 3600;
const RUN_ID = /^agent-[0-9a-f]{32}$/;

/** The mailbox and run a tuning session's name names, or null for an ordinary session (or a malformed name). */
export function tuneTarget(name: string): { mailboxId: string; runId: string } | null {
  const at = name.lastIndexOf(TUNE_MARK);
  if (at < 0) return null;
  const mailboxId = name.slice(0, at);
  const runId = name.slice(at + TUNE_MARK.length);
  if (!mailboxId || !RUN_ID.test(runId)) return null;
  return { mailboxId, runId };
}

/** The session name the app opens for one run. */
export const tuneName = (mailboxId: string, runId: string) => `${mailboxId}${TUNE_MARK}${runId}`;

/** The mailbox an agent session reads: a tuning session's mailbox part, else the whole name. */
export const sessionMailbox = (name: string) => tuneTarget(name)?.mailboxId ?? name;

/** A run belongs to the session's mailbox only when the names match (addresses compare without case). */
export const runBelongs = (run: { mailboxId?: string } | null | undefined, mailboxId: string) =>
  !!run && typeof run.mailboxId === "string" && run.mailboxId.toLowerCase() === mailboxId.toLowerCase();
