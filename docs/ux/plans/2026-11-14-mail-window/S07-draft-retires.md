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
(`account-deps.ts`) and the run's own send.

**Which drafts retire:** a reply agent's drafts of that thread that answer the replied-to message or an earlier one
(a draft answering a later message, from another person, stays). A draft is found by its run (`run.draftId`), not by
an id pattern, on every account kind.

**Untouched or edited:**
- Untouched: on a Cloudflare address, `draft_revision` is null or 1 (B-52); on an account, the draft's content hash
  equals the hash the run stored when it saved the draft (a new run field `draftHash`). Opening a draft in the composer
  without changing it saves nothing, so it stays untouched (a test holds this).
- Untouched drafts are retired: moved to Discarded with the reason "Answered by a sent reply" («Отвечено отправленным
  письмом»), which keeps it 30 days and can be restored, not deleted.
- Edited drafts are the person's: they leave the thread and stay in Drafts, and the thread shows one quiet line "Your
  edited draft is in Drafts" («Ваш изменённый черновик лежит в черновиках») with a link.

**The run's outcome:** a new field `outcome: {kind, sentMessageId, at}` with `kind` one of `answered_by_person`,
`answered_by_agent`, `superseded`; `answeredByPerson` stays as it is and becomes true only for `answered_by_person`, so
quality and ticket outcome (`workers/agents/quality.ts:92`, `ticket-outcome.ts:47`) keep their meaning. Idempotent by
run: a second accepted reply changes nothing. Logged as `{event: "agent_draft_retired", runId, kind, edited}`.

## Edge cases

- An uncertain send retires nothing until it is accepted.
- Two agents drafted in one thread: both retire.
- The person is editing the draft in the S06 card when a reply from elsewhere is accepted: the card shows "A reply was
  sent; this draft is no longer needed" with "Keep as my draft" (saves it, which makes it edited) and "Close".

## Acceptance

- Worker (workerd), Cloudflare: an accepted reply retires an untouched draft to Discarded, keeps an edited one, keeps a
  draft answering a later message, retires nothing on an uncertain send and on a forward; the run's `outcome`.
- Worker, an account fixture (Gmail provider double): the same through the content hash.
- Unit: opening a draft in the composer without a change leaves its revision unchanged.
- WebKit walk: send a reply in a thread with an agent's draft card; the card is gone; Discarded holds it.
- The S06 scenario names this step.
