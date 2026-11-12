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

## Open, with its watcher

- Release run 43147707526 for `v1.6.0`: watched by this session's background poll; on success, update the three
  servers to 1.6.0 (as for 1.5.6) and check `/api/server` on each; the Mac app updates itself.
- The board row B-246 still says "next W2a": another run held the backlog lease (`refs/agent-sync/leases/res--fabric-inbox--docs-evidence-backlog-md`).
  Under the lease, set its status to: "W2a part 1 done 2026-11-12 (`workers/mcp/grants.ts`, `tests/mcp-grants.test.ts`);
  next W2a part 2".
- A person's first sign-in in the Inbox app of each Studio space (Cloudflare Access): a human gate; agents do not need it.
- The client organization's agent key for its Studio space: its access owner issues it (DEC-0009).

## Exact next task

1. B-246 W2a part 2: an explicit `capability` on every tool in `workers/mcp/tools.ts` with a coverage test, then the
   shadow run: beside `scope.ts` and `protocol.ts`, compute `allows()` from `grantsOfKey` and log every disagreement
   (`grant_shadow_disagreement`, no address in the log). Then W2b (contracts), W2c (cut-over), W3, W4, W5 as the packet's waves say.
2. B-244 step 5: rename a server (D-4) and remove the All Servers window (D-5), then a release.
3. Board request `3f8cfff5` (the organization service): B-236 server address door by 2026-11-18.
