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
| B-258, B-254: Workers AI agents outlive Kimi (K2.6 stops answering on 2026-11-20; the default `kimi-k2.5` answered as K2.6): default `@cf/qwen/qwen3.8-27b` at low effort, retired ids replaced; a server without an OpenRouter key checks every auto answer by a Workers AI model of another vendor | PR #517 `33b9ff4` | Studio `npm test` 2083 pass, typecheck 0; measured writers and checkers through `wrangler dev` with a remote AI binding; the shipped code run live: Qwen wrote a valid answer in 7 s, DeepSeek refused a wrong answer and approved a right one in about 1 s |
| Release 1.6.9 (B-257 by another session, B-258, B-254) | PR #518, tag `v1.6.9` on `e60cc84` | the three servers on 1.6.9 (receipts commit `e60cc84e4a55`, 100 %); v1.6.8 release run 43353660766 green |
| B-232 design (D-3a in [the packet](../app-store/tasks/2026-11-12-inbox-agent-grants.md)): where each role comes from, since the contract makes an attestation's role no authority (DEC-0133 OL-6) and names no architect (DEC-0127 OM-1); delegated grants checked against their grantor at every use | PR #521 | reviewed by `moonshotai/kimi-k3.1-pro`, four findings taken |
| B-246 W2c: the cut-over built behind `GRANTS_DECIDE` (off): the grants decide a key's tools and each call's API is narrowed to the mailboxes they give that tool | PR #522 `f20dd8e` | `tests/mcp-grants-cutover.test.ts`: equal to today's checks for every tool and every key that exists; the shadow over 3 days on the three servers (434, 113, 196 `/mcp` calls): no disagreement, no failure |
| B-259: a key limited to mailboxes runs only its own mailboxes' campaigns (by sender) | PR #523 `3ce538f` | Studio `npm test` 2088 pass, typecheck 0 |
| Release 1.6.10 (B-246 W2c off, B-259) | PR #524, tag `v1.6.10` on `2ae43b0` | the three servers on 1.6.10 (receipts commit `2ae43b0a7bee`, 100 %); `get_server` answers 1.6.10 |
| Release 1.6.10 published | run `43414822585`, third attempt green after the Apple agreement was accepted (14:07 UTC) and Sigstore's 502 at attestation cleared | `gh release view v1.6.10`: Latest, 20 assets; the update feed answers 1.6.10 |
| B-246 W4a: the architect role behind `ROLE_GRANTS` (off), the HTTP gate by each route's capability read from the tools, every change kept as `architect_act`, Architect in Settings → People | PR #526 `1713a78` | Studio `npm test` 2095 pass, typecheck 0; `tests/role-architect.test.ts` |
| B-246 W4b: an architect gives the agent keys they made access within the role, held only while the role does | PR #528 `a7bd755` | Studio `npm test` 2099 pass; `tests/role-delegation.test.ts` |
| Release 1.6.11 (W4a, W4b; `ROLE_GRANTS` off) | PR #529, tag `v1.6.11` on `2e7777c` | published 15:07 UTC; the three servers on 1.6.11 (receipts, tag `2e7777cbd1e0`) |
| 17 board rows released long ago closed with their receipts | PR #530 `bc27aaa` | `tests/board-table.test.ts` |
| B-246 W5a (packet R-6): a key that may prepare campaigns but not send launches one only through the owner's approval, bound to the campaign's fingerprint and used once; the MCP reference generator without em dashes (the rest is B-260) | PR #531 `22581ed` | Studio `npm test` 2103 pass, typecheck 0; `tests/campaign-owner-send.test.ts` |
| Release 1.6.12 (W5a) | PR #532, tag `v1.6.12` on `b7624ff` | the three servers on 1.6.12 (receipts, tag `b7624fffb159`); `get_server` answers 1.6.12 on the organization's and the client organization's servers |
| B-260: no em dash in the tool texts agents read and in the agent protocol reference | PR #534 `3d5fcf4` | `tests/mcp-no-em-dash.test.ts` |
| B-262 (operator 2026-11-13: «не ставь лимитов, по дефолту заданы 1000 емаилов в день но можно расширить по запросу»): campaigns 1000 a day by default, every day 08:00 to 20:00, 0 to 1 minute apart, no ramp-up, `dailyCap` up to 100000; agent keys and grants 1000 a day, up to 100000; every Gmail, IMAP or Outlook account 1000 a rolling day with no hourly cap, `SEND_LIMIT_DAY` raises it | PR #536 `2661bf4` | Studio `npm test` 2106 pass, typecheck 0; `tests/send-limits.test.ts` |
| Release 1.6.13 (B-260, B-262) | PR #537, tag `v1.6.13` on `4bc4318` | the three servers on 1.6.13 (receipts, tag `4bc431857dd7`; versions 568b3dab, c9c7eca8, f519468e); `get_server` answers 1.6.13 on the organization's and the client organization's servers |
| The client organization's outreach agent follows B-262: its campaign cap 1000 by default, up to 100000 (its own repository, 0.2.1) | `edf4378` | its 891 tests |
| Studio's checkout of this repository fast-forwarded from `c9d9cc7` (#438) to `4bc4318` | `git merge --ff-only` | `git log -1` there |
| Each server's Worker logs are readable: `CF_WORKERS_OBSERVABILITY_READ` in the owner's vault and, issued today, in the client organization's; the query filters on `$workers.scriptName` and the log's own `event` field | Observatory `cloudflare.py issue --preset workers-observability-read` | the shadow read above |

## Open, with its watcher

- The Mac app on the owner's Mac installs its latest verified update when it quits (it was not started by the lifecycle broker, so no agent restarts it). 1.6.12 published at 15:33:58Z (run `43450183482`); 1.6.13 published at 20:44:12Z (run `43500528038`, 20 assets). `v1.6.9` stays unpublished on purpose.
- Studio: Fabric Inbox 1.6.12 is installed in `/Applications`, owned by the Studio space `aiteam1` (the `sshlg` account is no administrator and cannot replace it; the verified 1.6.13 zip was refused at the move and nothing changed); it updates itself when it runs in that space; it is not running; its app holds only the owner's server; Codex there has no `fabric-inbox` MCP server (the PassionCode doctor's warning). Adding the organization's and the client organization's servers to that app needs a person's sign-in (Cloudflare Access code): a human gate.
- B-246 cut-over on 2026-11-15: read each server's Worker logs for `grant_shadow_disagreement` and `grant_shadow_failed` (none through 2026-11-13); with none, deploy with `--var GRANTS_DECIDE:on` on the three servers (operator 2026-11-13: «Да, включай сам») and read them again a day later.
- B-246 W5: the outreach agent is assembled (its own private repository, `8a99a1e`); placement by studio-agent waits for
  its HTTP surface and probe (its OI-9) and the operator's word for the deploy key (given 2026-11-13: «Да, подключать и ставить», relayed to studio-agent); the mailbox is the operator's to choose later (OI-2); the owner's decisions (sales owner,
  mailbox and sender, audience and texts, privacy) wait on the organization agent's question `e8c2435c`; the access
  owner approves the agent's request once it asks.
- A person's first sign-in in the Inbox app of each Studio space (Cloudflare Access): a human gate.
- MacBook disk: full at ~15:30 UTC today, then 8.8 GB; builds run on Studio and only `build/` comes back (13 MB),
  deployed with `npx --yes wrangler@4.74.0 deploy --config build/server/wrangler.json`.

## Exact next task

1. On or after 2026-11-15: B-246 cut-over (W2c end): read the three servers' Worker logs for `grant_shadow_disagreement` and `grant_shadow_failed`; with none, redeploy 1.6.13 (or later) with `--var GRANTS_DECIDE:on` and read them again a day later. `ROLE_GRANTS` stays off until W4c (the employee preset) passes, which waits for B-159. When the board reconnects: post the B-232 design (D-3a) and the architect role on thread `eefa7959`.
2. The B-236 server address door by 2026-11-18 (board request `3f8cfff5`). After 2026-11-20, read one day of each
   server's Worker log for Workers AI `5028` (a retired model) to confirm B-258 left none.
3. Stale rows in `docs/evidence/backlog.md` still "in review" for work released long ago (B-243 among them): close
   them with their receipts under the lease.
