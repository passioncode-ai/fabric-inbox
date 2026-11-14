# Handoff 2026-11-14: 1.6.15 (send reasons, tool credentials as own secrets), console quiet, audit

**Entry point for the next agent.** Session of 2026-11-14 (00:20 to about 02:30 Warsaw) in this repository. Everything
below is on `main`. The previous entry is [2026-11-12](2026-11-12-one-window-and-grants.md).

## Done

| What | Where | Proof |
| --- | --- | --- |
| Restored: local checkout moved from a detached `bc27aaa` to `main` (10 commits behind, 1.6.14); the merged `release/1.6.14` worktree and remote branch removed | `git worktree list`, `git ls-remote origin 'refs/heads/*'` | only `main` left |
| B-264: a tool credential can be its own secret `AUTOMATION_TOOL_TOKEN_<NAME>` holding one `{ host, token }`, added without writing `AUTOMATION_TOOL_TOKENS` again (`readToolTokens` in `workers/automation/mcp.ts`, used by reply agents, the tool schema read and rules) | PR #545 `470b163` | `tests/tool-token-secrets.test.ts`; `npm test` 2114 pass |
| B-228: one wording per cause on every surface that sends (`sendFailure`, `sendFailureNotice` in `app/components/inbox/send-state.ts`; the composer, the older mailbox view, the classic compose) | PR #546 `8cfe1eb` | `tests/send-failure.test.ts` (a test per cause, Russian included); SCN-007 |
| Release 1.6.15 (B-228, B-264); the brand registry followed the send sentences to `send-state.ts` (brand lint B021, found by the release gate) | PR #547, tag `v1.6.15` on `2500f12e` | gates in the PR; release run `43529369199` |
| 1.6.15 on the three servers (owner, organization, client organization) | deploy receipts under `deployments/<name>/receipts`, tag `2500f12e566b`, all `linked` | versions `1c06e19b`, `0692a4cd`, `0c7aad5b` |
| The owner's server: the reply agent project's offers desk host added to `AUTOMATION_MCP_HOSTS`, its credential set as `AUTOMATION_TOOL_TOKEN_PRIVATE..._LEADS` from the vault; the map and its entries untouched; answered on board thread `7a01c638` (message `44033b76`) | Cloudflare script settings read back | the requester adds its grant with that `tokenRef` |
| B-261 SL-3: a console session with no output and no input for 30 minutes logs `quiet` (and `active` when it resumes) and the console says it still holds its key; the digest map counts `active` ok and `quiet` unknown | PR #548 `a48e7f0` | `tests/desktop-console.test.ts`, `tests/desktop-ops-digest.test.ts`; SCN-078 |
| Release 1.6.16 (B-261) merged and on the three servers | PR #549 `bffb28c`; deploy receipts, tag `bffb28ce55e2`, all `linked` | versions `b6a97ea3`, `40221677`, `7dd9622f`; the tag `v1.6.16` waits for the 1.6.15 run |
| B-265 step 1: no em dash in the English interface strings and the app's markup (25 keys and their Russian values, 10 separators); `tests/no-em-dash-ui.test.ts` | PR #551 `4166af8` | copy checks on the changed strings, both locales |
| Release 1.6.17 (B-265 step 1) merged and on the three servers | PR #552 `6690e71`; receipts tag `6690e71ed794`, all `linked` | versions `e5869050`, `1b403035`, `dcff28cf`; the tag `v1.6.17` waits for the 1.6.16 run |
| B-265 steps 2a and 2b: every Russian translation without an em dash but one shipped prompt template (R28); the Mac app's copy has none | PR #554 `08a68cb`, #555 `8f1d958` | the copy check in ru-RU over every changed string, no blocking finding; `tests/no-em-dash-ui.test.ts` |
| Release 1.6.18 (B-265 steps 2a, 2b; carries 1.6.17, whose tag is not pushed: one heavy run saved, as with `v1.6.9`) merged and on the three servers | PR #556 `5d7fee8`; receipts tag `5d7fee87752f`, all `linked` | versions `da677dab`, `46835c89`, `199058eb` |
| Board: the coordinator's rule (`35556d27`) recorded in `AGENTS.md` and answered (`e794b5c7`, with the North Star state for section 4); 27 unread messages read and marked | board thread `16093ded` | |
| Audit of production: one day of Worker logs on the three servers | Workers Observability, `CF_WORKERS_OBSERVABILITY_READ` | only `support_topics_failed` twice, caused by the deploy's Durable Object reset and retried by itself (`TOPICS_IDLE_MS`): no defect |
| B-265 filed: em dashes in text people read (25 English interface strings, 163 Russian translations, README, docs) | `docs/evidence/backlog.md` | counts by `grep -c` |

## Open, with its watcher

- The tag `v1.6.16` on `bffb28c` was pushed after 1.6.15 published (run `43533241999`); the tag `v1.6.18` on `5d7fee8` goes after it is published (one heavy run at a time); `v1.6.17` is not tagged on purpose (servers only).
- B-246 cut-over on or after 2026-11-15 (unchanged from the previous handoff): read the three servers' logs for
  `grant_shadow_disagreement` and `grant_shadow_failed`; with none, deploy with `GRANTS_DECIDE` on (operator
  2026-11-13: «Да, включай сам»). Note: `wrangler deploy --var NAME:VALUE` breaks on a value with dots; put such a
  var in the built `build/server/wrangler.json` `vars` for that deploy (fabric memory `deploy.wrangler-var-dots`).
- Fabric question `4b2d80fe` (the operator's approval of the B-264 config change) is moot: the change was made
  additively under the coordinator's rule; the operator may close it.
- The board request `3f8cfff5` (B-236 server address door, due 2026-11-18) and the B-258 log read after 2026-11-20
  stay as in the previous handoff.

## Exact next task

1. When run `43533241999` is green and `gh release view v1.6.16` lists 20 assets: push the tag `v1.6.18` on `5d7fee8`
   and watch its run to the published release.
2. On or after 2026-11-15: the B-246 cut-over above.
3. B-265 step 3: the server texts a person reads outside the dictionary (setup names such as the generated
   "<name> (dash) domains (Cloudflare)", knowledge citations), then README and current docs; dated records stay.
