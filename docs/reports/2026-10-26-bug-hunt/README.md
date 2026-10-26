---
report:
  id: fabric-inbox/2026-10-26-bug-hunt
  title: "Bug hunt across mail, agents, automation, classification, spam, notifications, access and first-session onboarding"
  kind: audit
  project: fabric-inbox
  domains: [mail, agents, automation, categories, spam, safety, notifications, access, onboarding, mcp]
  as_of: 2026-10-26
  status: active
  valid_until: 2026-11-26
  summary: >-
    Five read-only hunts over 0.39.1 (receiving and sending; reply agents and automation;
    classification and spam; notifications and delegated access; first-session onboarding and
    MCP/API parity) found 68 defects, two of them critical: a member reaching any route through
    a percent-encoded path, and a renamed address's queued category work spinning for ever.
    They are fixed in three waves; wave 1 (security and lost or wrong mail) ships in 0.40.0.
---

# Bug hunt, 2026-10-26

The operator asked (2026-10-26) for a hunt for bugs in receiving and sending mail, the reply agents,
automation, segmentation and classification, the spam filters, notifications, delegation of access
and, above all, the first session of onboarding, with every function reachable by an agent over
MCP and the API; then two or three waves of fixes before returning to B-179 and B-180.

**Method.** Five parallel read-only hunts, one per area, each finding with its `file:line`, a
failure scenario and the test that proves the fix. Confidence: *read* (traced end to end),
*run* (reproduced with a script), *plausible* (depends on a provider's live behaviour). Every fix
lands with a test that fails without it (checked for C-1/C-2 by reverting the fix).

## Waves

| Wave | Closes | State |
|---|---|---|
| 1 | Security, mail an agent should not read, lost or doubled work: N-1, N-2, N-3, N-8, C-1, C-2, C-3 (= A-1), C-4, C-6, C-8, C-9, C-11 (= A-11), C-12, A-2, A-3, A-4, M-1, M-2 | 0.40.0 |
| 2 | Agents, automation, onboarding, parity: A-5…A-9, A-12, A-13, O-1, O-3, O-4, O-6, O-7, O-9, P-1, P-4, M-3, M-4, M-6, C-5, C-7, C-10, C-13, N-4 (A-10 and P-2 are no defects, below) | 0.41.0 (B-182) |
| 3 | Notifications and the rest: N-5, N-6, N-7, N-9, N-10, O-2, O-5, O-6b, O-8, O-10, O-11, O-12, P-3, P-5, P-6, M-5, M-7, M-8, M-9, A-9b, C-7b | B-183 |

## Findings

Severity: **crit**ical, **high**, **med**ium, **low**. Paths as of `a7091be`.

### Access and notifications (N)

| Id | Sev | Where | What | Conf. | Wave |
|---|---|---|---|---|---|
| N-1 | crit | `workers/app.ts` member middleware | A member's request was gated on the raw path, the router on the decoded one: `PUT /%61pi/members/x` made a member administrator, `/%6dcp` reached the agent protocol | run | 1 |
| N-2 | high | `workers/routes/fabric-service.ts` events | A key limited to one mailbox read every mailbox's agent events at `/fabric/v1/events` | read | 1 |
| N-3 | med | `workers/mcp/scope.ts` `toolFitsScope`, `scopedApi` | An admin key narrowed to a mailbox kept that mailbox's administrator actions (disconnect, reply agent) a member is refused | read | 1 |
| N-4 | med | `workers/mcp/keys.ts` | Keys a person made survive their removal; a key does not record who made it | read | 2 |
| N-5 | med | `desktop/new-mail.cjs` | A timestamp watermark misses account mail that syncs after a newer Cloudflare message | read | 3 |
| N-6 | med | `desktop/new-mail.cjs` | One email announced twice when its merged row changes id | read | 3 |
| N-7 | low | `desktop/new-mail.cjs` | A check started before the switch went off still notifies | read | 3 |
| N-8 | low | `workers/lib/member-gate.ts` | A member could not see or decide held mail in their own mailboxes | read | 1 |
| N-9 | low | `workers/mcp/scope.ts` `narrowFeed` | A member's feed includes accounts an administrator hid | read | 3 |
| N-10 | low | `desktop/connect.cjs` | Two listeners on one port: the dialog may name one, the key reach the other | plausible | 3 |

### Classification, spam and safety (C)

| Id | Sev | Where | What | Conf. | Wave |
|---|---|---|---|---|---|
| C-1 | crit | `workers/categories/store.ts` `moveAccount` | A renamed address's queued item kept the old account in its payload; decided under it, its row never left and the queue spun every 200 ms | run | 1 |
| C-2 | high | `workers/categories/store.ts` `moveAccount` | The safety table was not moved on rename: a held message read as unchecked under its new address | run | 1 |
| C-3 | high | `workers/durableObject/index.ts` incoming | A known sender's message reached its agent before the safety check could hold it (also A-1) | read | 1 |
| C-4 | high | `shared/mail/spam.ts` | A forged From of a correspondent or an allowed sender (their domain's DMARC failing under p=none) was clean, so never screened | read | 1 |
| C-5 | med | `workers/categories/store.ts`, `shared/mail/spam.ts` | Image-only or link-only HTML mail is "too little to judge" and skips the spam model | read | 2 |
| C-6 | med | `shared/mail/spam.ts` | Internationalised domains could not be listed as spam or not spam | run | 1 |
| C-7 | med | `workers/routes/spam.ts` | Not spam never brings a message back into categories or to its agent | read | 2 |
| C-8 | med | `workers/categories/store.ts` `decide` | A failing spam model lost the verdicts of rule-only categories | read | 1 |
| C-9 | med | `shared/mail/spam.ts` `namedDomain` | A sender name wearing our domain after a longer mention escaped the B-172 rule | run | 1 |
| C-10 | med | `workers/categories/classify.ts` | Over 40 described categories, or long answers, break every classification | read | 2 |
| C-11 | low | `workers/providers/accounts-do.ts` | With the safety check off, every account's agent waited 15 minutes (also A-11 for rules) | read | 1 |
| C-12 | low | `shared/mail/spam.ts` `authResults` | A result was read anywhere in the header, comments and properties included | plausible | 1 |
| C-13 | low | `workers/categories/store.ts` drain | Two queue rows of one message can be classified side by side | read | 2 |

### Reply agents and automation (A)

| Id | Sev | Where | What | Conf. | Wave |
|---|---|---|---|---|---|
| A-1 | high | see C-3 | | read | 1 |
| A-2 | high | `workers/agents/registry.ts` `release` | A held message released after its 15-minute hold was never answered | read | 1 |
| A-3 | high | `workers/agents/registry.ts` `answerAgain`, `beginRun` | Every answer-again and held retry was treated as an interrupted re-run, so tools that act were refused | read | 1 |
| A-4 | high | `workers/agents/prefilter.ts`, `runner.ts` | On Gmail, IMAP and Outlook the sender filters (own address, no-reply, hand-off) missed a sender with a shown name | run | 1 |
| A-5 | med | `workers/agents/account-deps.ts` | Two messages of one account thread can each get a reply (the sent copy is not cached) | plausible | 2 |
| A-6 | med | `workers/automation/engine.ts` | A rule run dismissed while it waits for the safety check comes back pending | read | 2 |
| A-7 | med | `workers/agents/registry.ts` drain | An answered-again run whose message is gone stays "running" for good | read | 2 |
| A-8 | med | `shared/mail/agent-state.ts` | A message passed to a person reads as "no reply needed" | read | 2 |
| A-9 | low | `workers/automation/policy.ts` | Forward rules to a served address loop to their daily limit | read | 2 |
| A-10 | low | `workers/lib/agent-status.ts` | Addresses with no agent count as unanswered and abandoned | read | 2 |
| A-11 | low | see C-11 | | read | 1 |
| A-12 | low | `workers/agents/registry.ts` `updateAgent` | An account's agent can be switched to drafting where drafts cannot be kept | read | 2 |
| A-13 | low | `workers/agents/runner.ts` `waitingTextsOf` | A waiting reply with a dash is mistaken for an answer | read | 2 |

### Receiving and sending (M)

| Id | Sev | Where | What | Conf. | Wave |
|---|---|---|---|---|---|
| M-1 | high | `workers/providers/gmail-client.ts`, `workers/routes/accounts.ts`, `workers/lib/email-helpers.ts` | A reply in a thread of about 14 messages was refused: References passed one header line | run | 1 |
| M-2 | med | `workers/providers/gmail-sync.ts` | Mail Gmail filed in Spam or Trash reached rules, categories and the safety check | read | 1 |
| M-3 | med | `workers/providers/account-service.ts` | Account events that fail 10 times are kept nowhere a person or agent can see or retry | read | 2 |
| M-4 | med | `workers/providers/accounts-do.ts` `drain` | Two drains can overlap and deliver the same events twice | plausible | 2 |
| M-5 | low | `app/routes/unified-inbox.tsx` | A UI reply from an account leaves the parent's id out of References | read | 3 |
| M-6 | low | `workers/lib/schemas.ts` | A person's send can stamp itself Auto-Submitted | read | 2 |
| M-7 | low | `workers/providers/gmail-sync.ts` | Mail in an expired-history gap never reaches agents or rules | read | 3 |
| M-8 | low | `workers/actions/incoming.ts` | An owed forwarding copy blocks renaming the address for ever | read | 3 |
| M-9 | low | `workers/index.ts` `resolveRecipient` | Plus-addressed mail is refused | plausible | 3 |

### First-session onboarding (O) and MCP/API parity (P)

| Id | Sev | Where | What | Conf. | Wave |
|---|---|---|---|---|---|
| O-1 | high | `desktop/cloudflare-deploy.cjs` | Updating a server that signs in on its own domain moves the app to an unprotected workers.dev address | read | 2 |
| O-2 | med | `desktop/cloudflare-deploy.cjs` | The Worker upload cannot finish on a slow connection (60 s per call) | plausible | 3 |
| O-3 | med | `scripts/onboard.mjs` | `server` deploys an old bundle after a pull without a version bump | read | 2 |
| O-4 | med | `plugins/fabric-inbox/scripts/onboard.mjs` | Every Cloudflare refusal reaches a launcher as `unexpected`, with no line for the person | read | 2 |
| O-5 | med | `app/components/settings/sections/DomainsSection.tsx` | Domains is a dead end when no domain is on Cloudflare | read | 3 |
| O-6 | med | `desktop/main.cjs`, `app/routes/unified-inbox.tsx` | After an agent's setup the empty inbox points at Accounts, not Domains | read | 2 |
| O-7 | med | `plugins/fabric-inbox/scripts/onboard.mjs` | "Let my agent set everything up" stops after `connect` (a mail key); the replaced key is not revoked | read | 2 |
| O-8 | low | `desktop/connect.cjs` | Allow is asked before the session is checked; failures reach the agent as bare codes | read | 3 |
| O-9 | low | `scripts/onboard.mjs` | The server step keeps the previous server's key in the record | read | 2 |
| O-10 | low | `desktop/main.cjs` | A brand-new workers.dev name may not resolve for a few minutes | plausible | 3 |
| O-11 | low | `desktop/setup.js` | The update form demands an email it then ignores | read | 3 |
| O-12 | low | `desktop/cloudflare-deploy.cjs` | The token step opens the plain API Tokens page | plausible | 3 |
| P-1 | med | `workers/mcp/tools.ts` | Outlook links name `connect=outlook`; the app's id is `microsoft` | read | 2 |
| P-2 | low | `workers/mcp/tools.ts` | Human-step links needing a secret are relative paths | read | 2 |
| P-3 | low | `workers/mcp/handler.ts` | On an Outlook-only server, agent account changes can be refused for their origin | plausible | 3 |
| P-4 | low | `workers/mcp/tools.ts` | `create_address` rejects names the route accepts | read | 2 |
| P-5 | low | `tests/mcp-coverage.test.ts` | A route counts as covered when a tool only lists it; routes outside `api` are not checked | read | 3 |
| P-6 | low | `workers/index.ts` | Some first-session server errors are not translated | read | 3 |

## Wave 1: what changed

- **N-1:** the member gate and the Access audience judge `c.req.path`, the path Hono routes.
- **N-2:** `/fabric/v1/events` refuses a limited or narrowed key (403).
- **N-3, N-8:** the administrator mailbox actions moved to `scope.ts` (`adminMailboxAction`); scoped keys and members are refused them, and members reach the safety routes through the scoped API.
- **C-1, C-2:** `moveAccount` rewrites queued payloads and moves `safety`; a queued item's row account is the authority (`queued`).
- **C-3, C-11, A-11:** `safetyChecks(env)` (on, AI bound, categories bound) decides every wait for the safety check: every Cloudflare message is held for it, and nothing waits when it cannot run.
- **C-4:** a From whose own domain's DMARC failed is not clean by an allow list or by having been written to; it is screened.
- **C-6:** list entries and senders are compared in their ASCII (punycode) form.
- **C-8:** rule-decided verdicts are written before a spam-model retry.
- **C-9, C-12:** every mention of our domain in a name is read; results are read per clause, comments removed.
- **A-2, A-3:** a late release answers a safety-skipped run again; a run queued again on purpose (`requeued`) is not a re-run.
- **A-4:** the sender filters read the address inside "Name <address>".
- **M-1:** `trimReferences` keeps the root and the newest ids within 900 characters, for accounts and Cloudflare mailboxes.
- **M-2:** Gmail mail labelled Spam or Trash queues no event.

## Wave 2: what changed

- **O-1:** a server whose sign-in is its own domain's Access application keeps that address on update; workers.dev is not published and the origin returned is that domain (null when it cannot be read: the app and `onboard.mjs` ask for it, never assume the known server).
- **O-3, O-4, O-7, O-9:** `onboard.mjs` rebuilds a bundle of another commit (`bundleStale`), turns Cloudflare refusals into codes with a line for the person (`permission`, `r2_off`, `zero_trust_off`, `server_newer`), names the key a new `connect` replaces (`replacedKey`), and drops another server's key from the record; the skill and `docs/agents/onboard.md` say a first setup needs `--level admin`.
- **O-6:** after signing in to a server an agent set up, the app opens Settings → Domains (SCN-077 step 2).
- **P-1, P-4:** Outlook links open `connect=microsoft`; `create_address` takes the names the route takes.
- **C-5, C-7:** a link or image makes HTML mail judged by the spam model, its first links in the text it reads; a message under three days old taken out of Spam is delivered again to rules, categories, the safety check and the agent (`IncomingJournal.redeliver`).
- **C-10, C-13:** categories are classified 12 per model call; one queue row of a message per drain.
- **A-5, A-6, A-7, A-8, A-12, A-13:** an account conversation counts the agent's own sent runs (`sentInThreadAfter`); a rule's waiting write is transactional (`saveIfPending`) and a kept message ends it; a requeued run with no message ends skipped; a hand-off waits for its person; an agent on an account without drafts is not switched to drafting; waiting texts are compared as sent.
- **A-9:** a forward rule to its own address, or on mail that address sent, never runs (`forwardLoops`).
- **M-3, M-4, M-6:** account events set aside are counted (`stuckEvents`, in `list_accounts` as `stuck`), retried (`POST /api/accounts/:accountId/incoming/retry`, `retry_incoming`) and removed with the account; account drains run one at a time (`oneAtATime`); `auto_submitted` is dropped from sends through the app's route.
- **N-4:** a key records who made it (`createdBy`); removing that person, or making them a member, revokes their keys.

## No defects

- **A-10:** the reply status of an address with no agent shows its conversations still waiting for a reply. That is what SCN-079 ("See which conversations still need a reply") asks; agent events (`superviseAbandoned`) already cover only addresses with an agent.
- **P-2:** a human-step link that is a path is allowed by the contract (`delegation-refusal.schema.json`: `^(https://|/)`, "a path on the service's origin"); the agent knows the origin it called.

## Left for wave 3

- **O-6b:** the empty inbox's text names Gmail and Cloudflare only, not Outlook and IMAP, and its button opens Accounts when Cloudflare is connected but has no address yet.
- **A-9b:** two addresses forwarding to each other still loop until each rule's daily limit (20 by default).
- **C-7b:** Not spam on a Gmail, IMAP or Outlook account moves the message but does not deliver it again to rules and the agent.
