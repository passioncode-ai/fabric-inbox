# B-171: reply agents on Gmail, IMAP and Outlook accounts (task packet)

Status: phase 1 (server) done 2026-10-26 on branch `b171-agents-on-accounts`; phases 2 and 3 open. Board row: B-171 in [the board](../../evidence/backlog.md).

## Why

The operator, 2026-10-25: the agents that work in mail must run and be deployed in the cloud, and an
agent that lives only on the Mac must be able to run there. On the owner's server every reply agent
already runs in the Worker (`AgentRegistryDO`), with its knowledge tool on a public host; but a reply
agent can be put only on a Cloudflare address. Mail of a Gmail, IMAP or Outlook account is answered
only by an outside agent holding a key, and every change by such a key in the journal of 2026-10-25
came from Claude Code or a service's own job on a Mac (`list_agent_activity`).

## What is there (2026-10-25, `0309026`)

- The accounts' incoming-event queue: each provider's sync queues an Inbox message once
  (`workers/providers/gmail-sync.ts`, `imap/sync.ts` `queueEvent`, `outlook/sync.ts` `queueEvent`);
  `AccountService.drainEvents` (`workers/providers/account-service.ts`) hands each to
  `GmailAccountsDO.drain` (`workers/providers/accounts-do.ts`), which feeds rules (`AUTOMATIONS`) and
  categories, with retries and a dead-letter after 10 tries. Reply agents are not fed.
- The runner (`workers/agents/runner.ts`) reaches its mailbox only through `RunnerDeps`;
  `productionDeps` (`workers/agents/deps.ts`) builds them from a MailboxDO and the R2 settings
  `mailboxes/<address>.json`, and uses the address as the From of every reply.
- `AccountService.send` and `createDraft` take an idempotency key (`/^[A-Za-z0-9_.:-]{1,128}$/`),
  which the run id and its `:waiting` and `:closing` keys fit; their receipt is `sending`, `accepted`,
  `unknown` or `failed`.
- An account has no settings object: no assignment, From name or signature.
- The runner uses its `mailboxId` as the address everywhere: the From of the waiting, answer and
  closing replies (`runner.ts` around `runAgent`'s sends and `closeRun`), the prompts (`selfBlock`,
  `systemPrompt`), the prefilter's own-address check and `electAnswerer`. An account run needs the
  account's email there and its id only as the registry's key.
- A reply agent's mail carries `Auto-Submitted: auto-replied` (RFC 3834) so auto-responders do not
  answer it; `SendInput` of the accounts (`gmail-client.ts`) has no header field yet.

## Decisions (agent, 2026-10-25; by the operator's goal and the safest reversible option)

1. **Assignment** lives in R2 `accounts/<accountId>.json` (`{ agent, fromName?, signature? }`), the
   shape and etag write of `mailboxes/<address>.json`, so `readAssignment` reads both. Off by default:
   no account is answered until someone chooses an agent for it.
2. **The run's mailbox id is the account id** (`gmail:<id>`, `imap:<id>`, `outlook:<id>`): a colon
   never occurs in an address, so the registry tells the two apart; the run id stays
   `runIdFor(accountId, providerMessageId)`.
3. **Replies leave from the account itself** through `AccountService.send`, key = the run id; the
   receipt maps `accepted` to accepted, `sending` and `unknown` to unknown (never retried), `failed` to
   failed. Drafts go through `createDraft` with the same key; a drafting agent cannot be put on an
   account whose provider cannot keep drafts (refused at assignment, with the reason).
4. **The prefilter reads the message's headers** by `getHeaders` once per run, before any model call;
   a header read that fails holds the run as a failure (B-141 retries it), never answers blind.
5. **One answer per message** across Cloudflare addresses and accounts: `electAnswerer` counts an
   account address with an agent like an agent address.
6. **Events and quality** name the account's email as `address`; its quality channel is
   `mail:<domain>:<local part>` of that email.
7. **The reply status** (B-138, B-170) for accounts is a later phase: until then an account's message
   shows its run (`agentRun`), as a Cloudflare address did before B-138.

## Requirements

| REQ | What | Verified by |
|---|---|---|
| REQ-1 | An account with an agent: a new Inbox message is enqueued once, answered by policy, the reply leaves from the account in the same conversation | workerd test over `GmailAccountsDO` + `AgentRegistryDO` with a fake provider |
| REQ-2 | An account without an agent: nothing is enqueued, no run, no legacy agent created | same test |
| REQ-3 | A send whose outcome is unknown is never sent again; a refused one is failed with the reason | unit test on the receipt mapping |
| REQ-4 | The prefilter, dedupe, waiting reply, held retries and closing reply work for an account run | registry tests on an account id |
| REQ-5 | Assign and clear an agent on an account: route, MCP tool, the account's settings screen; a drafting agent on an account without drafts is refused | route and MCP tests, SCN for the screen |
| REQ-6 | Docs: architecture rows, SCN, `docs/agents/mcp.md`, the skill | `npm test` (mcp coverage, docs, skill) |

## Phases

1. **Server** (REQ-1 to REQ-4): account settings store; `RunnerDeps.mailbox.address` (the email the
   runner writes from and about, the mailbox id for a Cloudflare address); account deps; an
   `autoSubmitted` flag on the accounts' `SendInput` carried by Gmail, IMAP (SMTP) and Outlook; the
   enqueue in `drain`; the registry's choice of deps by id.
2. **Assignment** (REQ-5): `PUT /api/accounts/:id/agent`, the MCP tool, the account settings screen
   (through super-ux: the scenario first).
3. **Reply status for accounts** (B-138, B-170 on accounts): thread facts from the accounts' cache.

## Phase 1 receipt (2026-10-26)

- The runner writes from `deps.mailbox.address` and never migrates an account (`tests/agents-runner.test.ts` B-171).
- `workers/agents/account-deps.ts`: the message and its real headers from the account, the thread (what
  the account sent read whole), replies and drafts at the account under the run's key, receipts mapped
  (`tests/agents-accounts.test.ts`, 9 tests: REQ-3, decision 4).
- `OutgoingMessage.autoSubmitted` in `rawMime` for Gmail, IMAP and Outlook; set only through
  `SubmitOptions`, a request body's field is dropped (`tests/gmail-drafts.test.ts` B-171).
- `GmailAccountsDO.drain` enqueues for the registry when `accounts/<id>.json` names an agent
  (`tests/agents-accounts-workerd.test.ts`: REQ-1, REQ-2; red on the old drain, green on the new).
- The registry picks the account's effects by id and reads its email when a run starts (`runDeps`).
- An end-to-end run over an account: sent from the account, marked automatic, skipped on an
  `Auto-Submitted` header before any model call (`tests/agents-runner.test.ts` B-171).
- Gate: `npm test` 1600 tests, 0 failed; `npm run typecheck` 0.

Not yet: decision 5 holds only one way (an account address is outside the served domains, so a
Cloudflare copy never waits for it; an account copy does wait for an address listed before it);
REQ-4's waiting, held and closing replies on an account are exercised through the same deps but
have no registry test of their own yet.

## Phase 2 receipt (2026-10-26)

- `PUT /api/accounts/:accountId/agent` (`workers/routes/agents.ts`): Off or an agent, written to R2
  `accounts/<provider>:<id>.json` conditionally on its version (`updateAccountSettings`); an unknown
  account 404, an unknown agent 400, an agent that drafts on an account without drafts 400 with the
  reason, nothing written on a refusal (`tests/account-agent.test.ts`).
- A member is refused (`workers/lib/member-gate.ts`), like disconnecting the account.
- `GET /api/agents` and `GET /api/agents/:id` list the accounts each agent answers.
- Tool `set_account_agent` (admin); `docs/agents/mcp.md`, the schema-drift map and the skill.
- Settings → Accounts: Who answers on the Gmail, Outlook and IMAP panels (`AccountAgent.tsx`); an agent
  that drafts is listed disabled with the reason on an account without drafts; scenario SCN-086.
- REQ-4: on an account, a day-old held message gets its waiting reply from the account under
  `<run>:waiting`, the real answer later under `<run>`, and the closing reply under `<run>:closing`
  (`tests/agents-runner.test.ts` "B-171 REQ-4").

## Phase 3 receipt (2026-10-26)

- `AccountService.agentThreads` (`workers/providers/account-service.ts`): an account's conversations
  from its cache, the newest 200 of its Inbox or the ones asked for; each through
  `accountThreadFacts` (`workers/agents/account-threads.ts`): the last message that came in (not
  sent, not a draft, not in Trash, Spam or Discarded) and the last one sent, the agent's when a send
  receipt of its run on a message of the conversation names it (`<run>`, `<run>:waiting`), a failed
  receipt names no one. No thread index yet: nothing (`tests/account-threads-workerd.test.ts`).
- `workers/lib/agent-status.ts`: `agentAccounts` (the accounts whose `accounts/<id>.json` names an
  agent, with their email); the feed's marks, `/api/agent-threads`, `list_agent_threads` and
  `/api/inbox?reply=` include them, chosen by their email and filtered by their id.
- `superviseAbandoned` reads the accounts too and reports `agent.abandoned` under the account's email
  (`tests/agents-registry.test.ts` "B-170").

## Exact next step

Decision 5 the other way: a Cloudflare copy waits for an account listed before it in the recipients.
A per-account line in Settings → Addresses → Reply status (today an account follows the workspace and
its email's domain, and its own line is set with `set_agent_status`) is a board row.
