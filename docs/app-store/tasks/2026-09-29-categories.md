# Categories and screening — 2026-09-29

Request (paraphrased): check how agents work and find their bugs; work out
how the main feed is formed and how to set agents on the messages that matter — from chosen or all
mailboxes, show only what the operator's settings say is worth showing; such filters are categories
selectable by projects, accounts and domains, and custom ones such as "refund requests" or "Acme
support"; fix what is broken; check the interface three times as carefully.

## What the check found (live, owner's server, 2026-09-29)

- The feed held 27 messages over 36 addresses (Gmail is not connected); 14 were "People →
  Important" and every one of them was a routing test sent from one of the owner's addresses — mail from
  one of the server's own domains is triaged as a person's unread mail.
- The agents' history held 27 `off` runs of 30: every message to an address with no agent writes a
  run, so "Recent answers" is mostly noise.
- There is no way to say "show me refund requests from any inbox" or "Acme support": rules are per
  account and act; triage groups are fixed.
- Code audits of the agent pipeline and of the feed: findings and their fixes are listed under
  **Audit** below as they are verified.

## Decisions (operator, 2026-09-29)

| Question | Answer |
|---|---|
| How a message enters a custom category | **Scope + a description in words**: the model reads each new message in scope and decides with a reason; plain conditions (sender, words) work without a model |
| Mail that arrived before a category existed | **Classify the last 200 messages in scope** on create, with progress and a cost cap; new mail after that |
| Categories and the Focus feed | **Beside it, with "Raise to Important"**: a category is its own view in the sidebar with a count; ticked, its messages also rise to Important in Focus with the reason |
| What a "project" is in a scope | **A named set of domains and addresses**, defined once and reused by categories |

## Requirements (frozen; adding is free)

| REQ | Requirement | Verified by |
|---|---|---|
| CAT-1 | Projects: name + domains + addresses; create, edit, delete (refused while a category uses it) | route tests |
| CAT-2 | Categories: name, scope (all, accounts, domains, projects), optional conditions (senders or sender domains, words in subject, words in text), optional description for the model, Raise to Important; a changed definition starts over | route tests |
| CAT-3 | Every new message of both providers is classified once for every category in scope: conditions first, one model call per message for all described categories in scope, a verdict with its reason; bounded daily model budget; failures retried, never silently dropped | store tests in workerd, a scripted model |
| CAT-4 | On create or change, the last 200 messages in scope are classified in the background, with progress | store tests |
| CAT-5 | Feed: a Categories section in the sidebar with "new" counts; a category view lists its messages with their current state and why each belongs; Focus raises messages of flagged categories with "Category: X"; rows name their categories | inbox tests; installed app |
| CAT-6 | Bugs found by the check and the audits fixed, each with a test | tests named in **Audit** |
| CAT-7 | Docs, scenarios, deploy, a live category run, release | receipts |

## Audit

Two code audits (agent pipeline: 18 findings A1–A18; feed: 20 findings F1–F20) were read against
the code before any fix. Each row names the change and the test that fails without it; "live"
means checked in the installed app over CDP on 2026-09-29 against version `5c0df5de`/`56bc2d69`.
Rows that were only partly closed name the board row that carries the rest.

### Agents

| ID | Finding | Fix | Evidence |
|---|---|---|---|
| A1 | Two agent addresses could answer each other in a loop; mail from our own domains was answered; no `Auto-Submitted` | prefilter skips served domains (`own_domain`); agent sends carry `Auto-Submitted: auto-replied` | `agents-runner`: "mail from one of our own domains is never answered — no loop between two agent addresses" |
| A2 | A mailbox created from Mailboxes silently got a drafting agent | `createMailbox` defaults to `agent: "off"` | `setup`: "a mailbox created without an agent is Off, not silently given a drafting agent" (watched failing with the default removed) |
| A3 | `Reply-To` ignored | the reply goes to Reply-To, checked like the sender | `agents-runner`: "Reply-To is the address answered, and it is checked like the sender; the mailbox signature is added" |
| A4 | Two messages of one thread answered side by side | the drain takes one message per mailbox per pass | `agents-registry`: "two messages to one address are answered one after the other, never side by side (audit A4)" (watched failing with the filter removed). Two agent addresses in To and Cc still answer the same message once each: board B-22 |
| A5 | An error after the claim left the run `running` and the retry did nothing | everything after the claim ends as `failed` or `send_unknown` | `agents-runner`: "a failure after the claim is recorded as failed, never left running" |
| A6 | Runs cut off before the send were never retried | `phase: "sending"` saved before the send; a stale run without it is claimed again | `agents-registry`: "a run cut off before sending is claimed again; one cut off while sending is only reported" |
| A7 | History filled with `off` runs | the agent is resolved before the claim; Off leaves no run | `agents-runner`: "Off and a deleted agent do nothing and leave no run…"; `agents-registry`: "…Off stores mail and does nothing" |
| A8 | Unsent drafts shown to the model as said | the thread excludes draft, trash, spam and later messages; direction by the Sent folder | `agents-runner`: "unsent drafts, trash and later messages are not shown to the model as the conversation" |
| A9 | The signature could expose the agent's name; the mailbox signature was ignored | sign-off rule by the From name; the mailbox signature is appended | same test as A3 |
| A10 | Tool output went to the model unchecked | tool output is scanned by the injection check; a flagged result is withheld and the answer becomes a draft | `agents-runner`: "a tool output that looks like instructions is withheld and the answer becomes a draft" |
| A11 | No-reply variants and calendar mail were answered | broader no-reply forms plus a `noreply` substring check; `text/calendar` and RSVP subjects skipped | `agents-runner`: "calendar mail and no-reply variants are skipped; an empty subject gets a real reply subject" |
| A12 | The forced final turn shared the first call's 90 s timeout | final turn has its own 25 s, the last step may only submit, an abort returns the text | `agents-model`: "a model that keeps calling tools is made to submit on its last step" and the two beside it |
| A13 | "Open the draft" opened the Drafts list | `?open=<id>` on the folder list; survives the route's first load | live: from Agents on a fresh launch the message panel is open within 300 ms. Runs of a deleted address still link to it and the list says it may have been deleted |
| A14 | History had no paging, filter or Retry | `(created_at, id)` cursor, `outcome` and `agent` filters, Show older, Retry | `agents-registry`: "history pages by a cursor that keeps runs sharing a timestamp, and filters by outcome and agent (audit A14)" (watched failing with the id tie-break removed); live: filter visible, "Nothing matches this filter" |
| A15 | Two labels promised more than the code does | "left alone once you have replied to it yourself"; the daily count names its reset in local time (midnight UTC) | live, Agents editor |
| A16 | A 409 lost the edit; Edit replaced an unsaved form | "Load the newest version" on a conflict; Edit is disabled while a form is open | typecheck; live |
| A17 | `Re: ` with an empty subject | `Re: (no subject)` | same test as A11 |
| A18 | A long address broke the legacy migration name | the name is cut to fit the schema | `agents-runner`: "a pre-registry mailbox migrates to its own drafting agent with its old prompt (REQ-P2)" |

### Feed

| ID | Finding | Fix | Evidence |
|---|---|---|---|
| F1 | A phone had no folders and could not pick Gmail | folder select in the phone toolbar; the Gmail row scopes to `provider=gmail` | live at 390 px: the folder select, no horizontal scroll |
| F2 | Group chips did nothing in Newest | the group filter applies to both views | `inbox-ui`: "the rows as shown, the next message after one leaves…" |
| F3 | Role addresses of people filed as automated; `no_reply` missed | only true no-reply forms are automated | `triage`: "people who write from role addresses are people; true no-reply forms are automated (audit F3)" |
| F4 | One email in two inboxes shown twice | dedupe by RFC Message-ID, one row naming both (`+N`) | `inbox`: "the same email in two inboxes is one row naming both… (audit F4)" |
| F5 | Mark read/unread was a no-op after the auto mark-read | the cached detail is updated too | code review of `unified-inbox.tsx`; live |
| F6 | Opening an unread message made its row jump to a closed group | the selected message keeps its section until the selection changes | `inbox-ui` test named above |
| F7 | Archive/Trash cleared the reader | the next message in the shown order is selected | `inbox-ui` test named above. Keeping the scroll position of the hidden list on narrow screens: board B-23 |
| F8 | Cloudflare search reads raw HTML; Gmail searches four fields | not fixed | board B-21 |
| F9 | A group filter could hide everything with no way out | "All" stays while a group is set; "No X mail here. Show all" | `inbox-ui` test named above |
| F10 | Bounces buried or read as a person | bounce rule → Alerts, important while unread | `triage`: "bounces are alerts that need you; calendar mail is a notification (audit F10, F11)" |
| F11 | Calendar and Google Play mail in People/Important | RSVP → notifications; `googleplay-noreply@google.com` → Stores | same test as F10 |
| F12 | Russian mail barely sorted; `сч[её]т` matched inside words | Russian terms with Cyrillic word edges | `triage`: "Russian mail is sorted too, and a Russian word is matched whole (audit F12)" |
| F13 | Our own domains read as people | a "Your addresses" group fed by the served domains | `triage` "(audit F13)"; `inbox`: "own domains reach triage through the read options (audit F13)"; live: 26 routing tests left Important |
| F14 | Fan-out in lock-step groups of 5, a redundant head, every page refetched | a pool of 8, the head removed, only a single loaded page refetches. A batched Gmail call and a date index remain: board B-24 | `inbox` tests; code |
| F15 | A failed inbox could leave a hole or stop paging | `hasMore` stays true while an inbox failed | `inbox`: "…a failed inbox keeps Load older (audit F15-F17)" |
| F16 | Domain scope took Gmail accounts the sidebar did not show | a domain is its Cloudflare addresses | same test as F15 |
| F17 | Unread counts went stale outside the scope | unread counted for every inbox | same test as F15 |
| F18 | Banner uncapped, raw codes, poor empty states | collapsed banner with plain sentences; empty states per case | live |
| F19 | Selection, params and open groups lost too easily | view/group changes keep the selection; open groups kept in sessionStorage | code; live |
| F20 | Rows were toggle buttons; the star had no role; dates lacked time and year | `aria-current`, a hidden "Important." prefix, `role="img"`, time today and year for old mail | `inbox-ui` test named above. Keyboard j/k navigation: board B-25 |

### Found in the installed app while checking (2026-09-29)

- The address list shrank to one row once Categories sat above it: the base `.fi-account-list`
  rule (`min-height: 0`) won by order over the desktop one, so even the old `60px` never applied.
  Fixed by specificity; live: 190 px, the whole sidebar scrolls when short.
- A described category showed its one message inside the closed "Your addresses" group. It now
  reads newest first; live: the refund test message visible with its "Why:" line.
- The Agents history filters were invisible on desktop (the phone-only folder-select class).
- Live category run: "Refund requests", all inboxes, described in words. The backfill sorted 27
  messages with 0 matches (the inbox held only routing tests); a refund request sent between two
  of our addresses was matched in under 15 s with the reason "The sender explicitly asks for a
  refund of a charge after cancelling a paid subscription". Moving it to Trash removed it from the
  view and the count. The 27 test messages of this session were moved to Trash (reversible).
- Known limit: a message restored from Trash does not return to a described category until the
  category changes (the verdict is forgotten when the view finds it gone). Board B-26.
- Not reproduced: once, under CDP mobile emulation, a message opened by itself and the window
  then vanished from the debugger; with width-only emulation and on a fresh launch it never
  happened again. Recorded, not claimed as a product bug.

## Release 0.5.0 (2026-09-29)

| Image | Receipt | sha256 (first 16) |
|---|---|---|
| `Fabric-Inbox-0.5.0.dmg` (public, built from 18ba185; 0 of 63 owner identifiers in `app.asar` by a scan of every domain, address and copy in `deployments/owner/setup.json`; the server bundle carries `fabric-v4`) | notarized, stapled, Gatekeeper accepted | `16a994a058e85590` |
| `Fabric-Inbox-0.5.0-owner.dmg` (installed in /Applications) | notarized, stapled, Gatekeeper accepted (`source=Notarized Developer ID`) | `41ed15e739894f6a` |

Server 0.5.0 deployed (version `c84f70c3`), migration tag `fabric-v4`. The first 0.5.0 public
image (from 45eef95) carried an owner domain in a Knowledge placeholder and was
replaced before any use; see the retro entry and 18ba185. Full hashes are in the receipts beside
the images in `release/`.
