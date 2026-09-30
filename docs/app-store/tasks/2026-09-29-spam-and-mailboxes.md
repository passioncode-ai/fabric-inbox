# Spam, and managing mailboxes — 2026-09-29

Request (paraphrased): look for bugs again; spam is missing — its own
filtering and categorisation; check whether mailboxes can be created, deleted and managed with their
Cloudflare side from the app, and if not, build it; fix what is found in UI, UX and code.

## What the check found (code and the installed app, 2026-09-29)

- **Spam.** Every mailbox has a `spam` folder (`workers/durableObject/migrations.ts:101`), and
  nothing ever puts mail in it. The unified feed has no Spam folder; Gmail's spam is hidden from it
  (`workers/providers/account-service.ts:335`). Agents and categories would read spam like any mail.
- **What a spam filter can stand on.** Cloudflare Email Routing adds `Authentication-Results:
  mx.cloudflare.net; dkim=… dmarc=… spf=…` and `Received-SPF` to every delivered message (seen on a
  live Substack newsletter: dkim pass, dmarc pass with `policy.dmarc=reject`, spf none). It also adds
  `X-CF-Spamh-Score`, which Cloudflare does not document (a docs search on 2026-09-29 found nothing);
  it is not used.
- **Two ways to manage mailboxes that disagree.** Domains & addresses (`/projects`) creates the
  routing rule, refuses to remove a domain's catch-all and removes the rule before the mailbox. The
  older Mailboxes screen (`/mailboxes`, `POST`/`DELETE /api/v1/mailboxes`, `workers/index.ts:93-123`)
  does neither: a mailbox deleted there leaves its Cloudflare rule pointing at nothing, and the
  catch-all can be deleted with the domain still sending unknown addresses to it.
- **Settings.** The Settings page writes back the whole settings object read when the page opened
  (`app/routes/settings.tsx:41-48`, `PUT` replaces it at `workers/index.ts:111-118`), so an agent or
  copy changed meanwhile is reverted. The mailbox signature the agent appends
  (`workers/agents/runner.ts:335`) cannot be set anywhere. An existing address's forwarding copy
  cannot be changed after it was created.

## Decisions (operator, 2026-09-29)

| Question | Answer |
|---|---|
| What goes to Spam without the operator | **Forgery + the model**: a failed authenticity check (DMARC fail where the domain asks to reject or quarantine, SPF fail without a valid signature, a forgery of one of our own domains) and senders or domains the operator marked go straight to Spam; mail from a sender nobody here has written to is also read by the model, within a daily budget, with the reason shown |
| What happens to mail in Spam | **Deleted after 30 days**; until then Not spam brings it back. Agents, rules and categories never act on it |
| The older Mailboxes screen | **One path through Cloudflare**: creating and deleting there use the same server logic as Domains & addresses (rule created and removed, catch-all guarded, confirmation first); Mailboxes stays a list of mailboxes with a link to Domains & addresses |

## Requirements (frozen; adding is free)

| REQ | Requirement | Verified by |
|---|---|---|
| SP-1 | On arrival a Cloudflare message gets a spam verdict from the operator's lists and the authenticity results Cloudflare wrote (only the topmost `mx.cloudflare.net` result counts); spam is stored in Spam with its reason, is not forwarded as a copy and reaches no agent, rule or category | `tests/spam.test.ts`; workerd test through `receiveEmail` |
| SP-2 | Mail from a sender no mailbox here has written to, that passed the checks, is read by the model once, in the same call as the categories when there are any, within `SPAM_DAILY_LIMIT` (default 300); a spam answer moves it to Spam with the model's reason; over the budget it stays where it is | `tests/categories.test.ts` with a scripted model |
| SP-3 | Report spam and Not spam from the reader, for Cloudflare and Gmail: the message moves, and the sender (or the whole domain, when chosen) goes on the block or allow list; Gmail uses its own spam label | workerd tests; `tests/inbox-ui.test.ts` |
| SP-4 | A Spam folder in the unified feed across every inbox (Cloudflare `spam`, Gmail `SPAM`) with each message's reason; its header says mail is deleted after 30 days and offers Delete all now with confirmation | `tests/inbox.test.ts`; installed app |
| SP-5 | Spam older than 30 days is deleted with its attachments by the mailbox's own alarm | workerd test with a shifted clock |
| SP-6 | A Spam rules screen: blocked and allowed senders and domains, add and remove, what the filter does, the model budget | route tests; installed app |
| MB-1 | Creating and deleting a mailbox from Mailboxes goes through the same logic as Domains & addresses (routing rule, catch-all guard, confirmation) | route tests |
| MB-2 | Settings save only what they edit (display name, signature, agent prompt), merged on the server; the signature can be edited | route tests; installed app |
| MB-3 | An existing address's forwarding copy can be changed or removed; the catch-all can send a test message | route tests; installed app |
| MB-4 | Findings of the mailbox-management audit fixed, each with a test | **Audit** below |
| DOC | Brief audit, architecture, setup, scenarios, board, release | receipts |

## What was built, and its evidence

| REQ | Where | Evidence |
|---|---|---|
| SP-1 | `shared/mail/spam.ts (authResults, spamCheck)`, `workers/index.ts (spamVerdict)`, `MailboxDO.receiveEmailOnce` (migration `11_spam_reason`) | `tests/spam.test.ts` (7 cases: topmost Cloudflare result only, DMARC reject/quarantine vs none, SPF without a signature, own-domain forgery, lists first); `tests/spam-workerd.test.ts` "a forged message goes to Spam on arrival…" (watched failing with the consumer guard removed) |
| SP-2 | `workers/categories/store.ts` (spam as `SPAM_CATEGORY` in the same call, `spam_checks`, `spam_budget`), `tooLittleToJudge`; since 0.6.2 a stranger's agent answer waits for this check (`AgentRegistryDO.enqueue` hold, `release`) | `tests/spam-workerd.test.ts` "a stranger's message is read by the model once…", "over the day's spam budget…", "an almost empty message is not judged…" |
| SP-3 | `workers/routes/spam.ts` (report, release), `MailboxDO.markSpam/markNotSpam`, Gmail `setSpam` (SPAM label), `workers/spam/lists.ts` (conditional writes) | `tests/spam-workerd.test.ts` "Report spam moves the message and blocks the sender…", "two list changes at once both land"; `tests/inbox-ui.test.ts` "SP-3: Report spam sends the message and its sender…"; live below |
| SP-4 | Spam folder in `/api/inbox` (both providers), `SpamBanner`, `inSpam` rows | `tests/spam-workerd.test.ts`; live below |
| SP-5 | `MailboxDO.purgeSpam` on its own alarm (`armSpamPurge`) | `tests/spam-workerd.test.ts` "Spam older than 30 days is deleted with its attachments…" (watched failing with the attachment delete removed) |
| SP-6 | `app/routes/spam.tsx` (SCR-14) | installed app |
| MB-1 | `workers/lib/address-ops.ts (createAddress, removeAddress)` behind both `/api/project-addresses` and `/api/v1/mailboxes` | `tests/domains.test.ts` "the Mailboxes screen creates and removes through the same path…"; live below |
| MB-2 | `PUT /api/v1/mailboxes/:id` merges `fromName`, `signature`, `agentSystemPrompt` only; Settings signature editor | `tests/domains.test.ts` "Settings save only what they edit…" |
| MB-3 | `PUT /api/project-addresses/:email/copy`, `AddressRow` Change | `tests/domains.test.ts` "an address's forwarding copy can be changed or removed…"; installed app |

## Audit

The mailbox-management audit (read-only, 18 findings) and what the installed app showed. Each
row names its fix and the test that fails without it.

| # | Finding | Fix | Evidence |
|---|---|---|---|
| 1 | Connect run again turned every address's agent Off and replaced the chosen catch-all, reporting "already" | imported addresses name no agent; a stored catch-all is kept; updates count as done | `tests/domains.test.ts` "connecting again keeps each address's agent…" (watched failing with the kept-catch-all block removed); `tests/setup.test.ts` updated to the new contract |
| 2 | Release un-served the domain when the zone lookup failed | a failed lookup keeps serving (502); an invisible zone asks for `force` (409) | "release keeps serving when the zone cannot be looked up…" (watched failing with the old catch-all path) |
| 3 | Rules and catch-alls sending to another Worker were taken over | left as they are, named in the step | "rules that send mail to another Worker are left alone…" |
| 4 | Non-Cloudflare errors reported as "Cloudflare could not be reached"; one bad settings file broke the list | honest message; unreadable files logged and skipped; settings writes conditional on the etag | code; `tests/project-addresses.test.ts` fake bucket now conditional like R2 |
| 5 | A disabled rule pointing here could not be switched on | `ensureRule` enables it | "adding an address: a disabled rule pointing here is switched on…" |
| 6 | An address on a served zone the token cannot see failed with 502 | created with a warning; the UI sends `createRoute` only with a visible zone | same test |
| 7 | Choosing a catch-all overwrote Cloudflare's without keeping its forward; partial failure showed "Request failed" | the old forward becomes the mailbox's copy; another Worker's catch-all is refused; every step failure answers with `error` | "choosing a catch-all keeps the old forward as a copy…" |
| 8 | A catch-all set by `UNKNOWN_ADDRESS_POLICY` was invisible and deletable | `effectiveCatchAll` with its source, shown and guarded | "a catch-all set by the deployment is shown with its source and guarded" |
| 9 | Creating an address could leave an orphan rule | every check runs before Cloudflare; a rule this call made is removed if the mailbox cannot be saved | "adding an address … a refused address leaves no rule" |
| 10 | Step results vanished when a domain changed lists | `StepMemory` at page level | typecheck; installed app |
| 11 | The removal text claimed what happens next without checking | read from `status()` after the rule is gone; `deleteMailbox` failure answered | "the Mailboxes screen creates and removes…" (`afterwards` names the catch-all) |
| 12 | Release switched a disabled rule back on; a failure dropped what had changed | disabled stays disabled; "Already changed" kept | code |
| 13 | `delivery-issues` survived a removal | deleted with the address and on a new copy | code |
| 14 | Routing and inbox caches stale after an action | every action re-reads `routing`, `unified-inbox`, domains and addresses | code |
| 15 | An agent list that failed showed "Off" | the answering agent is kept as an option | code |
| 16 | The catch-all select changed Cloudflare on every arrow key; confirmations did not take focus | choose, then Apply; the remove confirmation takes the focus | installed app |
| 17 | Mailboxes list showed addresses as names; its domain list never refreshed; a blank name could be saved | display names; 60 s stale time; a name is required | "Settings save only what they edit…" |
| 18 | Races around re-created addresses (suspected) | not changed | board B-29 |
| — | `EMAIL_ADDRESSES` given as a string crashed inbound mail and mailbox creation (found by the new tests) | `allowedAddresses()` reads an array, a JSON string or a comma list | `tests/spam.test.ts` "EMAIL_ADDRESSES is read in every shape…" |

### Found in the installed app (2026-09-29)

- **A live false positive**: a message from a stranger whose whole body was "Wysłane z iPhone'a"
  was judged cold outreach by the model and moved to Spam. Such mail is no longer read by the
  model (`tooLittleToJudge`, under 20 characters once "Sent from…" lines go, no link). The message
  it moved is still in Spam, where its reason says what happened; Not spam brings it back.
- Report spam and Not spam were run on a real message through the reader: it moved to Spam with its
  reason, the sender went on the block list, Not spam brought it back and put the
  sender on the allow list; the list entry was then removed, so the lists are empty as before.
- A mailbox created from the Mailboxes screen (a test address on one of the owner's domains) got its
  routing rule ("goes to fabric-inbox", via rule); deleting it removed the mailbox (404) and the rule,
  and the message said new mail now goes to that domain's catch-all mailbox (routing via catch-all).
- Fixed on the way: Spam's empty state spoke of syncing accounts; Delete all now showed on an empty
  Spam; the spam counts showed 0 read with 1 found (a check made with a category spends no spam
  budget); Spam rows showed "People" and an Important mark; Focus was offered in Spam; a report's
  reason read "You marked it as spam, and its sender"; disabled buttons on the standalone screens
  looked enabled.
- Mail that arrived before 0.6.0 was not re-checked: the filter acts on arrival.
