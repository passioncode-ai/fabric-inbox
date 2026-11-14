# The mail window, the operator's notes of 2026-11-14

- **Source:** the operator's voice notes in this repository's session, 2026-11-14 (quoted per spec, Russian as said).
  The notes stop mid-sentence at the settings' accounts list; what was said is covered (S11), the rest is open (Q11).
- **Route:** `task-pipeline` full flow; `super-ux` scenarios (SCN rows named per spec), `sheleg-design` for the look,
  `copywriting` and the copy check for every string in both locales; the agent architect consulted for S3 and S6
  (`audit.py consult`, 2026-11-14: template `support-answerer`, pattern `untrusted-fence`).
- **Recon:** read on `main` `1f988fc8`; every "Today" line in a spec cites `file:line` at that commit.
- **Status:** specs written, review round 1 done and applied ([review.md](review.md)), round 2 next, then build in waves.

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
Revised after review round 1 ([review.md](review.md)).

| # | Question | Decision | Why |
|---|---|---|---|
| Q1 | What is "Oculus extension"? | Okolos, PassionCode's browser security product (`passioncode-ai/okolos`, checked out as `okolos-extension`); its pure packages run in the Worker; three are already vendored (`vendor/okolos/`, pinned `5d664c5`), `core-mail` and `core-download` join them | Same organization and licence; the notes said "if possible, our Okolos" |
| Q2 | Which model judges a message, and what may it change? | The existing tool-less review model (`SAFETY_REVIEW_MODEL`, default Workers AI `llama-4-scout`) in the owner's own Cloudflare account. It answers in reason codes only and may only raise a message to amber, never lower anything (round 4); the floors are red (feed-listed link, lookalike From or link, a brand named on another domain, a program or disguised file, DMARC fail under an enforcing policy, instructions to an AI found by Okolos's signals); a program or disguised file found by its bytes holds the message from agents; held mail keeps today's review and release rule, whose guard also blocks a disguised file | Round 1 showed that a model allowed only to lower is what an attacker wants (SEC-1, KIMI-1, UX-1); floors keep every deterministic finding |
| Q3 | Does the model run on every message? | Only when a deterministic check fired (any severity) or a document's text was read, on mail that is not held, inside its own daily budget, at most 20 a day per sender domain; a spent budget never holds mail | Cost bounded; a flood cannot hold all mail (SEC-8) |
| Q4 | What does the badge link to? | The Okolos mark and name on the badge and a line about Okolos in the panel; a link to Okolos's page behind a flag, on once the page is public | "Люди будут знакомиться": the name and mark are seen; a link to nothing teaches nothing (UX-4) |
| Q5 | "Если нет автоматизации включенной ... просто уже сразу отправляется" | The agent's mode decides as today: "send allowed answers" sends and the thread shows "Sent by <agent>"; otherwise the draft card (S06). No mode is changed | Changing an agent's mode is the operator's choice in Settings |
| Q6 | "Открыть консоль" for tuning: the terminal console or the agent panel? | The agent panel on the right, opened with a prepared first message carrying the message, the draft, the run's reason and sources | "этот сбоку ... и там ... контекст этого письма"; the terminal console takes no message context |
| Q7 | When a reply is sent, what happens to the agent's draft? | An untouched draft moves to the account's own Discarded (kept 30 days, restorable, every account kind has one); one the person edited (its revision changed) leaves the thread and stays in Drafts with one quiet line; only drafts answering the replied-to message or an earlier one | "Драфт находится только до того, пока он не отправлен"; nothing a person wrote is lost; recoverable, not deleted (KIMI-7, UX-10) |
| Q8 | Reply with no selection: quote everything or nothing? | Nothing, as today; with a selection, that text only | The thread above shows the history |
| Q9 | Forward with more original files than one message may carry? | Attach in order while they fit; list the rest as did not fit; sending is allowed | Today such a forward cannot be sent at all |
| Q10 | Settings with several servers: merged or one at a time? | Changes on one server, named in the header; Accounts, Addresses and Domains read every server under All, grouped by server, opening on the mail's own choice | A change belongs to one server (SCN-099); reading them together answers "only one account" |
| Q11 | The rest of the notes after "в e-mail я могу поставить все, то есть" | Not heard; S11 covers what was said; asked again in the hand-back | The message was cut off |
| Q12 | "Вирусов": an antivirus engine? | None runs in a Worker; files are checked by what their bytes are, and the panel says plainly that no antivirus engine ran, without turning a badge grey. A hash-reputation service is an option needing a key and spend, left for the operator | Honest about what is checked (KIMI-3, UX-2) |
| Q13 | May an amber link open after a warning? | Yes: "Open anyway" for amber and grey; red never opens from the message | "Не даём кликать" applies to a found vulnerability (red); amber is a doubt, and blocking every doubtful link would teach people to ignore the notice (UX-6) |
| Q14 | Old mail with no safety record | Grey "Not checked"; opening it runs the deterministic checks once (no model); until then its links ask | Unchecked is never shown as clean (SEC-5, IR-1) |

## Waves

| Wave | Specs | Why this order |
|---|---|---|
| W1 | S1, S2, S10, S11 | Interface and one desktop read; no badge yet (S2's subject line leaves room for it) |
| W2 | S5, S6, S7, S8 | The thread and the reply path; S6 and S7 change the server's draft handling and the run's outcome |
| W3 | S3, S4, S9 | The checks and the badge (vendored packages, new findings key, a route and a tool), the link guard that reads them, the forward that shows the files' chips |
| W4 | Audit of the whole window (`/ux-audit`, a walk in WebKit), fixes in waves, release, the three servers | The operator's order: specs, review, build, then audit and release |

Each wave lands as its own pull request with its tests, the MCP tools for a new route (`workers/mcp/tools.ts`,
`npm run mcp:docs`), Russian strings in `shared/i18n/ru/` with copy-check report ids, and its SCN lines.
No SQL schema step is needed: the new safety data is JSON in `findings`, the new run fields are JSON on the run.

## Review

Recorded in [review.md](review.md): five independent readers in round 1 (four of one model family, one of another), their findings and what changed.
