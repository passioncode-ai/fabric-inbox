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
  it; on an account, the provider's own draft revision (every provider keeps `draftRevision` and answers a stale one
  with 409 `draft_conflict`, `workers/providers/provider.ts:126, 156-159`) is still the one the agent's save returned,
  kept on the run as `agentDraftRevision` (written once, never changed). Any save through the provider, the app's or
  the provider's own client, changes the revision, attachments included. A run without `agentDraftRevision` (saved
  before this change) or a draft whose revision cannot be read counts as edited, so the draft is kept. Opening a draft in the composer without changing
  it saves nothing, so it stays untouched (a test holds this).
- A draft sent from the S06 card is the reply itself: it leaves through the existing send path, never through
  retirement; a newer revision saved while it was sending stays a draft (the B-52 rule).
- Untouched drafts are retired: moved to the account's own Discarded (a folder on a Cloudflare address, a label on
  Gmail, a folder on IMAP and Outlook, `workers/providers/provider.ts:83-84`) with the reason "Answered by a sent reply"
  («Отвечено отправленным письмом»), kept 30 days by the existing Discarded sweep and restored with the existing "Not
  discarded" action and its tool. The move carries the expected revision (Cloudflare: in the same transaction; accounts:
  re-read right before the move, which is refused on a mismatch), so an edit made meanwhile keeps the draft.
- Edited drafts are the person's: they leave the thread and stay in Drafts, and the thread shows one quiet line "Your
  edited draft is in Drafts" («Ваш изменённый черновик лежит в черновиках») with a link.

**Reading the outcome:** `ticket-outcome.ts` and `quality.ts` read `outcome.kind` first, and `answeredByPerson` only
for runs written before it existed (one rule, the same as S06).

**Which kind wins:** the first accepted reply decides and later ones change nothing (idempotent by run). The person
from the composer or the card: `answered_by_person` (or `approved_by_person` for the agent's draft sent unedited, S06);
the MCP `reply` tool and the in-app agent, whatever their key: `answered_by_agent` (an agent sent it; the agent console's
key is an agent key, B-70); a reply caught at Sent sync from another client: `answered_by_person` unless the run itself
sent it;
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
- Worker, an account fixture (Gmail provider double): the same through `agentDraftRevision`; a run without it keeps the
  draft; a revision changed between the read and the move keeps it (the move is refused).
- Worker: a synced sent message naming the thread only in References retires; a subject-only match does not.
- Unit: opening a draft in the composer without a change leaves its revision unchanged.
- WebKit walk: send a reply in a thread with an agent's draft card; the card is gone; Discarded holds it.
- The S06 scenario names this step.
