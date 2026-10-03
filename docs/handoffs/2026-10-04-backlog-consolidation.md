# Backlog consolidation handoff — 2026-10-04

## Objective

The operator asked (2026-10-04) for every unfinished item, ticket and unmerged pull request to be
in its project's backlog, under the workspace's
[common backlog contract](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/backlog.md).

## Completed

- `docs/backlog-sources.json` already declared both boards (`16855f1`). The audit board
  [docs/evidence/backlog.md](../evidence/backlog.md) was declared open-only (`defaultStatus`), and
  its header said to close a row by deleting it, against the contract. It now has a `Status` column
  (`statusColumn: "Status"`). Every existing row is `open`. Closed rows stay, with their receipt.
- New rows: **B-46** (PR #12, the lifecycle packet, blocked: the branch conflicts with `main`),
  **B-41** (new-mail notifications, operator decision) and **B-42** (Keychain/cookie-encryption
  check on the next signed release), worded as PR #12 words them; **B-43** (lifecycle F4, 30-day
  sign-in), **B-44** (lifecycle F5, a token per server update), **B-45** (App Store Connect app
  record, a person's step from `docs/release.md`).
- Open issues: none (`gh issue list -R passioncode-ai/fabric-inbox`, 2026-10-04). Open PRs: #12 only.

## Checks run

`npm test` exit 0 (495 tests, 494 pass, 1 skipped); `npm run typecheck` exit 0; `git diff --check`
exit 0; the workspace collector (`lib/backlog.mjs` `collectBacklog`, fabric-workspace `origin/main`)
reads 47 tasks from the two boards with no source error.

## Exact next task

The coordinator rebases PR #12 onto `main`. On the board conflict, keep `main`'s B-41/B-42 rows (the
same text, now with a status) and drop the branch's copies. Run the gate and land it. Then close
B-46 with the merge commit.
