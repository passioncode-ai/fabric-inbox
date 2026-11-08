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
| 3 | The first Admin key of an organization's server with no person signing in (G2) | built (B-218); its run on the PassionCode organization's server waits for the operator (below) | `scripts/agent-key-bootstrap.mjs` |
| 4 | Moving the app to another Mac or user (G3) | done in 1.0.0 (B-219) | `desktop/backup.cjs` |
| 5 | Apps per user in `~/Applications` (runbook 2.7; studio-agent `docs/updates.md`: the space's copy) | not done: only `/Applications/Fabric Inbox.app` 0.95.0, owned by `aiteam1`; neither the personal space nor the organization's space has a copy, and with no graphical login the app never updates itself | SSH: `defaults read` in both spaces |
| 6 | Inbox builds and full gates on the Studio (placement:16) | done: the checkout in `sshlg` was at 0.99.0 with no dependencies; brought to `main` (`c9d9cc7`) 2026-11-08: `npm ci` passed, `npm test` 1956 of 1957 pass and 0 fail in 62 s, `npm run typecheck` passes (exit 0 each) | SSH, `~/DATA/fabric-inbox` |
| 7 | A clean install of Inbox in a macOS VM that opens and updates (runbook 4.2) | waits for terminal-mac (runbook 4.1, the operator's step) | runbook |
| 8 | The organization's mailboxes on the organization's own server | The client organization: all 8 addresses moved 2026-11-07 with a test message each, agents assigned, readers' keys issued. PassionCode: its server runs; its support mailbox (B-168) waits for 3 | the move's local journal |
| 9 | The servers on the newest release | the personal and both organizations' servers on 1.0.0; 1.2.0 is published (2026-11-08); the app updates each server at the person's sign-in | `gh release view v1.2.0`; `desktop/server-update.cjs` |

## Who does what

| Step | Owner | Prerequisite | Proof |
| --- | --- | --- | --- |
| A. Run B-218 on the PassionCode organization's server (command below) | **operator** (the session's classifier refuses an agent adding its own access) | none | the command prints `agent_key_bootstrapped`; `passioncode-inbox/prod/FABRIC_INBOX_*` exist |
| B. The organization's support mailbox and its agent (B-168), with the key from A | fabric-inbox | A | a test message arrives; the agent answers a test question in draft |
| C. Inbox 1.2.0 in `~/Applications` of the personal and the organization's space, kept at the release by `studio apply` as Dashboards is | studio-agent (asked through fabric-workspace on the board) | none; the verified zip is `Fabric-Inbox-1.2.0-mac.zip` with `SHA256SUMS` and its `.asc` | `defaults read ~/Applications/Fabric\ Inbox.app/Contents/Info CFBundleShortVersionString` in both spaces |
| D. Inbox's full gate on the Studio (`npm test && npm run typecheck`) | fabric-inbox, done 2026-11-08 | none | row 6 above |
| E. The servers to 1.2.0 | the operator's app at the next sign-in, or `lifecycle.restart` of `inbox.desktop` to install the app's own update first | the app on 1.2.0 | `get_server_errors` and `/api/server` answer 1.2.0 |
| F. Lead hand-off to the sales agent from the organization's mailboxes | fabric-inbox | the sales agent's cloud and its token in the client organization's server (done 2026-11-07) | by 2026-11-21, Fabric task a03af256 |

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

- The Studio's spaces run Inbox 0.95.0 from `/Applications` (step C).
- The organization's support mailbox (B-168) has waited since 2026-10-26 for a key nobody could make without a sign-in
  (steps A and B).
- 67 backlog rows still read "in review" (most from releases already published, B-155 to B-236); closing them is the
  operator's move on the board, listed for the next review.
- The agent console's flag to run without permission prompts (Fabric task 829e673d) waits for the operator's own word
  in this session; the classifier refused the change as a relay.

## Next task

Step B once step A has run: `create_address` for the organization's support address on its server, the support agent
from the template of B-85, a test message, then the hand-off to a person in draft mode.
