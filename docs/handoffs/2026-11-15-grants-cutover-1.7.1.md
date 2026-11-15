# Handoff 2026-11-15: B-246 cut-over, 1.7.1 (B-277, B-284), B-281 desktop parity

Previous: [2026-11-14 mail window and 1.7.0](2026-11-14-mail-window-1.7.0.md).

## Objective

Take the next tasks from the 1.7.0 handoff: the B-246 cut-over due on 2026-11-15, then B-277; answer the board.

## Done

| What | Evidence |
|---|---|
| B-246 cut-over: grants decide agent keys on the three servers | Shadow read over 60 hours: 0 `grant_shadow_disagreement`, 0 `grant_shadow_failed` (35,557, 134 and 1,609 `/mcp` calls). 1.7.0 deployed again with `--var GRANTS_DECIDE:on`: versions `dd1455ab`, `5aa8b616`, `dbd3bbdb`, receipts `linked`, owner bindings 2 of 2. Proving calls on the two organizations' servers: 166 tools, `list_accounts`, `get_server` the same before and after. 15 minutes of logs after: no `mcp.grants_unreadable`, no 403 or 503 (the two 400 and two 405 on one server were a client's first connection, `GET /mcp` and malformed first posts) |
| B-277: a forward reopened from Drafts keeps its original's files | [S09b](../ux/plans/2026-11-14-mail-window/S09b-forward-reopen.md), second-model review (K-1, K-2, K-3, K-6 to K-9 taken); `workers/lib/draft-forward.ts`, `app/components/inbox/forward-meta.ts`; tests `forward-reopen`, `draft-forward-workerd`, `draft-forward-gmail` |
| B-284: `onboard.mjs register --url … --headers-command …` | `tests/onboard.test.ts`, `docs/agents/onboard.md` §3; asked on the board (thread `f0553adf`) |
| 1.7.1 | PR #575 squash `c708f1fd`; gate `npm test` 2312 pass, typecheck, build, UX and brand lints, `check_private` 0; deployed with `GRANTS_DECIDE=on`: versions `14e34157`, `52851c62`, `87a38675`, receipts `linked`, `get_server` 1.7.1 on the two organizations' servers; tag `v1.7.1`, run 43678252395 success, published 2026-11-15 05:08 UTC with 20 assets |
| B-281: the desktop actions held by a test | `tests/desktop-actions-parity.test.ts` (fails when a menu action has no row in [desktop-actions.md](../agents/desktop-actions.md); checked by removing a row); answered on the board, thread `16093ded` |
| B-236, the server address door the board asked for (`3f8cfff5`, due 2026-11-18) | Already delivered on 2026-11-12 (`bc03274`, PR #500; thread `64269c90`, reply `5c66af13`); the earlier handoffs' due date was stale. Left in B-236 without an outside deadline: an update check now, Open at Login, Forget Server |
| Board | Replied to `a06b556c` (B-284, delivered in 1.7.1) with a correction `ed0f8794`; all unread acknowledged |

## Open

- **Every deploy must pass `--var GRANTS_DECIDE:on`** (fabric memory `deploy.grants-decide-flag`): it is not in `wrangler.jsonc`, and without it the grants stop deciding.
- B-258 log read after 2026-11-20; B-265 step 3; B-282, B-283, B-278, B-279; B-236's rest (no outside deadline).

## Exact next task

1. B-283: the two minor findings of the F1 review (EmailIframe folded height, nested rows' hidden cells).
2. After 2026-11-20: B-258, read one day of each server's logs as its row says.
