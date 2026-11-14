# Review of the mail window specs

Round 1, 2026-11-14, on commit `6000fead` (the first draft). Five independent readers, each given the specs cold:

| Reader | Lens | Findings |
|---|---|---|
| CB (Claude, egm codebase-details) | Every "Today" citation and every target against the code | 21 (4 blocking) |
| IR (Claude, egm implementation-readiness) | Could it be built without a question; contradictions; wave order | 16 (3 blocking) |
| SEC (Claude, security reader) | S03, S04, S08: spoofing, injection, bypasses, cost | 14 (3 blocking) |
| UX (Claude, egm design) | The operator's words, coherence, accessibility, strings | 21 (3 blocking) |
| KIMI (`moonshotai/kimi-k3.1-pro` over OpenRouter, another model family, the agent architect's rule) | The agent parts S03, S06, S07 and the whole | 12 (3 blocking); text in [review/round1-kimi.md](review/round1-kimi.md) |

Every finding was accepted unless a line below says otherwise; "→" names where the revised spec answers it.

## Blocking (16)

| Id | Finding | Disposition |
|---|---|---|
| SEC-1, KIMI-1, UX-1 | A review allowed only to lower a verdict can be talked into an all-clear | → S03 §3, Q2: reason codes only, may raise to amber, may lower only minor sender signals and never to green, never the floors |
| SEC-2, KIMI-2 | Sender authentication trusted a header the sender can write | → S03 §1: only the topmost result by the account's own receiver (the existing `authResults` for Cloudflare); IMAP did not run |
| SEC-3, IR-5, CB-1 | A click handler cannot stop a link: middle click, Enter, right click, views without the script | → S04: the sanitizer removes `href` for amber, red and grey; the script runs everywhere; an index, never a URL |
| UX-2 | Green could never appear while "no antivirus" sat in not-run | → S03 §4 and §5: a fixed scope note, not a not-run line; Q12 |
| UX-3, CB-4 | Agent drafts exist on Gmail, IMAP and Outlook too; the send hook missed most senders | → S07: found by run, content hash for accounts, the outbox `project` step and the account receipt |
| KIMI-7 | Retirement too broad and not recoverable | → S07: only drafts answering the replied-to message or earlier, moved to Discarded, edited ones kept |
| IR-1 | Held-because-unchecked would show red | → S03 §4: grey "Not checked" |
| IR-2, CB-9 | `review.verdict` and a new `verdict` key clash with the release rule and `list_held_messages` | → S03 §1: new key `findings.check`, the `review` column unchanged |
| CB-2 | Only held messages carry a safety record to the UI | → S03 "Data, routes and tools": `safety: {colour, checkedAt}` on every row with a record, a "Not checked" state, check on open |
| CB-3 | The arrival queue has no headers for the new checks | → S03 §1: `ingest` carries the header lines for every account kind |

## Major and minor

| Id | Disposition |
|---|---|
| CB-5 | → S05 Data: `inReplyTo` kept in `fromCloudflare`, `fromRemote`, client types; Outlook fixed |
| CB-6 | → S05, S06: drafts matched by internal id, other rows by `message_id` |
| CB-7 | → S06: found through the incoming row's `draftId`; `runsByIds` returns reason, sources, `sentMessageId` |
| CB-8, KIMI-6 | → S06: the context goes in as a prepared, fenced text; no claim that tools read a run; held messages not quoted. Not taken: a separate scoped capability for the panel's agent (KIMI-6), since the panel's agent already runs with the person's own read scope and nothing new is given to it |
| CB-10 | → S03 §2 and Vendoring: the signature reader written here and offered to Okolos; `feed` and `hash` passed as not run; the bare-import rewrite rule; one pin for all packages |
| CB-11 | → S02: `read_message` already has the fields; strings, not an `Address` type |
| CB-12, KIMI-10 | → S02: "Your address is not in To or Cc", only without `List-Id` and catch-all |
| CB-13 | → S09: `leftOut` on the draft, sanitizer and `contentKey`, the refusal test rewritten, the string retired |
| CB-14, IR-11 | → S08: text quotes only; no shortcut added; text bodies read `document.getSelection()` |
| CB-15 | → S08: the existing quote builder reused |
| CB-16 | → S01: `--pc-radius-control`, Kumo `Tooltip`, the test rewritten |
| CB-17, IR-16 | → S01: `readAll` returns `full`; "N+"; the selection count kept; `.fi-segmented` reused; shown only in the inbox without search |
| CB-18 | → S03: the route in the safety scope routes |
| CB-19, IR-15 | → S10: every place named; the switch on an untried rule opens the Test run step; Cancel is `runs/:id/dismiss`; states and Russian |
| CB-20, IR-13 | → S11: preload, main and the optional method detected on its own; the path passed to `fabric:show-server`; the console stop said first |
| CB-21 | → citations corrected in S02, S05, S08; review.md written |
| IR-3 | → S03 §1 (headers) and §4 ("Not checked") |
| IR-4 | → S03: the route, its tool and scope; the Okolos repo and the pin; README says no schema step |
| IR-6 | → S03 §4: one colour table for messages and files, used by S04 and S09 |
| IR-7, KIMI-9 | → README waves: S09 moves to W3 after S03; W1 and W2 render no badge |
| IR-8 | → S02, S05: one full block for the open cell, a compact line with the address for the others; a header click opens the message |
| IR-9, KIMI-8 | → S07: a new `outcome` field; `answeredByPerson` only for a person's answer; which sends count; Discarded, not deleted; opening without a change saves nothing |
| IR-10 | → S05: events from a separate route and tool (`textKey`), the thread route unchanged; S06: a sent row finds its run by `sentMessageId` |
| IR-12 | → S09: `leftOut`, old drafts default empty; the person's own file when there is no room |
| IR-14 | → S06: autosave timing, save states, the run-less card, Discard's outcome, the full Russian |
| SEC-4, KIMI-5 | → S04, S08: the frame is attacker-controlled; an index resolved by the parent, a scheme allowlist, user activation |
| SEC-5, KIMI-4 | → S03 §4, S04, Q14: grey asks; a no-record message is checked on open; stale link checks recomputed |
| SEC-6 | → S03 §2: one entry per attachment; the union of risky kinds; web pages amber; archives "contents not checked" |
| SEC-7 | → S03 §2: 4 KiB by range; too short is not run; mixed files; a match is never called safe |
| SEC-8 | → S03 §3, Q3: a separate budget, a per-domain cap, document conversion counted, a spent budget never holds |
| SEC-9 | → S03 §3: reason codes and quotes only; no model sentence shown |
| SEC-10 | → S03 §5, S04: punycode, registrable part, bidi and zero-width removed; every From address; "Okolos never draws inside the message" |
| SEC-11 | → S03 §4: link checks recomputed on open when the feed is newer |
| SEC-12 | → S03 §5: octet-stream, `nosniff`, sandbox CSP, `override=1` logged; quarantine checked |
| SEC-13 | → S08: visible text only, zero-width and bidi removed, the quote editable |
| SEC-14 | → S08: re-checks, reload clears, escaping test; S03 §4: green defined as all six checks run |
| KIMI-3 | → Q12, S03 §5: no antivirus claimed; badge words say what was checked |
| KIMI-11 | → S11: All visible everywhere, disabled with a reason where a section takes one server |
| KIMI-12 | Not taken as a model change: rules are kept per account, and a Cloudflare address is its own account here, so "Rules for this address" names the stored scope; provider accounts read "Rules for this account" (S10) |
| UX-4 | → Q4, S03 §5: the Okolos mark and name, a link behind a flag |
| UX-5, UX-6 | → S04: no `href` to open from any menu; an inline alert, focus and Escape; "Don't open"; Q13 |
| UX-7, UX-8 | → S05: a disclosure in place and "Go to message"; replies to an earlier cell indented |
| UX-9 | → S06: the card in view on open, a long message clamped, "Draft waiting" on the row, the AgentRunPanel replaced while a draft waits |
| UX-10 | → S07, Q7 |
| UX-11 | → S08: the hint always on Reply; the button placed from the selection's rectangle |
| UX-12 | → S09 step 0: walk today's forward and send and record the defects before building |
| UX-13 | → S11: Settings open on the mail's choice; what a switch does said first |
| UX-14 | → S01, S11: a navigation with `aria-current` and arrow keys; one control per choice; state as text and icon |
| UX-15 | → S10: "Test run" in English after `terminology.md` changes; «Пробный запуск» kept; "Rules for this account" on provider accounts |
| UX-16 | → S03 §4: two amber labels in both languages; "Report spam" («Это спам»); the badge a button with `aria-expanded` |
| UX-17 | → S03: grey "Not checked", Check now inside the panel; SCN-088 refined, no new row |
| UX-18 | → S02: subject first recorded as D-S02-1 below; "you" and the receiving address merged |
| UX-19 | → S06: sources always visible; "version 3"; a Words table |
| UX-20 | → S09: «Прикрепляем файлы…», singular forms through `t.plural`; chips carry a word |
| UX-21 | SCN-016 changes with S10. The brand pack's `ru.md` dash guidance is B-265's (filed there, not in this work) |

## Decisions recorded during the review

- **D-S02-1:** the subject leads the header; the operator listed it after the recipients, but it names the
  conversation and the badge sits on its line. Open to the operator's word.

## Round 2

On commit `f17a0901`. Two fresh readers: R2 (Claude, task-pipeline verifier: build readiness, code, consistency,
security) and KIMI again ([review/round2-kimi.md](review/round2-kimi.md)). 23 findings, 5 blocking; all applied.

| Id | Severity | Disposition |
|---|---|---|
| R2-1, KIMI-14 | blocking | → S03 §3: held mail keeps today's `reviewHeld` and release rule unchanged; the reason-code review is a separate call for mail that is not held, versioned under `findings.check.review`, and never changes a safety state; the light model's YES alone is amber, not a floor (§4) |
| KIMI-13 | blocking | → S03 §3 and §4: one pure `colourOf`; the review runs on any fired check, so raising is reachable; green means the deterministic checks; a lowered minor sender signal is grey "Reviewed: probably fine" |
| KIMI-18 | blocking | → S06: every variable field inside the fence, fixed words ours; a tuning conversation (`mode=tune`) has no move, mark or discard tool |
| KIMI-19 | blocking | → S06: Send flushes and sends the saved revision; disabled while saving, failed or conflicted; S07: retirement checks the revision in the same transaction; a card send is the reply, not a retirement |
| R2-2 | major | → S03 §1: only the topmost header counts; Gmail also needs Google's topmost `Received`; Outlook not counted in this version (a row to study it) |
| R2-3 | major | → S03 §1: `IncomingEvent` headers; Gmail header list, Graph `internetMessageHeaders`, IMAP header fetch; the `MailMessage` adapter |
| R2-4 | major | → S04: links ask only when the link check cannot vouch for them; IMAP mail with clean links opens; sent mail and drafts not checked (S03 §4) |
| R2-5 | major | → S06, S07: account runs by `runIdFor`, drafts through `getDraftReceipt(...).providerDraftId` |
| R2-6 | major | → S06, S07: `approved_by_person` for an unedited send, `answered_by_person` for an edited one |
| KIMI-15 | major | → S03 §3: every attacker string fenced; strict output validation; quotes kept only on an exact match |
| KIMI-16 | major | → S03 §4: a record older than the feed is grey before render, its links stripped, restored only after a successful recomputation |
| KIMI-17 | major | → S03 §2: macros from the ZIP central directory, never inferred from the first bytes; unreadable is "macros not checked" |
| KIMI-20 | major | → S07: the hash of the provider's read-back in a canonical form; no hash or not comparable keeps the draft |
| KIMI-21 | major | → S07: replies sent elsewhere caught at Sent sync by In-Reply-To or References; no subject guesses |
| KIMI-22 | major | → S03: pinned to Okolos `aa5dc1dd` in this change; a later pin is its own reviewed change |
| R2-7 | minor | → S08 owns running the frame script everywhere; S04 extends it |
| R2-8 | minor | → S01: the reader keeps `full`; which count each segment shows |
| R2-9 | minor | → S04: the three "why" strings in both languages |
| R2-10 | minor | → S02, S05: one compact form; subject and the open cell's badge in the reader's heading |
| R2-11 | minor | → S03 §2: `url` for an attachment; the `MailMessage` adapter |
| R2-12 | minor | → S09: a red original goes into `leftOut` |
| R2-13 | minor | → S11: what S01 brings to Settings; the warning on choosing a segment |

## Round 3

On commit `48550dac`, for S03, S04, S06, S07. A fresh Claude verifier (R3) and Kimi
([review/round3-kimi.md](review/round3-kimi.md); its answer was cut at the token limit after two findings). 17
findings, 3 blocking; all applied.

| Id | Severity | Disposition |
|---|---|---|
| R3-1 | blocking | → S04: every surviving `href` resolved with `new URL()` and kept only when in the record's per-link list; fixtures for `https:\\host`, `https:host`, a split URL |
| R3-2 | blocking | → S06: a tuning session is its own agent instance `<mailboxId>:tune:<runId>`, tools decided by the name on the server; the ordinary conversation never holds the fenced block |
| KIMI-23 | blocking | → S03 §3: the held review's release guard also blocks a disguised file; new checks colour, never hold; a release never changes the colour |
| R3-3 | major | → S06: `ticket-outcome.ts` and `quality.ts` read `outcome.kind`; `approved_by_person` counts as answered |
| R3-4 | major | → S06, S07: account drafts copied into the server's Discarded store before the provider delete; `draftHash` as their expected revision |
| R3-5 | major | → S06: a save that finds its draft retired restores it with the card's text; leaving the field saves only on a change |
| R3-6 | major | → S03 §4: rows for "Reviewed: probably fine", for something fired with no review, for `critical` that is not a floor; green defined without the review |
| R3-7 | major | → S03: Okolos writes `replyPath` and display-name signals as `major`; the lowering path names those two signals |
| R3-8 | major | → S03 §2: range reads on R2 and IMAP; whole reads up to 10 MiB on Gmail and Graph |
| R3-9 | major | → S03 §4: an unread document puts `hidden` and `attachments` in not-run |
| R3-10 | major | → S03 §4: sent mail and drafts with forwarded content get the links check on open |
| KIMI-24 | major | → S07: `draftHash` over every editable field |
| R3-11 | minor | → S03 `feedVersion`; S04's stale rule corrected |
| R3-12 | minor | → S03: where the DMARC policy is read per receiver; no policy found is amber |
| R3-13 | minor | → S03 §5: the badge set apart from a subject written to imitate it |
| R3-14 | minor | → S07: which kind each sender gives and which wins |
| R3-15 | minor | → README Q2 and Q3 brought in line |

## Round 4

On the round 3 revision (`3f681ff9`, on `main` since `9b44fda7`), for S03, S04, S06, S07. A fresh Claude verifier (R4)
and Kimi ([review/round4-kimi.md](review/round4-kimi.md)). 17 findings, 4 blocking; all applied. Two claims of the
earlier revisions were wrong and are corrected: providers' drafts do have a revision (`draftRevision`, 409
`draft_conflict`), and every account kind has a Discarded place; both make S07 simpler.

| Id | Severity | Disposition |
|---|---|---|
| R4-1, KIMI-26 | blocking | → S03 §3, README Q2: the review only raises; `likely_benign_sender_mismatch` and "Reviewed: probably fine" are gone; a brand named on another domain (`brandMismatch`, `critical`) is a red floor |
| KIMI-25 | blocking | → S03 §3: a program or disguised file found by its bytes holds the message from agents (`suspect()`) |
| KIMI-29 | blocking | → S06, S07: the provider's own `draftRevision` for saves and sends; `agentDraftRevision` on the run, written once, decides untouched |
| R4-2, KIMI-27 | major | → S03 §4, S04: lookalike From and links are red floors; S04's table moves them to the red row |
| R4-3, KIMI-28 | major | → S03 §4, S04: sent mail and drafts get the links check on open and are guarded like received mail |
| R4-4 | major | → S04: links stored in canonical `new URL(decoded).href` in `findings.check.links`, sent with the record before the body renders; `mailto:` by scheme; `linkDecision` takes the current feed version |
| R4-5 | major | → S04 acceptance: grey split into links clean (kept) and links not complete (removed) |
| R4-6 | major | → S06, S07: revisions as above; the move to Discarded re-reads the revision and is refused on a mismatch |
| R4-7 | major | → S07: retirement moves to the account's own Discarded with the existing sweep, restore action and tool; no new store |
| R4-8 | major | → S06: the tuning name split on the last `:tune:`, the run checked against the mailbox, the conversation deleted on close or after 24 hours, the button hidden for members |
| KIMI-30 | major | → S06: the first change is saved at once, so it is the person's before any retirement; text kept on the device until acknowledged |
| KIMI-31 | major | → S07: the provider revision changes with any save, attachments included; no hash of names and sizes |
| R4-9 | minor | → S07: one reading rule (`outcome.kind` first); MCP and in-app sends are `answered_by_agent`; Sent sync is `answered_by_person` unless the run sent it |
| R4-10 | minor | → S03: `checkSenderIdentity` called once per From address |

## Round 5

Planned on this revision for S03, S04, S06, S07: a fresh Claude verifier and Kimi. The finish line for a spec is two
consecutive rounds with no blocking finding; W2's S06 and S07 and W3 build after it.
