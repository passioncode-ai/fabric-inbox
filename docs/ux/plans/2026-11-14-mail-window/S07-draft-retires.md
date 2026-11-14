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
  retirement; the retirement set excludes the draft id the send came from (the outbox `project` step runs before that
  draft is deleted, `workers/durableObject/index.ts:1043-1053`); a newer revision saved while it was sending stays a
  draft (the B-52 rule).
- **Untouched drafts are retired without any destructive step a person's edit could race** (round 5: R5-1, R5-4,
  KIMI-37; Discarded does not take drafts, `durableObject/index.ts:1612, 1622, 1637-1638`, `provider.ts:91-93`):
  - On a Cloudflare address: deleted in the same Durable Object transaction that checks `draft_revision` is null or 1,
    so no edit can land between the check and the delete. The agent's text is kept on the run (a new field
    `draftText`, at most 20,000 characters, written when the agent saves the draft), so the run's panel can show it
    and "Make a draft of it again" («Снова сделать черновиком») saves a new draft from it.
  - On a Gmail, IMAP or Outlook account: the provider's draft is not touched. The run is marked retired and the app
    hides that draft from the thread and from its Drafts list; the provider's own client still shows it (said in the
    run's panel: "Still in <provider>'s own Drafts"). Nothing is moved or deleted, so nothing can be lost.
- **The revision an account draft starts with:** every provider's `createDraft` returns the draft's revision (Gmail its
  id, IMAP its message id, Outlook a hash of its `changeKey`, `outlook/provider.ts:304, 352-353`), the receipt keeps it
  and the run stores it as `agentDraftRevision`; an account draft is untouched while its current revision is that one.
  Hidden only when untouched; an edited one stays visible with the quiet line below.
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

- Worker (workerd), Cloudflare: an accepted reply deletes an untouched draft in the revision-checked transaction (its text kept on the run), keeps an edited one, keeps a
  draft answering a later message, retires nothing on an uncertain send and on a forward; the run's `outcome`.
- Worker, an account fixture (Gmail provider double): an untouched draft is hidden, never moved or deleted; an edited one
  (revision changed) stays visible; a run without `agentDraftRevision` stays visible; each provider's `createDraft`
  returns a revision.
- Worker: a synced sent message naming the thread only in References retires; a subject-only match does not.
- Unit: opening a draft in the composer without a change leaves its revision unchanged.
- WebKit walk: send a reply in a thread with an agent's draft card; the card is gone; the run's panel offers "Make a draft of it again".
- The S06 scenario names this step.

## Decisions after round 6 (normative: they override the text above where they differ)

- **R6-3:** the outbox payload carries `sourceDraftId` and `sentBy` (outside the identity hash), so the `project` step
  can leave out the draft the send came from and record which kind wins.
- **KIMI-46:** a Cloudflare draft is deleted only when the run holds its complete text (`draftText` is the whole body,
  up to the draft size limit, and the run says it is complete); a run without it (written before this change) or an
  incomplete one keeps the draft.
- **R6-5:** order: the run's outcome is written first, then the draft is deleted; a `project` step that runs again
  finds the outcome and deletes the draft if it is still there, so a crash leaves at worst a draft that is retired
  later, never a lost one.
- **KIMI-49:** one resolver for every path: In-Reply-To, else the last References entry that names a message of the
  thread; the same function at acceptance and at Sent sync, with one test feeding both.
- **R6-2:** "Keep as my draft" saves a new draft from the card's text (S06 R6-4); nothing is restored from Discarded.

## Built as (2026-11-14, branch `agent/mailwin-s0607`)

- **Cloudflare addresses only.** Retirement runs in the outbox `project` step of a Cloudflare mailbox. On Gmail, IMAP
  and Outlook accounts nothing is hidden or retired yet: the providers' `createDraft` do not return a revision, so no run
  has `agentDraftRevision`, and by the rule above such a draft counts as edited and is kept. The runner records
  `agentDraftRevision` as soon as a mailbox's `createDraft` returns one. Sent-sync retirement and the account receipt path
  are the follow-up row with the account half of S06.
- **Who sent it** (`sentBy`): `agent` for a call over the agent protocol (it arrives in-process under its agent's name,
  `inProcessActors`) and for a reply agent's own send (`auto_submitted`); `person` for every other send from the app.
  The in-app agent cannot send.
- **A draft whose id was already taken** when its run saved it (a rerun after an interruption) is not claimed by the
  run's text: `draftTextComplete` is false, so it is never deleted.
- **Failures.** A retirement step that throws (the registry not answering) fails the projection, which the outbox's
  alarm runs again; every step is idempotent (an outcome written stays, a deleted draft is gone).
- **Ticket outcomes** read `outcome.kind` first: `approved_by_person` is `answered`, `answered_by_person` is
  `closed_by_person`, `answered_by_agent` is `answered_elsewhere`, `superseded` is `handed_open` (`unanswered` after
  30 days); the quality day's waiting count leaves out a run with an outcome.
- **The full composer** saves the first change at once only for a reply agent's untouched draft (`composerSaveDelay`);
  every other draft keeps its 1.5 s delay.
- **Not run in this unit:** the WebKit walk (left for the W4 audit).
