---
report:
  id: fabric-inbox/2026-11-14-mail-window-audit
  title: "Audit of the mail window after the mail-window plan (S01 to S11) landed"
  kind: audit
  project: fabric-inbox
  domains: [mail, safety, agents, compose, automation, settings, i18n, a11y]
  as_of: 2026-11-14
  status: active
  valid_until: 2026-12-14
  summary: >-
    A WebKit walk of every surface of S01 to S11 on main f24dcd09 (A-1 and A-5 rechecked on c39131d0) (1400x900 and 900x700, English and
    Russian, light theme) and a code read of the scenarios they touch. 33 findings: 2 blocking (a
    dangerous file is forwarded by default; the safety panel opens beside the subject and pushes the
    header and the message out of view), 10 major, 21 minor. Read-only for product code: the fixes are
    proposed with file:line, not made.
---

# The mail window after S01 to S11, 2026-11-14

**Question.** After the mail-window plan landed (`docs/ux/plans/2026-11-14-mail-window/`, S01 to S11,
pull requests #561 to #565, `main` at `f24dcd09`; the S06 and S07 round-2 fixes of #566 and the board rows of #567 and #568 merged in and A-1 and A-5 walked again on `c39131d0`, unchanged), does each surface do what its spec, its "Decisions
after round 6" and its "Built as" notes say, and what the operator asked for?

**Method.**

- The preview fixture (`scripts/preview-fixture.mjs`) gained the data the surfaces need (this unit's
  only change besides this report): a safety record for every badge colour (checked, partly checked,
  not checked, sender may be forged, suspicious, released by the review, dangerous, held), HTML bodies
  with a phishing link, a lookalike link, a link whose text names another domain, a clean link and a
  `mailto:`; a message with five files of real sizes (one red by its bytes, two amber, two green); a
  sent message with Bcc; a Gmail List-Id; two threads with reply agents' drafts (two waiting cards,
  and an answered thread with an edited draft); the card's save, conflict, failure and "gone" answers
  (`GET /api/__fixture/set?draftPut=...`), send, discard, tuning, a rule test run, and Settings' lists.
  Names are neutral (`*.example`, Acme).
- WebKit (Playwright) against `npm run dev` behind the fixture on port 5175, with a fake desktop bridge
  for 1, 2, 3 and 5 servers. Every step at 1400x900 and 900x700, `en-US` and `ru-RU`, light theme.
  Console errors and failed requests were collected; the only ones left are fixture gaps
  (`/api/me`, `/api/categories`, Gmail thread reads), not product errors.
- Each visible text was checked for U+2014: none in the product's text (the only hits were the
  fixture's own message bodies).
- The scenarios the specs name were read against the code (table at the end).

**Not walked:** the "Which server?" dialog when adding under All (S11), Release and Keep held on a held
message, "Make a draft of it again" after a retirement (the button shows; its click was not taken),
the desktop quarantine flag on a download (S03), Gmail, IMAP and Outlook account drafts (not built,
S06 and S07 "Built as").

## Findings

Severity: **blocking**, the operator's ask not met or broken; **major**, wrong or confusing;
**minor**, polish. Screenshots are in [shots/](shots/).

| Id | Surface | Severity | What was seen | Evidence | Suggested fix |
|---|---|---|---|---|---|
| A-1 | S09 forward, S03 file colour | blocking | Forward attaches every original file, the one the check found dangerous included (`invoice.pdf`, a program under a PDF's name), with no safety chip on any file and no "Not attached: the safety check found this file dangerous". | [s09-forward-files-1400-en.png](shots/s09-forward-files-1400-en.png); `app/routes/unified-inbox.tsx:1017-1023` builds `forwardSource.files` from `m.attachments` and never sets `safety`, so `forward-files.ts:63` never sees a red file (S09 "Built as" left this to S03, which did not add it). | At `unified-inbox.tsx:1022` map each file to `{ ...a, safety: safetyFiles.get(a.id)?.colour ?? "grey" }`; a test that a red original lands in `leftOut` as `dangerous`. |
| A-2 | S03 badge panel | blocking | Opening the badge puts the panel inside the subject line, beside the subject: the subject is squeezed into a narrow column (two or three words a line at 900 px) and From, To and the message move below the fold until the panel is closed. The spec has it open under the header. | [s03-partly-1400-en.png](shots/s03-partly-1400-en.png); `app/components/inbox/SafetyBadge.tsx:55` renders the panel inside `.fi-okolos`, which sits in `.fi-subject-line` (`unified-inbox.tsx:1777`, `app/styles/workbench.css:2486-2531`). | Render the panel as a sibling after `MessageHeader` (full width of the header), keep only the badge in the subject line; or lift `open` state to the reader and place the section under `.fi-message-people`. |
| A-3 | S04 link notice | major | Escape on the notice also runs the list's Escape shortcut: the open message closes and the reader goes back to its empty state. The spec: Escape is "Don't open" and focus returns to the frame. | [s04-after-escape-1400-en.png](shots/s04-after-escape-1400-en.png); `app/components/EmailIframe.tsx:381` calls `preventDefault` only; `unified-inbox.tsx:870-886` (`clear`) closes the message on any Escape that reaches `window`. | `e.stopPropagation()` in the notice's `onKeyDown`, or have the list handler ignore events whose target is inside `.fi-link-notice` (and `.fi-okolos-panel`). |
| A-4 | S01 server switch | major | Arrow Down on a segment (and arrows in the open menu) also runs the list's next-message shortcut: the first message opens and focus leaves the switch. | [s01-arrowdown-900-en.png](shots/s01-arrowdown-900-en.png); `app/components/ServerSwitch.tsx:103-110` and `:145-150` handle the arrows without `stopPropagation`; `unified-inbox.tsx:870-886` maps ArrowDown and ArrowUp to `next` and `previous`. | Stop propagation for every key the switch handles, or skip the list keys when the target is inside `.fi-server-switch`. Same check for Settings' switch. |
| A-5 | S06 Discard draft, S07 notice | major | After "Discard draft" the card turns into "A reply was sent; this draft is no longer needed" with "Keep as my draft". No reply was sent. | [s06-discarded-1400-en.png](shots/s06-discarded-1400-en.png); `app/components/inbox/draft-card.ts:106-109` (`retiredCards`, round 2) treats any outcome but `approved_by_person` and edited as a retirement, `superseded` included. | Leave out `outcome.kind === "superseded"` there (the run's panel already says "You set the agent's draft aside"); a unit test for discard. |
| A-6 | S06 card in view | major | Opening a thread whose newest message has a waiting draft does not show that message's card. At 900x700 the first card's top is above the pane (its header and sources cut off) and the open message's card is below the fold; at 1400x900 the first card shows but the open message's card is below. The spec: the card's top in view on open. | [s06-thread-900-en.png](shots/s06-thread-900-en.png), [s06-thread-1400-ru.png](shots/s06-thread-1400-ru.png); `ConversationList.tsx:75-79` scrolls the open cell to the top, then the first card in the thread with `block: "nearest"`. | Scroll the card that answers the open row (else the last waiting card) with `block: "start"`, once per thread; a walk at 900 px. |
| A-7 | S06 Tune the agent | major | The prepared message (about 1,000 characters: the fixed words, the agent's settings, the fenced block) waits in the agent panel's one-line input, 39 px tall (content 856 px, `max-h-[100px]`). The person cannot read what they are about to send. | [s06-tune-1400-en.png](shots/s06-tune-1400-en.png); `app/components/AgentPanel.tsx:535`. | When a prepared message is placed, let the input grow (for example up to 50% of the panel) or show the prepared text in a read-only block above the input with "Edit". |
| A-8 | S02 header, sent mail | major | A message we sent shows "Received at hello@example.com · Cloudflare" under its Bcc line. | [s02-sent-bcc-1400-en.png](shots/s02-sent-bcc-1400-en.png); `app/components/inbox/MessageHeader.tsx:58-63` shows the line whenever our address is in no recipient list, sent mail included. | Skip it when `message.sent` (From already names our address), or word it "Sent from". |
| A-9 | S04 notice, `mailto:` on red mail | major | A `mailto:` link on a dangerous message raises a notice whose first line is "This link goes to" with nothing after it. | [s04-red-mailto-1400-en.png](shots/s04-red-mailto-1400-en.png); `EmailIframe.tsx:383` reads the host of the URL, which a `mailto:` has none of. | For `mailto:` show "This link writes to {address}" with the address (punycode domain, emphasised). |
| A-10 | S03 file chips in the reader (SCN-010) | major | The attachment buttons show a file's colour only as a dot: amber, grey and green look alike without colour, and only red has a title. S03: colour is never the only signal. | `unified-inbox.tsx:1126-1131`, `workbench.css:2557-2560`; seen in the `s03-redfiles` walk (chips `is-amber`, `is-green` with no word). | Add the chip's word beside the name ("Suspicious", "Not checked", the same words the composer's `SafetyChip` uses, `Composer.tsx:795`) or at least a `title` and visually hidden text on every chip that is not green. |
| A-11 | S02 and S05 thread cells, S04 their links | major | Only the open cell carries the safety colour. A red or amber message in a thread is not marked until it is opened (S02 asks for a small amber or red mark with its word on the other cells), and every link in another cell asks with "This message was not fully checked", also in a clean thread. | `app/components/inbox/thread.ts:36-55` (rows carry no `safety`); `ConversationList.tsx:287,296` pass no `linkSafety`; recorded as later in S03 and S04 "Built as". | Attach `safety` to thread rows as `workers/routes/inbox.ts:372-378` does for inbox rows, show the mark in the cell header, and pass colour and checked links to `CellBody`. |
| A-12 | Mail list group chips (ru) | major | The "Security" group chip reads «Шифрование» (encryption) in Russian. | [s06-thread-1400-ru.png](shots/s06-thread-1400-ru.png) (chip row); `shared/i18n/ru/connect.ts:216` maps the shared key "Security" for the IMAP connection's security setting. | A context key for the group name (the dictionary's `[context] text` form) translated «Безопасность»; `check-locale` will catch the new key. |
| A-13 | S01 layout choice | minor | At 1400x900 the list column is 349 px, under the 360 px threshold, so the default window always shows the menu; the segments appear only when the list is widened or in the 900 px single-column layout. | `ServerTabs.tsx:6` (`SEGMENTS_MIN_WIDTH = 360`), `workbench.css:385` (`--fi-list-width` 350 px). | Measure the segments' own width and fall back to the menu only when they do not fit, or lower the threshold to the default column. |
| A-14 | S01 menu | minor | The trigger reads "All servers" while the menu's first row reads "All"; in the menu the count sits flush after the name ("Delta 4"). | `s01-5-1400-ru-menu` walk; `ServerSwitch.tsx:72`. | "All servers" in the menu row too; the count right-aligned or after a separator in menu rows. |
| A-15 | S06 list row | minor | A thread with a waiting draft shows two chips that say the same: "Draft waiting" beside the sender and "Agent's draft" below. | [s06-thread-1400-ru.png](shots/s06-thread-1400-ru.png); `app/components/inbox/TriagedList.tsx:100` and `:119`. | Hide the status chip when `draftWaits(message.agentRun)`. |
| A-16 | S05 nesting with a card | minor | A reply is indented with "In reply to Ana Ruiz" although the message it answers is the cell right above it; only the agent's draft card sits between them. | [s06-thread-1400-ru.png](shots/s06-thread-1400-ru.png); `ConversationList.tsx:117-124` counts the draft row the card replaced (`placement.taken`) as the cell above. | Compute `isNested` against the previous row that is drawn as a cell. |
| A-17 | S03 panel lines | minor | A line that fired is told apart from a clean line by bold weight only. | `workbench.css:2543`. | A warning icon on fired lines and a check on clean ones (both `aria-hidden`, the words already carry the meaning). |
| A-18 | S03 released badge | minor | "Released by the review" sits in the badge with no separator: "Suspicious message Released by the review". | `SafetyBadge.tsx:50` and the `s03-released` walk. | A " · " separator, or the release note under the badge. |
| A-19 | S04 focus after the notice | minor | After "Don't open" or Escape focus lands on the page body, not the message frame. | `EmailIframe.tsx:326` focuses the iframe while the notice unmounts; WebKit leaves focus on `body`. | Focus the frame after the notice has unmounted (`requestAnimationFrame`), or focus the reader pane. |
| A-20 | S04 guarded links | minor | Links that ask first look exactly like live links (blue, pointer). | `EmailIframe.tsx:94-97`. | A dotted underline and a `title` such as "Asks before it opens". |
| A-21 | S04 before the record arrives | minor | The body renders first with every link guarded as grey; under grey a `mailto:` keeps its address, so on a dangerous message a `mailto:` is live until the record arrives (seen once at 900 px: `href` still `mailto:` after 2.6 s). | `app/lib/link-guard.ts:26-31`; S04 "Built as" (the body does not wait). | Guard `mailto:` while the record is pending, as on red. |
| A-22 | S02 date | minor | Pointing at the date shows the same absolute date; S02 asks for the relative time on pointing. | `MessageHeader.tsx:68`. | `title` with a relative time ("3 hours ago") through `Intl.RelativeTimeFormat`. |
| A-23 | S03 badge on sent mail | minor | Mail we sent shows a grey "Not checked" badge when it has no links record (old mail, or the open-time check failed); S03 shows a badge on sent mail only when a link fired. | [s02-sent-bcc-1400-en.png](shots/s02-sent-bcc-1400-en.png); `unified-inbox.tsx:1776` hides it only for a record with `scope: "links"` and no signals. | Hide the badge on sent mail and drafts unless a link signal fired. |
| A-24 | S08 Reply with quote | minor | The floating "Reply with quote" button sits on the line under the selection and covers the message's text there. | [s08-selection-1400-en.png](shots/s08-selection-1400-en.png); `unified-inbox.tsx:1813`, `workbench.css:596`. | Place it above the selection's first line, or at its right end, clamped into the pane. |
| A-25 | S05 folded quote | minor | "Show quoted text" in a cell looks like plain grey text (no control look) and leaves blank space under it. | [s08-selection-1400-en.png](shots/s08-selection-1400-en.png) (upper cell); `app/components/inbox/quotes.ts` (`foldQuotedHtml`). | Style the summary as a link-button with a disclosure mark; recompute the frame's height after folding. |
| A-26 | S06 agent naming | minor | The card names the agent ("Support desk"); the sent cell and the run panel name it by id ("Sent by support", "Agent's draft · support v2"). | `ConversationList.tsx:266-267`, `AgentRunPanel.tsx:66`. | Read the name as the card does (`GET /api/agents/:id`, cached), fall back to the id. |
| A-27 | S06 Russian word | minor | The card's "Discard draft" reads «Удалить черновик»; S06's word table says «Выбросить черновик». The key is shared with the composer. | [s06-thread-1400-ru.png](shots/s06-thread-1400-ru.png); `shared/i18n/ru/compose.ts:80`. | Keep «Удалить черновик» (it deletes, R6-2) and correct the spec's table, or give the card its own key. |
| A-28 | S10 test run | minor | The result runs two sentences together: "Would not act: the sender is not billing@acme.example Nothing was changed." (and in Russian). | `app/lib/rule-sentence.ts:145`, `app/routes/automation.tsx:664`. | End "Would not act: {reason}" with a full stop in both locales. |
| A-29 | S10 tabs | minor | The Rules, History and Sending tabs have `role="tab"` with no tab panels, no `aria-controls` and no arrow keys; the waiting count is a `span` with an `aria-label`. | `automation.tsx:221-232`. | Either plain buttons with `aria-pressed`, or the full tabs pattern; the count as visible text with a visually hidden label. |
| A-30 | S11 Russian wording | minor | Settings say the same states in other words than the switch: the segment «Beta · Войти» and the group's button «Вход»; the group's «Сейчас не отвечает» and S01's «Сейчас недоступен». | `s11-accounts-3-900-ru` walk; `app/components/settings/servers.tsx:156-167`. | One word per state across the switch and the groups. |
| A-31 | S09 file sizes | minor | The forward composer shows sizes in bytes ("4,718,592 bytes") while the reader shows KB. | [s09-forward-files-1400-en.png](shots/s09-forward-files-1400-en.png); the file rows in `Composer.tsx`. | One size format (KB or MB) in both. |
| A-32 | S01 cut names | minor | A server name cut at 160 px shows its full name in a native `title`; S01 names Kumo's `Tooltip`. | `ServerSwitch.tsx:80-81`. | Kumo's `Tooltip`, as `Header.tsx` uses it, or record the deviation. |
| A-33 | S11 Accounts under All | minor | At 1400 px the search field beside "Connect account" is cut to "Find an accour". | `s11-accounts-3-1400-en` walk; `app/components/settings/sections/AccountsSection.tsx`. | Let the search field take the row's width and the button wrap below it in a narrow column. |

**Counts:** 2 blocking, 10 major, 21 minor (33).

## What works as specified

- **S01:** segments below five servers with a list column of 360 px or more, the menu otherwise; 28 px
  in every state; "50+" from a full read and "54+" on All; "<name> · Sign in" and "<name> · Retry" with
  their icons; `aria-current="page"`; the arrows move focus (A-4 aside); "All groups".
- **S02:** From with its address, To with "you" and the provider, Cc, Bcc on sent mail only, "Reply to"
  only when it differs, "and 2 more" opening in place, "Your address is not in To or Cc" when no List-Id
  (and not for the list message), both locales.
- **S03:** every badge colour and word in both locales; `aria-expanded`; checked lines, files, what did
  not run, the review's codes and quote, first steps, the Okolos lines; a red file's download only from
  "Save anyway".
- **S04:** a red message's links (click, middle click, Enter) raise the notice and open nothing, with
  "Copy address"; amber and grey ask with "Open anyway"; a green message's link opens directly; the
  link text versus host notice; focus moves to the notice.
- **S05:** oldest first, the compact "address → recipient, +N" line, nested reply with "In reply to"
  (`aria-expanded`), "Go to message" focusing the answered cell, the folded quote, the rule and safety
  event rows.
- **S06:** the card under the message it answers, "Draft by Support desk, version 3", why it waits,
  "Answered from" with links, "How it was made", the first change saved at once ("Saved"), "Not saved"
  with Retry and Send disabled, the conflict with "Use mine", the "gone" state with "Keep as my draft",
  Discard hidden once edited, the tuning session with no tools and the fenced block (A-7 aside).
- **S07:** sending one card retires the earlier untouched sibling with the notice; an edited draft is
  one quiet line with "Open Drafts"; the run's panel offers "Make a draft of it again".
- **S08:** the hint on Reply and Reply all; a selection in an HTML frame and in a text body becomes the
  quote header and `>` lines.
- **S09:** the original's files attach on open, greedy while they fit (the 1.2 MB file did not fit
  after the 4.5 MB archive), Remove leaves a file out on purpose with Attach to put it back, Send stays
  allowed.
- **S10:** one name, sentence cards, Paused, History with its waiting count and Approve or Cancel, the
  four-step editor, Turn on locked until a test run of the current values.
- **S11:** "Settings · All servers" with the switch, groups per server with counts and states, All
  disabled with its reason on one-server sections, the console warning before switching servers.

## Code against the scenarios

| Scenario step | Spec | Code | Status |
|---|---|---|---|
| SCN-099 step 1: the switch in the list heading | S01 | `app/components/inbox/ServerTabs.tsx:35-69`, `app/components/ServerSwitch.tsx:62-90` | Done; A-4, A-13, A-14 |
| SCN-099 step 6: Settings name their server, All grouped | S11 | `app/components/settings/servers.tsx:39-133` | Done; A-30, A-33 |
| SCN-004 refinement: who wrote, to whom | S02 | `app/components/inbox/MessageHeader.tsx`, `message-header.ts:68-80` | Done; A-8, A-22 |
| SCN-008: thread top to bottom, nesting, folded quotes, events | S05 | `ConversationList.tsx:111-170`, `quotes.ts:160-196` | Done; A-11, A-16, A-25 |
| SCN-008 step 3: reply with the selection | S08 | `EmailIframe.tsx:202-217`, `unified-inbox.tsx:1812-1830` | Done; A-24 |
| SCN-009 step 3: forward takes the files, each removable | S09 | `Composer.tsx:302-370`, `forward-files.ts:40-130` | Partly: red files are not left out, no chips (A-1); reopened forward: B-277 |
| SCN-010 refinement: files by what they are | S03 | `unified-inbox.tsx:1032-1043` (download), `:1126-1131` (chips) | Partly: chips by colour only (A-10) |
| SCN-088 refinement: the check shown, links guarded | S03, S04 | `SafetyBadge.tsx`, `EmailIframe.tsx:182-201, 357-400`, `shared/mail/safety.ts` (`colourOf`) | Done; A-2, A-3, A-9, A-17 to A-21 |
| SCN-104: check and send the agent's draft in the thread | S06, S07 | `AgentDraftCard.tsx`, `ConversationList.tsx:66-100`, `draft-card.ts` | Done for Cloudflare (accounts: B-278); A-5, A-6, A-7, A-15, A-26 |
| SCN-013 refinement: tune the agent | S06 | `AgentDraftCard.tsx:160-175`, `AgentPanel.tsx:535` | Done; A-7 |
| SCN-014, 015, 016: test-run, turn on, history | S10 | `app/routes/automation.tsx:185-700`, `app/lib/rule-sentence.ts` | Done; A-28, A-29 |

## Next

The two blocking findings (A-1, A-2) and the major ones are the fix waves' first rows; each fix lands
with its test and a walk on this fixture (`FIXTURE_PORT=5175 PREVIEW_ACTIONS=1 node
scripts/preview-fixture.mjs` behind `npm run dev -- --port 5174`).

## Fixed in wave F3

| Finding | Fixed in | How |
|---|---|---|
| A-12 | fb9b7a66 | The group label "Security" is «Безопасность» (`shared/i18n/ru/server.ts`); the IMAP form's setting uses its own key `[connection] Security` → «Шифрование» (`ImapAccount.tsx`). Test: `tests/i18n-context-words.test.ts`. |
| A-28 | fb9b7a66 | "Would not act: {reason}." ends with a full stop in both languages (`app/lib/rule-sentence.ts`). Test: `tests/rule-sentence.test.ts`. |
| A-29 | fb9b7a66 | The full tabs pattern: roving tabindex, Left/Right wrapping, Home/End (`app/lib/tab-keys.ts`), one `tabpanel` with `aria-labelledby` the chosen tab, `aria-controls` on each tab; the waiting count is visible text with a visually hidden sentence. Tests: `tests/tab-keys.test.ts`, `tests/automation-ui.test.ts`. |
| A-30 | fb9b7a66 | One word per state: a signed-out server's button says «Войти» in the groups as in the switch (`[action] Sign in`; «Вход» stays the sign-in window's title), and "Not reachable now" is «Сейчас недоступен» everywhere (S01's words); rows added to `docs/brand/terminology.md`. Test: `tests/settings-server-words.test.ts` renders both in Russian. |
| A-33 | fb9b7a66 | The search field's flex basis is its placeholder's length (`--fi-search-chars`, 1ch a character plus padding and the clear button); with less room the button wraps below and the field takes the row. WebKit walk at 1400 and 900 px, EN and RU: the field is 301 px in the 340 px list column (placeholder needs 123 px), full row below 930 px. |

The same mistake as A-12 elsewhere in the dictionary (one English key, two meanings), found by listing every
one- and two-word key used from more than one place and reading each call site. Outside this wave's files, so
left for a board row:

- `desktop/move.js:65`: the primary button `t('Move')` reads «Перемещение» (a noun, the keyboard shortcuts' group
  heading in `app/lib/mail-keys.ts:90`); the button needs a verb («Перенести»), under its own key. The page's `t()`
  does not strip a `[context]` prefix, so the key needs a plain new English text or the prefix support
  `desktop/i18n.cjs:68` already has.
- `app/routes/gmail-inbox.tsx:521`: the Archive button `t("Archive")` reads «Архив» (the folder); the action key
  `[action] Archive` («Архивировать») exists and fits.
