# S07. The agent's draft goes away once a reply is sent (B-272)

**Asked:** «Если я отправляю что-то сам, то этот драфт должен исчезать. То есть драфт находится только до того, пока он
не отправлен или я не отправил, дальше он исчезает».

## Today

- Sending the agent's own draft deletes it once the provider accepts it (`workers/durableObject/index.ts:1043-1053`).
- When the person writes their own reply instead, nothing removes the agent's draft: it stays in Drafts and in the
  thread. The registry marks the run `answeredByPerson` only for escalated drafts (`workers/agents/registry.ts:1109-1133`).

## Target

When any reply in a thread is accepted by the provider (sent by the person from the composer or the card, or by another
agent), the server deletes the reply agents' drafts of that thread that are still as the agent wrote them:

- an agent draft: id matches `agent-<32 hex>-draft(-N)?` (`app/components/inbox/agent-run.ts` `isAgentDraft`, moved to
  `shared/` so the server uses the same pattern);
- still as the agent wrote it: `draft_revision` is null or 1 (B-52: every save raises it);
- of that thread: the same `thread_id`, or `in_reply_to` naming a message of the thread.

A draft the person edited (revision above 1) is theirs and stays. The run is marked `answeredByPerson` (for every run,
not only escalated ones) with the sent message's id, which feeds quality and ticket outcome as today
(`workers/agents/quality.ts:92`). The deletion and its reason are logged: `{event: "agent_draft_retired", runId,
reason: "answered"}`.

The thread's draft card (S06) disappears with the draft; the person sees their sent reply in its place. A notice is not
shown (the outcome is the one asked for).

## Edge cases

- The send's outcome is uncertain: nothing is deleted until it is accepted (the existing uncertain path).
- Two agents drafted in one thread: both retire.
- A reply sent from Gmail, IMAP or Outlook directly (outside the app): agent drafts live on Cloudflare addresses
  only; a reply that reaches the thread through sync to a Cloudflare address's thread retires them the same way when
  the sent copy is stored.

## Agent tool

None new: the deletion is a consequence of sending. `read_thread` stops returning the retired draft.

## Acceptance

- Worker (workerd): a person's reply accepted in a thread with one untouched and one edited agent draft deletes the
  first and keeps the second; an uncertain send deletes nothing; the run gets `answeredByPerson`.
- WebKit walk: send a reply in a thread with an agent's draft card; the card is gone.
- SCN for S06 names this step.
