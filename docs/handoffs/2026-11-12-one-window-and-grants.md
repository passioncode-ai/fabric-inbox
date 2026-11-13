# Handoff 2026-11-12: one mail window (B-244), Studio keys, R28, Inbox as an agent (B-246)

**Entry point for the next agent.** Session of 2026-11-11/12 in this repository. Everything below is on `main`.

## Done

| What | Where | Proof |
| --- | --- | --- |
| Studio spaces sshlg and passioncode: agent keys made from this Mac with `agent-key-bootstrap.mjs --vault-host`, values straight into each space's vault, MCP registered, `list_accounts` answers | PR #471 `f8219b5`; [studio handoff](2026-11-08-studio-move.md) | 83 and 1 accounts, server 1.5.6, `claude mcp list` Connected |
| R28 (only add, only improve): shipped agent templates locked by digest, rule in `AGENTS.md` (B-245) | PR #471 | `tests/agents-add-only.test.ts`; board reply in thread `a8802056` |
| B-244 steps 1 to 4: scenarios, a page per server in one window, the bridge, the tabs and merged list | PRs #472 to #475 | tests, walks on two local servers |
| Release 1.6.0 (B-244 steps 2 to 4) | PR #476, tag `v1.6.0` on `0a51d1f` | release run 43147707526 (in progress at writing) |
| B-246 W1: [the packet](../app-store/tasks/2026-11-12-inbox-agent-grants.md), SCN-100 to SCN-103, the architect's consult, a design review by another model family | PR #477 | `docs/ux/lint.py` 0 errors |
| B-246 W2a part 1: the grant model, not wired yet | PR #478 `6232066` | `tests/mcp-grants.test.ts` 7 pass |
| B-246 W2a part 2 to W2c: every tool's need, contracts, the grant store, the shadow decision, routes and tools, Access by mailbox in Settings | PRs #479 to #487 | released in 1.6.1, on the three servers |
| B-246 W3: access requests (`request_access`, `list_my_access`, `list_access_requests`, `decide_access_request`, the requester key), the waiting requests in Access by mailbox | PR #488 `909a89f` | Studio `npm test` 2063 pass, typecheck 0 |
| Release 1.6.2 (W3) | PR #489, tag `v1.6.2` on `e6e0287` | the three servers on 1.6.2 (receipts `linked`); the release run waits for a GitHub runner |
| B-244 step 5: Rename Server, the All Servers window removed, a several-server notification opens `/?servers=all` | PR #491 `4ba2754` | Studio `npm test` 2065 pass |
| B-247: a reply is read by its new text and topic for hand-off topics (asked on the board, message `1e696266`) | PRs #494, #497 `6340c2d` | test `B-247` fails without the change; live `preview_agent_answer` on the asking agent: no hand-off |
| Release 1.6.3 prepared (B-244 step 5, B-247) | PRs #493, #495; servers on `6340c2d` as 1.6.3 (receipts `linked`) | the tag waits for the 1.6.2 run (below) |
| Course check item 1a in `AGENTS.md` | PR #496 | |
| Remote branches: only `main` left; `agent/b213-stop-hour` (landed as #416, #417) archived at `refs/archive/2026-11-12/` | | `git ls-remote origin 'refs/heads/*'` |


| Releases 1.6.3 to 1.6.6 published and on the three servers (receipts `linked`, `get_server` answered 1.6.4) | tags `v1.6.3` to `v1.6.6` | release runs green to 1.6.4; 1.6.5 and 1.6.6 watched |
| B-236: an agent adds a server by `fabric-inbox://server` after the person's Add Server | PR #500 | Studio `npm test` 2069 pass |
| B-248, B-249: a reply asks the knowledge what it asks now; the checker reads the passages the model found itself | PRs #501, #503 | live previews of the asking agent's ticket: no hand-off, no "not in the facts" |
| B-250, B-251: a request-only key needs no level and is listed as such; a campaign recipient written to names its thread | PRs #505, #506 | Studio `npm test` 2072 pass |
| The client organization's outreach agent's requester key in its Studio space's vault (`<agent>/prod/FABRIC_INBOX_*`); proved with `list_my_access` from that space | board thread `0100677f` | the first attempt's key, whose value was lost, revoked |
| Release 1.6.7: each checked answer records how much of the checker's window it used (B-252) | PR #510, tag `v1.6.7` | release run 43334164552 green; the three servers on 1.6.7 |
| B-253 (links): only a packaged app takes `fabric-inbox://` links | PR #511 | released in 1.6.8 |
| B-256: a new agent answers by itself (operator, 2026-11-13: «по дефолту если мы создаем агента он должен начинать писать автоматом»); the old templates retired in `shipped.lock.json`, `support-auto`, `sales-auto`, `billing-auto` added (R28) | PR #512 (filed as B-253, renumbered: two rows shared it) | `tests/agents-add-only.test.ts` |
| B-168: the PassionCode support agent in auto (operator: «Проверь сам и включай»): one false claim fixed (v2), the server's own reply-lane OpenRouter key set as `OPENROUTER_API_KEY`, v3 sends `question`, `how-to`, `status`, `download`, `bug` | board row B-168 | eight live previews: every send carries a `check` approved by `qwen/qwen3.8-flash` |
| B-255: the model is told the intents an agent may send, word for word | PR #513 `9085a96` | Studio `npm test` 2077 pass, typecheck 0; live preview labels `bug` |
| Release 1.6.8 (B-253 links, B-255, B-256) | PR #514, tag `v1.6.8` on `30af301` | the three servers on 1.6.8 (receipts commit `30af30150b2e`, 100 %); release run 43353660766 |

## Open, with its watcher

- Release run for `v1.6.8` (43353660766, queued for an org runner): watched by this session; the servers already run 1.6.8.
- B-254: a server without an OpenRouter key sends auto answers unchecked (`workers/agents/deps.ts`); a first attempt (branch `agent/b254-no-checker`, local worktree `fi-b254`) broke 11 runner tests that rely on a checkerless harness.
- B-246 shadow wait until 2026-11-15: read each server's Worker log for `grant_shadow_disagreement`, then the cut-over (operator, 2026-11-13: «Да, включай сам» when no disagreement is logged).
- B-246 W5: the outreach agent is assembled (its own private repository, `8a99a1e`); placement by studio-agent waits for
  its HTTP surface and probe (its OI-9) and the operator's word for the deploy key (given 2026-11-13: «Да, подключать и ставить», relayed to studio-agent); the mailbox is the operator's to choose later (OI-2); the owner's decisions (sales owner,
  mailbox and sender, audience and texts, privacy) wait on the organization agent's question `e8c2435c`; the access
  owner approves the agent's request once it asks.
- A person's first sign-in in the Inbox app of each Studio space (Cloudflare Access): a human gate.
- MacBook disk: full at ~15:30 UTC today, then 8.8 GB; builds run on Studio and only `build/` comes back (13 MB),
  deployed with `npx --yes wrangler@4.74.0 deploy --config build/server/wrangler.json`.

## Exact next task

1. After 2026-11-15: B-246 cut-over (W2c end), then W4 (roles, B-232 design due 2026-11-13 on thread `eefa7959`).
2. B-254: a checker for a server without an OpenRouter key (a Workers AI model of another vendor), or drafts there;
   make the runner harness name its checker first. Then the B-236 server address door by 2026-11-18 (`3f8cfff5`).
3. Stale rows in `docs/evidence/backlog.md` still "in review" for work released long ago (B-243 among them): close
   them with their receipts under the lease.
