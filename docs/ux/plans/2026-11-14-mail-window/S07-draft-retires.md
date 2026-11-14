# S07. The agent's draft goes away once a reply is sent (B-272)

**Asked:** «Если я отправляю что-то сам, то этот драфт должен исчезать. То есть драфт находится только до того, пока он
не отправлен или я не отправил, дальше он исчезает».

Revised after review round 1 (KIMI-7, KIMI-8, UX-3, UX-10, IR-9, CB-4).

## Today

- A reply agent saves its draft on a Cloudflare address with id `agent-<32 hex>-draft(-N)` (`workers/agents/runner.ts:1190-1195`,
  `app/components/inbox/agent-run.ts` `isAgentDraft`), and on a Gmail, IMAP or Outlook account through the provider's
  draft API with the provider's own id (`workers/agents/account-deps.ts:126-130`).
- Sending the agent's own Cloudflare draft deletes it once accepted (`workers/durableObject/index.ts:1043-1053`).
- When the person writes their own reply, nothing removes the agent's draft; the run is marked `answeredByPerson`
  (a boolean, `workers/agents/run.ts:94`) only for escalated drafts (`workers/agents/registry.ts:1109-1133`).

## Target

**When:** a reply is accepted by the provider, sent by anyone (the person from the composer or the S06 card, the MCP
`reply` tool, the in-app agent, another agent, a send accepted later after an uncertain answer). A reply is a sent
message whose In-Reply-To names a message of the thread. A forward does not count.

**Where it is caught:** Cloudflare addresses: the outbox's `project` step, which every accepted send passes through
(`workers/durableObject/index.ts:193`). Gmail, IMAP and Outlook accounts: the account send path's accepted receipt
(`account-deps.ts`) and the run's own send. A reply sent outside the app (another device, the provider's own client)
is caught when the account's Sent folder syncs: a synced sent message whose In-Reply-To or References name a message
of the thread retires the same drafts, after the sync's delay (Gmail is read every `GMAIL_POLL_SECONDS`, 300 s by
default). No subject-only guess retires anything.

**Which drafts retire:** a reply agent's drafts of that thread that answer the replied-to message or an earlier one
(a draft answering a later message, from another person, stays). A draft is found by its run, not by an id pattern:
`run.draftId` on a Cloudflare address; on an account, the provider's draft id through `getDraftReceipt(...)` (S06).

**Untouched or edited:**
- Untouched: on a Cloudflare address, `draft_revision` is null or 1 (B-52), checked in the same transaction that retires
  it; on an account, the hash of the draft as read back from the provider right after the agent saved it (a new run
  field `draftHash`, over a canonical form of every field a person can edit: To, Cc, Bcc, subject, the text and HTML
  bodies with line endings and trailing spaces normalised, and the attachments' names and sizes) equals the
  hash of the draft read now. A run without `draftHash` (saved before this change), a draft that cannot be read, or a
  hash that cannot be compared counts as edited, so the draft is kept. Opening a draft in the composer without changing
  it saves nothing, so it stays untouched (a test holds this).
- A draft sent from the S06 card is the reply itself: it leaves through the existing send path, never through
  retirement; a newer revision saved while it was sending stays a draft (the B-52 rule).
- Untouched drafts are retired: on a Cloudflare address, moved to Discarded with the reason "Answered by a sent reply"
  («Отвечено отправленным письмом»), kept 30 days and restorable. A Gmail, IMAP or Outlook account has no Discarded
  folder and its draft delete is permanent (`account-service.ts:1608`), so the draft is first copied into the server's
  own Discarded store with that reason and its account, then deleted from the provider; Restore saves it back as a
  provider draft.
- Edited drafts are the person's: they leave the thread and stay in Drafts, and the thread shows one quiet line "Your
  edited draft is in Drafts" («Ваш изменённый черновик лежит в черновиках») with a link.

**Which kind wins:** the first accepted reply decides and later ones change nothing (idempotent by run). The person
from the composer or the card: `answered_by_person` (or `approved_by_person` for the agent's draft sent unedited, S06);
the MCP `reply` tool with a person's key: `answered_by_person`; another agent or the in-app agent: `answered_by_agent`;
a draft discarded from the card before any reply: `superseded`, which a later reply does not change.

**The run's outcome:** a new field `outcome: {kind, sentMessageId, at}` with `kind` one of `answered_by_person`,
`approved_by_person` (the agent's draft sent unedited, S06), `answered_by_agent`, `superseded`; `answeredByPerson` stays as it is and becomes true only for `answered_by_person`, so
quality and ticket outcome (`workers/agents/quality.ts:92`, `ticket-outcome.ts:47`) keep their meaning. Idempotent by
run: a second accepted reply changes nothing. Logged as `{event: "agent_draft_retired", runId, kind, edited}`.

## Edge cases

- An uncertain send retires nothing until it is accepted.
- Two agents drafted in one thread: both retire.
- The person is editing the draft in the S06 card when a reply from elsewhere is accepted: a card with unsaved or
  saved edits is edited, so it is kept; a card still untouched shows "A reply was sent; this draft is no longer needed"
  with "Keep as my draft" (restores it from Discarded with the card's text, which makes it edited) and "Close".

## Acceptance

- Worker (workerd), Cloudflare: an accepted reply retires an untouched draft to Discarded, keeps an edited one, keeps a
  draft answering a later message, retires nothing on an uncertain send and on a forward; the run's `outcome`.
- Worker, an account fixture (Gmail provider double): the same through the content hash; a run without `draftHash` and
  a provider that rewrites the saved text keep the draft.
- Worker: a synced sent message naming the thread only in References retires; a subject-only match does not.
- Unit: opening a draft in the composer without a change leaves its revision unchanged.
- WebKit walk: send a reply in a thread with an agent's draft card; the card is gone; Discarded holds it.
- The S06 scenario names this step.
