# Administration workflows

Load when an `admin` key changes how Fabric Inbox is set up. Each block is the order of calls that
works; the live tool schemas have every input.

## Contents

- [Addresses](#addresses)
- [Cloudflare accounts](#cloudflare-accounts)
- [Domains](#domains)
- [Forwarding copies](#forwarding-copies)
- [Spam](#spam)
- [Discard rules](#discard-rules)
- [Reply agents](#reply-agents)
- [Categories and projects](#categories-and-projects)
- [Knowledge](#knowledge)
- [Rules](#rules)
- [Setup files](#setup-files)
- [Checking your own work](#checking-your-own-work)

## Addresses

- **Check first:** `check_address` with the `domain` and the `localParts` you mean to create. Its
  `state` says whether the domain receives here (`can_receive` means `connect_domain` first;
  `needs_fix` means its Email Routing must be fixed — `connect_domain` again); each name is
  `available`, `exists`, `elsewhere` (a Cloudflare rule sends it somewhere else — tell the person
  where, do not override it), `invalid` (with why) or `restricted` (the server creates only the
  addresses its `EMAIL_ADDRESSES` setting lists). Read its `notes` to the person: the catch-all
  keeping that address's mail today, mail that arrived for it recently, role names.
- **Create:** `create_address` with `localPart`, `domain`, optionally `name` (default: the name,
  capitalised), `signature`, `agent`, `forwardTo`; several at once: `create_addresses` with
  `localParts` and the same settings for all. One call does only what fits the server's Cloudflare
  budget for a request: while `complete` is false, call `create_addresses` again with the names in
  `remaining` (the same settings) until it is true. `createRoute` defaults to `"auto"`: the rule is
  made when the server can, and when it cannot the address is still created — read its `steps`: a
  rule step `skipped` or `failed` carries the reason and a `fix` (`route_address_here` makes the
  rule again once the cause is gone); `not_receiving` means the rule exists but the domain's Email
  Routing is off or broken (`connect_domain` turns it on again). If a call's answer is lost,
  `check_address` with the same names says which exist now; never assume none were created.
- **An address whose Cloudflare rule sends it elsewhere:** `bring_address_here` makes its mailbox,
  keeps the old forward destination as its copy and points only that rule here; the catch-all and
  the domain's other addresses stay as they are (`connect_domain` moves them all).
- **Prove it:** `send_test_message` → `check_test_message` every few seconds until its `state` is
  `arrived` or `not_arrived` (after 3 minutes); `not_arrived` → `check_address_routing`.
- **Change:** `update_address` — only the fields you pass change: `fromName`, `signature`,
  `assistantPrompt`, `agent` (`"off"` or `{ agentId }`), `forwardTo` (`null` stops forwarding).
- **Remove:** `remove_address` is two-step and deletes the address's mail for good. Its summary
  says how much; the person decides.
- **Pause instead of removing:** `pause_address` keeps the mailbox, its mail, settings and agent,
  switches its Cloudflare rule off, and new mail goes to the domain's catch-all or is refused (the
  answer says which); `resume_address` undoes it. The catch-all mailbox itself cannot be paused.
- **Rename or move:** `rename_address { address, to }` moves everything (mail, attachments, drafts,
  folders, settings, who answers, category labels) to `to`; the old address delivers to it for 30 days.
  `state: running` means call again with the same addresses (it continues, nothing twice);
  `rename_status` reads where it stands. Until it ends the old mailbox is read-only and the address
  cannot be removed, paused or made the catch-all; new mail already lands in `to`. `cancel_rename`
  undoes it while `cancellable` is true (before the new address is routed).
- **Mail arrives elsewhere:** `check_address_routing` says where it goes; `route_address_here`
  points it at this server.
- **Hide from the sidebar:** `set_hidden_addresses` (it keeps receiving).

## Cloudflare accounts

- **See them:** `list_cloudflare_accounts` — every account the server has a token for, whether it
  has mail, whether it is shown, and whether its relay is installed. `list_domains` lists only the
  shown accounts' domains, each with its `account`.
- **Show or hide:** `show_cloudflare_account` with `shown` (`null` = the default: shown when it has
  mail). An account whose domain receives here cannot be hidden.
- **Connect one more:** only the owner can, in the app (Settings → Accounts → Connect account →
  Cloudflare): the token is a secret and never goes through a tool. Say so rather than asking for it.
- **Remove:** `remove_cloudflare_account` — two-step; refused while one of its domains receives
  here (`release_domain` first).

## Domains

- **Receive a domain here:** `list_domains` → `connect_domain`. A domain in another account than
  the server's gets a `relay` step first: the server installs a small Worker there that carries its
  mail here. If another provider's MX records
  are there it stops with that finding; `replaceMx: true` replaces them — two-step, and mail stops
  reaching the old provider, so the person must say yes knowingly.
- **Catch-all:** `set_catch_all` with a mailbox, or `null`. Refused when the deployment fixes it.
- **Sending:** `enable_domain_sending` (adds DMARC when missing).
- **Stop serving:** `release_domain` — two-step; mailboxes and mail stay.

## Forwarding copies

A copy goes only to a **verified** destination **in the address's own Cloudflare account**:
`list_domains` with `destinations: true` and that domain's `account` → if absent,
`add_forward_destination` with the same `account` (Cloudflare emails it a link; someone must click
it) → once verified, `update_address` with `forwardTo`, or `create_address` with it.
Calling `add_forward_destination` again sends no new link; `resend: true` does, for one still
waiting. Removing one: first `update_address { forwardTo: null }` on every address that copies to
it, then `remove_forward_destination` (two calls); it is refused while a Cloudflare rule of the
account forwards there, and names domains whose rules it could not read (`force: true` then).

## A person answers, the agent stays silent

`save_agent` with `replyPolicy.silentHandoff { senders: ["@desk.example", "lead@other.example"],
topics: ["aml review"] }`: such mail gets no reply at all, no model runs, and the run raises
`agent.handoff` (watch it with `add_event_hook` or `list_agent_events`).

## Spam

`get_spam_settings` → `update_spam_list` (`blockedSenders`, `blockedDomains`, `allowedSenders`,
`allowedDomains`; `add` or `remove`). Judging messages is `mark_spam` (mail level). `empty_spam` is
two-step and permanent for Cloudflare mailboxes; Gmail's Spam is not touched.

Why a Cloudflare message went to Spam, or stayed out: `check_spam` runs the check again on it and changes
nothing. It answers the arrival rules, the domain the receiving server verified, and the model's kind
with its reason: a transactional notice, a customer, a conversation, a service's update or other keep it;
phishing, a scam, cold outreach and bulk marketing are spam. Each call counts against the day's spam
budget. A message the check now keeps is brought back with `mark_spam` `spam: false` (`list: "none"` when
the sender should not be allowed for good).

## Discard rules

`list_discard_rules` (each rule with why and its counts, the Always allow list) → `remove_discard_rule`
with its `ruleId` to stop discarding mail like it (what is in Discarded stays), or
`update_discard_allow_list` (`add` or `remove` an address or a domain) so a sender is never discarded
on arrival. Rules are learned by `discard_messages` (mail level), never written directly.

## Reply agents

- **Create:** `list_agents` (templates, allowed tool hosts) → `save_agent` with the whole
  definition (a new agent drafts every answer until `replyPolicy.mode` is `auto`) →
  `update_address` with `agent: { agentId }` for each address it answers.
- **On a Gmail, IMAP or Outlook account:** `set_account_agent` with the account's `accountId`
  (`list_accounts`) and `agent: { agentId }`, or `"off"`. Replies leave from the account itself; an
  agent that drafts is refused on an account whose `capabilities.drafts` is false. `list_agents` names
  each agent's `accounts` beside its `addresses`. Only mail that arrives after the choice is answered.
- **Change:** `list_agents` with `agentId` → `save_agent` with `agentId`, the full `agent`, and
  `expectedVersion` = its current version. A conflict means someone changed it meanwhile: read
  again, merge, retry.
- **Guards for an auto-sending agent:** `replyPolicy.draftFollowUps: true` leaves replies, forwards and
  follow-ups to an earlier answer to a person; `draftTopics` lists topics a person answers (`a|b` are
  alternatives matching where a word starts, `"att"` a whole word, `x|y + z` needs one of each group); `requireEvidence: true` sends only when a granted
  tool answered confidently. A sent answer's `evidence` (request id, cited items, revision) is on the run.
  For a lane where every message gets a reply: `fallbackReply: { en, ru? }` (a fixed text without facts, sent
  instead of a draft), `categories` (the agent labels each message) and `handoff: { categories, topics, reply }`
  (a fixed reply naming who handles it; `replies: { <category>: { en, ru? } }` gives a category its own).
  `knowledgeIsEvidence: true` lets an answer built from the agent's own knowledge leave when a knowledge
  tool abstains, if the checker approves it. Events add `agent.handoff` and `agent.not_helped`.
  Nobody waits without a word (B-131): a held message (`holdUnsure`) still unanswered a day after it came
  gets `waitingReply: { en, ru? }` once (a default text when unset; it stays held and is answered when the
  knowledge has it), and a message held or drafted 4 hours without a reply raises one `agent.waiting` event.
  So does a message whose run failed before anything was sent (it is tried again hourly for a day, then like
  a held one) or that the safety check held back. When the retries end (30 days), the message gets
  `closingReply: { en, ru? }` once (unset: a short apology and the `handoff.reply`; nothing without either)
  and a second `agent.waiting` with `closed: true`. A held retry is skipped while the knowledge's revision
  is the same, and runs at once when it changes; one gap report per message.
  After each UTC day, `list_agent_events` carries one `support.quality_daily` per agent address (B-130): replies
  and first-reply p50/p90, repeats, errors and model calls, answered vs handed to a person, the person queue;
  a field not measured is null and listed in `notMeasured`. Sender, subject and texts leave runs after 30 days.
  A knowledge change is on the same feed (B-161): `knowledge.learned` when a document is added or changed or an
  agent's own knowledge text changes, `knowledge.retracted` when a document is removed, each with its `ref`
  (a new version is a new ref), the addresses whose agents read it and `validatedBy` (operator, agent).
  Its `quality` comes from a daily judge (B-132): up to 30 sent answers per address, rubric v1, a model of
  another vendor than the writer and checker; the verdict and its note are on the run (`list_agent_runs`).
  To choose a judge on your own mail, `judge_bench { address, days?, runs?, models?, reference? }` (B-152) has
  each model grade the same sent answers with that rubric beside a reference with reasoning on; call it
  again until `done`, then page `lines` (hashes, marks, cost, ms; no words of the mail). It spends OpenRouter.
  `agent_mail_volume { days }` gives per-address, per-day counts (received, agent runs, no run, spam).
  Where each conversation stands: `list_agent_threads { states?, abandoned?, address? }` (unanswered,
  new_after_agent, error, needs_data, agent_draft, working, agent_replied, person_replied, no_reply_needed;
  `counts` for all, `abandoned` for how many wait 48 hours). Start with `abandoned: true` (taken by nobody for
  two days, a waiting reply is no answer), then `states: ["unanswered", "new_after_agent", "error",
  "needs_data", "agent_draft"]`, the ones waiting for someone; no_reply_needed is mail the agent left alone
  on purpose (empty, a newsletter, an auto-reply, an own address). It covers the addresses, and the Gmail, IMAP or
  Outlook accounts with a reply agent (by their email), where the reply status is on: `get_agent_status`, and `set_agent_status`
  per workspace, domain or address (off by default; null follows the level above). `read_thread` marks each
  sent message `sentBy` (agent, agent_waiting, person) and each one that came in with its `agentRun`.
  To have events pushed instead of polled (a helpdesk, a support group): `add_event_hook { url, kinds? }`
  (https; default kinds agent.handoff, agent.needs_look, agent.waiting, agent.abandoned) answers a secret once: verify each
  POST's `X-Fabric-Signature` (sha256= HMAC of `<X-Fabric-Timestamp>.<body>`) and treat `X-Fabric-Event-Id`
  as the idempotency key. `list_event_hooks` shows delivery and the last error; `remove_event_hook` stops one.
  Test an agent with `preview_agent_answer` (an outside sender, the text): it returns what the agent would do and
  the reply, sending and storing nothing.
- **A shared knowledge base or other remote tool:** grant it in `tools` (its host must be in
  `list_agents`' allowed hosts; the endpoint's input schema is read and stored on save). `fixed` pins
  arguments on every call (e.g. `{ "domain": "acme", "allow_web": false }`); `prefetch:
  { argument: "query" }` asks it about each message before the agent answers — as written in English
  or Russian, otherwise as a short English restatement without personal details (no restatement, no
  question: the answer stays a draft); `publicOnly: true`
  uses an output only when every item with a `class` is `"public"`, so a reply to someone outside
  never cites a confidential source (otherwise the answer stays a draft). A knowledge tool that answers
  `abstained: true` gives only unverified candidates: the answer stays a draft, and `gaps: { tool }`
  (on the same endpoint) is sent the question, paraphrased without personal data, once per message.
- **See what it did:** `list_agent_runs` (outcome `attention` = needs a person).
- **Delete:** `delete_agent`, two-step; its addresses stop being answered.

## Categories and projects

`list_categories` → `save_project` (group domains and addresses; with `projectId` only the fields
you give change) → `save_category` with a `scope`
and either `conditions` (rules, no model) or a `description` (screened by the model, backfilled in
the background). `delete_category` / `delete_project` are two-step.

## Knowledge

`save_knowledge_collection` (`source: { kind: "fabric", project, scope? }` makes one Fabric keeps in
step; a collection's source is chosen when it is made) → `put_knowledge_documents` (up to 100 per call, updated by
`sourceUri`; `prune: true` deletes the rest and is two-step) → grant it with `save_agent`
(`collections`). `search_knowledge` shows what an agent would be given.

## Rules

`list_rules` for the account → `save_rule` (same `id` changes only the fields you give; a new rule
needs `name`, `conditions`, `action` and starts off; the server numbers versions; `mode: approval`
waits for `approve_rule_run`) → `dry_run_rule` on a real message → `save_rule` with `enabled: true`
(the server refuses to enable a new or changed rule with 409 until a dry-run of that same rule
succeeded within a day; a rename or a pause needs none). Runs waiting for
approval appear in `list_rules`; `dismiss_rule_run` cancels one. A run whose status is `unknown`
(its action may or may not have happened) is never retried by itself: `check_rule_run` reads the
provider's or this server's record and settles it as succeeded (done) or failed (proven not done —
only then repeat it by hand), or leaves it unknown with what it found. A tool call cannot be checked.

## Setup files

`export_setup` gives the setup (no secrets); with `fromCloudflare: true` it proposes one from the
account's Email Routing rules. `apply_setup` applies one — two-step, never deletes.

## Moving a mailbox to another server

A person's own server and an organization's server are separate (each its own key). To carry a Cloudflare
mailbox from one to the other with an `admin` key on each:

1. On the sending server, `export_mailbox` action `manifest`: its settings, counts, and `blockers`. Wait while
   `blockers.sends` or `blockers.incoming` is above 0.
2. On the receiving server, `import_mailbox` action `open` with the manifest's `settings` (no agent answers it there
   until one is chosen).
3. For each table in order `folders`, `emails`, `attachments`: `export_mailbox` action `rows` (pass `next` back as
   `after` until it is null), then `import_mailbox` action `rows` with the page's `rows`; for every key in the page's
   `files`, `export_mailbox` action `file`, then `import_mailbox` action `file` with its `key`, `data` and `contentType`.
4. `export_mailbox` action `ids` on the sending server, then `import_mailbox` action `check` with them on the
   receiving one: `complete: true` means every message and attachment arrived.
5. What it carries besides mail: `export_mailbox` action `setup` gives its `rules`, its `agent` and that agent's
   `collections` with their documents listed. On the receiving server, `import_mailbox` action `rules` with them (each
   refused rule comes back with its reason, such as a tool host that server does not allow); for each collection,
   `import_mailbox` action `collection` with its `name` and `description` (its `id` there may differ), then its
   documents: `export_mailbox` action `document` for each, and `import_mailbox` action `documents` with up to 100 at a
   time into that id; last, `import_mailbox` action `agent` with setup's `agent` and `collections` mapping the sending
   server's collection ids to the receiving one's. The agent is not assigned to the address there: that waits until
   the address's mail moves.
6. Its labels: `export_mailbox` action `labels` with no `labelTable` gives the `categories` its labels name; then for
   each `labelTable` value (verdicts, spam_checks, safety) its pages (pass `next` back as `after`), each written with
   `import_mailbox` action `labels` with the page's `rows` and those `categories`. A category label is kept only when
   the receiving server has a category with the same id, description and conditions (it is filed under that
   server's version); the rest come back as `skipped`. Make such a category there first (`save_category`) to keep
   its labels.
7. Its mail (both servers in the same Cloudflare account): `move_address` action `hold` on the sending server (its
   copy there sends nothing new and its agent is off); `move_address` action `route` on the receiving server with
   `expect`, the manifest's `counts` (refused while the copy has fewer); then `send_test_message` and
   `check_test_message` there until it reads `arrived`; then `update_address` to choose its agent there. If the test
   never arrives, `move_address` action `unroute` puts the rule back as it was and `move_address` action `release` on
   the sending server lifts the hold. `move_address` action `status` says where it stands.

Mail is still delivered to the sending server, and nothing there is deleted: routing the address to the new
server is a separate step, not built yet. Repeating any step is safe (rows are brought up to date, a file of the
same size is kept).

## What a person does

Connecting a Gmail or Outlook account, connecting an IMAP account (its app password), setting Gmail
or Outlook up on the server (the Google client secret; the Microsoft Entra app registration and its
client secret), issuing or
revoking an agent key, and pasting a Cloudflare token are the person's own acts.
`gmail_setup_status` says what the Gmail setup lacks and the exact values the owner copies into
Google Cloud; `check_gmail_setup` checks the saved client with Google and names what to fix.
`gmail_connect_link` gives the address they open to connect Gmail. `microsoft_setup_status` and
`check_microsoft_setup` do the same for Outlook (the redirect URI, account types and permissions of
the app registration, the client secret's end date), and `outlook_connect_link` gives the address
they open to connect Outlook; `list_mail_providers` lists the
IMAP presets (servers, the first step at the provider, its help page) and where in the app the
person enters the password — an agent never receives one. When the person asks you to connect an
account, enter an app password or save a provider's setup, call `connect_account`,
`set_account_password` or `set_provider_setup`: each answers the refusal human-step-required with
`data.humanStep` (consent or secret) and `data.url`, the exact place; give the person that link and
say what they do there. `disconnect_account` (two-step)
disconnects a Gmail, IMAP or Outlook account;
`list_agent_keys` lists the keys (no secrets); keys are made in Settings → Agent access and tokens
pasted in Settings → Accounts. On a shared server, `list_members` lists the people: each email, its
role (`admin`: everything; `member`: only its mailboxes) and a member's mailboxes; `open: true` means
nobody is listed and everyone who can sign in is an administrator. Adding or removing a person is
the administrator's act in Settings → People, never an agent's.

## Checking your own work

After a change, read it back (`list_addresses`, `list_domains`, `list_agents` …) and report what is
now true, not what you asked for. `list_agent_activity` shows the journal of changes, yours included.
