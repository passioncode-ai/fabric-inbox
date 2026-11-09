# Inbox on the Studio and in the organizations: state, plan and who does what

**Date:** 2026-11-08. **Asked by** the operator in this repository's session (bc5a7c1c): coordinate with
fabric-workspace and studio-agent, find what the move to the Studio and the organizations still need from Inbox,
what was left undone, and run the plan. Sources: fabric-workspace `docs/plans/2026-11-04-studio-spaces/` (README,
runbook, placement) at `34139a8b`, studio-agent `docs/plan.md` and `docs/updates.md` at `27da499`, this repository's
[Studio spec](../app-store/tasks/2026-11-06-studio-and-organizations.md), and a look at the Studio over SSH on
2026-11-08 10:30 UTC.

## What the plan asks of Inbox, and where it stands

| # | Asked | State 2026-11-08 | Evidence |
| --- | --- | --- | --- |
| 1 | No port per macOS user; profile, log, Keychain item and `fabric-inbox://` handler per user (README:124, :172) | done | `AGENTS.md`, Lifecycle |
| 2 | A key goes to a loopback listener only when it is this OS account's (G1) | done in 1.2.0 (B-217) | `desktop/loopback-owner.cjs`, PR #434 |
| 3 | The first Admin key of an organization's server with no person signing in (G2) | done 2026-11-08 23:37 local: run by this session on the operator's word relayed on the board (thread eefa7959, message 62f95d17: keys are made by Claude Code); key `2083b358`, Admin, standing `people,keys`, vault `fabric-inbox/prod/FABRIC_INBOX_ORG_*` | `agent_key_bootstrapped`; `get_server` answered with the key |
| 4 | Moving the app to another Mac or user (G3) | done in 1.0.0 (B-219) | `desktop/backup.cjs` |
| 5 | Apps per user in `~/Applications` (runbook 2.7; studio-agent `docs/updates.md`: the space's copy) | done 2026-11-08: studio-agent added an `inbox` step to `studio apply` (studio-agent `2ab9f1f`); Inbox 1.2.0 is in `~/Applications` of each space, read back over SSH at 15:27 UTC (`CFBundleShortVersionString` 1.2.0). The 0.95.0 in `/Applications` is the old shared copy | `defaults read` over SSH; the coordinator's relay on the board, thread eefa7959
| 6 | Inbox builds and full gates on the Studio (placement:16) | done: the checkout in `sshlg` was at 0.99.0 with no dependencies; brought to `main` (`c9d9cc7`) 2026-11-08: `npm ci` passed, `npm test` 1956 of 1957 pass and 0 fail in 62 s, `npm run typecheck` passes (exit 0 each) | SSH, `~/DATA/fabric-inbox` |
| 7 | A clean install of Inbox in a macOS VM that opens and updates (runbook 4.2) | waits for terminal-mac (runbook 4.1, the operator's step) | runbook |
| 8 | The organization's mailboxes on the organization's own server | The client organization: all 8 addresses moved 2026-11-07 with a test message each, agents assigned, readers' keys issued. PassionCode: its support address moved from the personal server 2026-11-08 (`export_mailbox`, `import_mailbox`, `move_address` hold and route; the rule as it was is written down), the test message arrived in 3 s, agent `passioncode-support` answers in draft | the move's local journal |
| 9 | The servers on the newest release | PassionCode's server on 1.3.0 (deployed by this session 2026-11-08, receipt `linked`), 1.4.0 next; the client organization's server on 1.0.0 and the personal server on 0.99.0 wait for the operator's word, since agents there answer real customers in auto mode and 1.3.0 changes those answers (B-237 triage) | `get_server`; the deploy receipt in the local deployment record |

## Who does what

| Step | Owner | Prerequisite | Proof |
| --- | --- | --- | --- |
| A. Run B-218 on the PassionCode organization's server | fabric-inbox, done 2026-11-08 | the operator's word on keys (thread eefa7959) | `agent_key_bootstrapped`; `fabric-inbox/prod/FABRIC_INBOX_ORG_*` exist |
| B. The organization's support mailbox and its agent (B-168), with the key from A | fabric-inbox, done 2026-11-08 | A | the test message arrived; `preview_agent_answer` drafted a correct answer with the download link |
| C. Inbox 1.2.0 in `~/Applications` of the personal and the organization's space, kept at the release by `studio apply` as Dashboards is | studio-agent, done 2026-11-08 | none; the verified zip is `Fabric-Inbox-1.2.0-mac.zip` with `SHA256SUMS` and its `.asc` | `defaults read ~/Applications/Fabric\ Inbox.app/Contents/Info CFBundleShortVersionString` in both spaces |
| D. Inbox's full gate on the Studio (`npm test && npm run typecheck`) | fabric-inbox, done 2026-11-08 | none | row 6 above |
| E. The servers to 1.2.0 | the operator's app at the next sign-in, or `lifecycle.restart` of `inbox.desktop` to install the app's own update first | the app on 1.2.0 | `get_server_errors` and `/api/server` answer 1.2.0 |
| F. Lead hand-off to the sales agent from the organization's mailboxes | fabric-inbox: built in 1.4.0 (PR #447); wiring the grant and policy on the client organization's agents waits for E there | the sales agent's cloud and its token (done 2026-11-07); that server on 1.4.0 | by 2026-11-21, Fabric task a03af256 |

### The operator's command for step A

```sh
cd ~/DATA/fabric-inbox && git pull -q && OBSERVATORY_VAULT_ONLY=1 python3 "$(project-observatory full-path)/tools/use_secret.py" \
  run --vault-only --env prod fabric-inbox CLOUDFLARE_API_TOKEN -- env CLOUDFLARE_ACCOUNT_ID=<the organization server's account> \
  node scripts/agent-key-bootstrap.mjs --host <the organization server's host> --bucket <its bucket> \
  --name "Claude Code (operator)" --vault <its vault project>/prod --standing people,keys
```

The account, host and bucket of the organization's server are in its local deployment record
(`deployments/<name>/deployment.json`, git-ignored).

## Left undone before today, found in this pass

- The Studio's spaces ran Inbox 0.95.0 from `/Applications` (step C, done the same day).
- The organization's support mailbox (B-168) has waited since 2026-10-26 for a key nobody could make without a sign-in
  (steps A and B).
- 67 backlog rows still read "in review" (most from releases already published, B-155 to B-236); closing them is the
  operator's move on the board, listed for the next review.
- The agent console's flag to run without permission prompts (Fabric task 829e673d) waits for the operator's own word
  in this session; the classifier refused the change as a relay.

## Done on 2026-11-09, on the operator's word in this session

- All three servers (personal, PassionCode, the client organization) on 1.4.1, deploy receipts `linked`; the client
  organization's agents got the lead grant and policy (step F): advertising and partnership mail goes to the sales agent.
- The 18 batches again on 1.4.0: pass 9, partly 7, fail 2 ([rerun](../reports/2026-11-09-communication-template-rerun/README.md)).
- The agent console runs without permission prompts (829e673d, 1.4.1); new mail from every server (B-233, 1.5.0); the
  profile switches apply while the app runs (B-236, 1.5.0).
- B-239 (board request `82d3933f`, thread `76917daf`): rules on a stranger's message wait for its spam check, the AI
  condition ignores a message's claim of its own importance, advance-fee fraud is scam. PR #457 (`764f1dc`), release
  [v1.5.1](https://github.com/passioncode-ai/fabric-inbox/releases/tag/v1.5.1) (release run 42631620765 green, 20
  assets); all three servers on 1.5.1 at 14:09 UTC, receipts `linked`, `get_server` answers 1.5.1; answered in the thread.

## Next task

1. The Studio's spaces to 1.5.1 by `studio apply` (studio-agent), and this Mac's app by its own update.
2. B-237's two remaining failures (a vent with no detail, a request for a person the knowledge covers): the writer's
   clarify rule, then the batches again.
3. PassionCode's support agent to auto mode once a person has read its first drafts.
4. B-240 (board request `f397d3ab`, thread `0340abfc`, due 2026-11-23): compare the template database's
   support-answerer 1.4.4 with our reply agent and answer what we take and what not. A first finding: our state claims
   (`workers/agents/state-claims.ts`) are only logged, the template blocks them unless they sit in a condition or a
   question (`checks.states_false`); that is B-237's step 2 too.
5. The rest of B-236 (an update check now, Open at Login, Forget Server, a server's address): the link design first.
