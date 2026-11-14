# The mail window, the operator's notes of 2026-11-14

- **Source:** the operator's voice notes in this repository's session, 2026-11-14 (quoted per spec, Russian as said).
  The notes stop mid-sentence at the settings' accounts list; what was said is covered (S11), the rest is open (Q11).
- **Route:** `task-pipeline` full flow; `super-ux` scenarios (SCN rows named per spec), `sheleg-design` for the look,
  `copywriting` and the copy check for every string in both locales; the agent architect consulted for S3 and S6
  (`audit.py consult`, 2026-11-14: template `support-answerer`, pattern `untrusted-fence`).
- **Recon:** read on `main` `1f988fc8`; every "Today" line in a spec cites `file:line` at that commit.
- **Status:** specs written, review below, then build in waves (section "Waves").

## The edits and their specs

| # | What the operator asked | Spec | Row |
|---|---|---|---|
| S1 | The server switch above the mail list looks bad: redesign it | [S01](S01-server-switch.md) | B-267 |
| S2 | An open message shows who wrote, to whom, which of our addresses, Cc, Bcc, the subject, then the body and the attachments | [S02](S02-message-header.md) | B-268 |
| S3 | Attachments and links verified by a model with no tools, through Okolos; a badge at the message's top right: "checked, all fine" to open, or a problem with the first steps | [S03](S03-okolos-verdict.md) | B-222 (widened), B-269 |
| S4 | When a problem is found, links do not open on a click: a notice instead | [S04](S04-link-guard.md) | B-270 |
| S5 | A thread reads top to bottom, every message attributed, and each one shows what it answered (folded, opens on a click) | [S05](S05-thread.md) | B-221 |
| S6 | The agent's draft sits right under the message it answers, with where its facts came from; it is editable and sends from there, or opens the agent panel with this message's context to tune the agent | [S06](S06-inline-agent-draft.md) | B-271 (B-224 in part) |
| S7 | When I send a reply myself, the agent's draft goes away; a draft lives only until something is sent | [S07](S07-draft-retires.md) | B-272 |
| S8 | Select text, press Reply: the reply quotes exactly that text | [S08](S08-reply-with-selection.md) | B-273 |
| S9 | Forward attaches the original files by itself; each can be taken off before sending; the forward and send screen works as it should | [S09](S09-forward.md) | B-274 |
| S10 | "Rules for this account" is unclear: make it a normal working screen | [S10](S10-rules-screen.md) | B-275 |
| S11 | Settings' accounts show one server's accounts only, while the mail can show All | [S11](S11-settings-servers.md) | B-276 |

## Questions and the decisions taken

The operator's rule: an open question is a decision, taken by the recorded decisions, the project's goal, then the
safest reversible option, written where the work lives. Each is open to the operator's word; none blocks.

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | What is "Oculus extension"? | Okolos, PassionCode's browser security product (`okolos-extension`); its pure packages `core-mail`, `core-download` and `core-lookalike` run in the Worker. Three Okolos packages are already vendored (`vendor/okolos/`, pinned `5d664c5`) | Same organization and licence; the product said "if possible, our Okolos" |
| Q2 | Which model judges a message, and does it get tools? | No tools, ever. The model already used for the held-message review (`SAFETY_REVIEW_MODEL`, default Workers AI `llama-4-scout`, `workers/categories/store.ts:180-184`), in the owner's own Cloudflare account; its review can lower a verdict, never raise it (`applyReview`, Okolos ADR-0004) | Mail never leaves the owner's account; a model that cannot raise severity cannot be talked into a false alarm or a false all-clear beyond what the checks found |
| Q3 | Does the model run on every message? | Deterministic checks on every message; the model only where a check fired or a document attachment was read, inside the existing daily safety budget | Cost bounded by the budget; a clean message needs no model to be called clean |
| Q4 | What does the badge link to? | It opens a panel in the app listing what ran, what did not and why; no outside link while Okolos has no public page | Okolos is pre-alpha, not published; a link to nothing teaches nothing |
| Q5 | "Если нет автоматизации включенной ... просто уже сразу отправляется": what happens without automation? | The agent's mode decides as today: in "send allowed answers" mode the reply is sent and shows in the thread as sent by the agent; otherwise it is a draft card under the message (S6). No mode is changed by this work | The notes describe the two outcomes; changing an agent's mode is the operator's choice in Settings, not the UI's |
| Q6 | "Открыть консоль" for tuning: the terminal console (B-70) or the agent panel on the right? | The agent panel on the right (AgentDock), opened with the message, the draft and the run's reasons as its context, plus a link to the agent's settings | The notes say "вот этот сбоку ... и там сразу же есть контекст этого письма"; the terminal console takes no message context |
| Q7 | When I answer myself, is the agent's draft deleted or hidden? | Deleted on the server once my reply is accepted, only while the draft is still as the agent wrote it; a draft I edited is mine and stays | "Драфт находится только до того, пока он не отправлен"; deleting a draft someone edited would lose their work |
| Q8 | Reply with no selection: quote everything or nothing? | Nothing, as today (the thread above already shows the history); with a selection, that text only | Keeps today's behaviour where nothing was asked; the notes ask for the selection case |
| Q9 | Forward with more original files than one message may carry (10 files, 5 MiB)? | The files that fit are attached; the rest are listed as left out with the reason, and sending is allowed | Today a forward with a missing original refuses to send (`compose-payload.ts:42-45`), so a large forward cannot go at all |
| Q10 | Settings with several servers: merged, or one server at a time? | One server at a time for changes, with the server's name in the header and a switch to the others; the lists (accounts, addresses, domains) read every server and group them by name, each item opening its own server's settings | A change always belongs to one server (SCN-099: nothing is copied between servers); reading them together answers "why do I see only one account" |
| Q11 | The rest of the notes after "в e-mail я могу поставить все, то есть" | Not heard; S11 covers what was said. Asked again in the hand-back, not blocking | The message was cut off |

## Waves

| Wave | Specs | Why this order |
|---|---|---|
| W1 | S1, S2, S10, S11 | Interface only, no new data on the server; S2 is the base S3 and S5 stand on |
| W2 | S5, S6, S7, S8, S9 | The thread and the reply path; S6 and S7 change the server's draft handling |
| W3 | S3, S4 | The verdict needs vendored packages, a schema step and the model; S4 reads S3's verdict |
| W4 | Audit of the whole window (`/ux-audit`, a walk in WebKit), fixes in waves, release, the three servers | The operator's order: specs, review, build, then audit and release |

Each wave lands as its own pull request with its tests, the MCP tools for a new route (`workers/mcp/tools.ts`,
`npm run mcp:docs`), Russian strings in `shared/i18n/ru/` with copy-check report ids, and its SCN lines.

## Review

Recorded in [review.md](review.md): independent readers per spec, their findings and what changed.
