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


## Open, with its watcher

- Release run 43221388971 for `v1.6.2` queued: the organization's Actions runners are busy (free plan; 15 runs of
  another repository ahead). This session's background job tags `v1.6.3` on `6340c2d` once that run ends green, so
  1.6.2 is published before 1.6.3 and stays out of the way of "latest". If the session is gone: wait for the run, then
  `git tag -a v1.6.3 -m "Fabric Inbox 1.6.3" 6340c2df1f965c53cb13f63b897bee602502cc31 && git push origin v1.6.3`,
  watch the release run, check `/api/server` 1.6.3 on each server (already deployed). The Mac app updates itself.
- B-246 shadow wait until 2026-11-15: read each server's Worker log for `grant_shadow_disagreement`; none expected;
  then the cut-over (grants decide, `decides: true`). Reader: the next session on B-246, no scheduled job.
- B-246 W5 (the client organization's outreach agent): board thread `0100677f` (its organization agent, studio-agent,
  fabric-agents-database), message `1ffd7124`: the sales owner, the outreach address, the access owner, the assembly
  from `sales-leads` and the deploy. Human gates: the access owner's approval (DEC-0009) and the owner's word on the
  first send of each campaign.
- B-247 asker (a reply agent's project, thread `7a01c638`): told the hand-off is fixed; their checker now refuses the
  answer for details not in their facts (theirs to fix).
- A person's first sign-in in the Inbox app of each Studio space (Cloudflare Access): a human gate; agents do not need it.

## Exact next task

1. After 2026-11-15: B-246 cut-over (W2c end), then W4 (roles, B-232 design due 2026-11-13 on thread `eefa7959`).
2. B-236 server address door by 2026-11-18 (board request `3f8cfff5`), and B-168 auto mode for the PassionCode
   support agent once a person read its first drafts.
3. Stale rows in `docs/evidence/backlog.md` still "in review" for work released long ago (B-243 among them): close
   them with their receipts under the lease.
