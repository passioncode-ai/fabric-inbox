# Handoff 2026-11-14: the mail window (S01 to S11), its audit in three waves, 1.7.0

**Entry point for the next agent.** Session of 2026-11-14 in this repository. Everything below is on `main`. The
previous entry is [2026-11-14, send reasons and tool secrets](2026-11-14-send-reasons-and-tool-secrets.md).

## Done

| What | Where | Proof |
| --- | --- | --- |
| The operator's mail-window notes as eleven specs S01 to S11, each reviewed by a second model before and after the build | [plan](../ux/plans/2026-11-14-mail-window/) | PRs #561 (W1: S01, S02, S10, S11), #562 (W2: S05 part, S08), #563 (S09), #564 and #566 (S06, S07), #565 (S03, S04) |
| Board rows for the built items and the gaps they left | [backlog](../evidence/backlog.md) B-267..B-279 | PR #567 |
| Audit of the mail window after S01 to S11: 33 findings (2 blocking, 10 major, 21 minor) and a walk fixture | [report](../reports/2026-11-14-mail-window-audit/README.md) | PR #569 |
| Fixes in three waves: F3 (rules tabs, settings fit, Russian wording), F2 (the agent draft card), F1 (reader, safety, forward, switch) | report sections "Fixed in wave F1/F2/F3" | PRs #570, #571, #572; F1's second-model review found one real gap (a failed safety check attached unchecked files to a forward), fixed in `7f2775f2` with `tests/attachment-composer.test.ts` |
| Release 1.7.0: version, changelog section (with the lines W1, W2 and the audit waves had left out), board rows B-281..B-283 | PR #573 `265e9ee3`, tag `v1.7.0`, release run `43648768482` | PR gate green; local `npm test` 2302 pass, typecheck and build 0 |
| 1.7.0 on the three servers (owner, organization, client organization) | deploy receipts under `deployments/<name>/receipts` | tag `265e9ee3c6b2`, all `linked`; versions `8d7c7d65`, `aaef5d6c`, `f6e3934e`; the owner's server keeps its offers-desk host and credential (2 of 2 bindings) |
| The architect advises, never gates (the operator's word relayed in board `c419e464`): `AGENTS.md` rewritten; release scan kept | [scan](../evidence/architect/2026-11-14-scan.json) | `agent-host` 21.791, `support-answerer` 16.545 |
| Board: plan rows 2.11 to 2.13 answered (`fbffa1cb`); rows B-281 (desktop-only functions' agent routes, by 2026-11-21) and B-282 (console through Switchboard) filed | board thread `16093ded` | |

## Open, with its watcher

- B-281 answer with the parity list and a test, due 2026-11-21 (board thread `16093ded`); B-282 after it.
- B-283: two minor F1 review findings (folded-quote frame height, nesting past "Show earlier messages").
- B-277 (forward reopened from Drafts loses its file list), B-278 (agent drafts on Gmail, IMAP, Outlook), B-279 (Okolos gaps).
- From the previous handoff, unchanged: B-246 cut-over on or after 2026-11-15; B-236 by 2026-11-18; B-258 log read after 2026-11-20; B-265 step 3.
- One process note: once, on 2026-11-14, a branch of this session (`agent/mailwin-s0607b`, not yet merged) was pushed with `--force-with-lease` after a rebase; from then on main was merged into pushed branches instead.

## Exact next task

1. Done; next is [2026-11-15](2026-11-15-grants-cutover-1.7.1.md). Watch release run `43648768482` (tag `v1.7.0`) to the published release, then update the local install.
2. B-277: keep the forward's file list when a draft is reopened from Drafts (`app/components/inbox/server-drafts.ts:248`, `:255`).
3. On or after 2026-11-15: the B-246 cut-over (previous handoff).
