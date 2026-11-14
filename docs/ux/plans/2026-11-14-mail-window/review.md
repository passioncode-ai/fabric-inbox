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

Planned: fresh readers over the revised specs (one Claude reader for build readiness and code accuracy together, Kimi
again for the agent and security parts). The build starts when round 2 has no blocking finding.
