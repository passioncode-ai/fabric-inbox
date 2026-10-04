# Lifecycle contract handoff — 2026-10-03

## Objective and source

Bring Fabric Inbox under the organization's product lifecycle contract
([knowledge/lifecycle.md](https://github.com/passioncode-ai/fabric-workspace/blob/main/knowledge/lifecycle.md),
LC-01…LC-15), from the 2026-10-03 audit of this product
(`docs/reports/2026-10-03-lifecycle-audit/raw/fabric-inbox.md` in fabric-workspace, findings
F1–F8). Base: `2da771d` on `main`. Branch: `claude/lifecycle-contract`.

## Completed

| Finding | Rule | Change | Held by |
|---|---|---|---|
| F1 cookies in plaintext, stock fuses | LC-13 | `desktop/hardening.mjs`: one `afterExtract` hook flips six fuses on the Electron template in every builder (`dist-mac.mjs`, `mas-package.mjs`, `package.mjs`); `verifyHardening` reads the fuse wire of the built binary (every slice) into the receipt and fails the build otherwise | `tests/desktop-hardening.test.ts` |
| F7 stock purpose strings | LC-07 | the same hook strips `NS*UsageDescription` from the template Info.plist; the built Info.plist is checked against `DECLARED_USAGE_DESCRIPTIONS` (empty) | `tests/desktop-hardening.test.ts` |
| F3 dead partitions per origin | LC-12 | `desktop/profile.cjs`: a server change clears the old partition (storage, cache, `Partitions/` directory) after its window is destroyed; each launch sweeps other servers' partitions and settings leftovers before any window | `tests/desktop-profile.test.ts` |
| F6 Automation polled every 5 s while unfocused | LC-08 | `app/lib/window-activity.ts`, `app/hooks/useWindowActive.ts`: 30 s, only while visible and focused, refresh on return | `tests/window-activity.test.ts` (one hour on a fake clock) |
| F8 3.9 GB of old images; debug launch on the real profile | LC-15, LC-14 | `desktop/release-retention.mjs` called by `dist-mac` and `mas-package`; `npm run clean` (`scripts/clean.mjs`); unpackaged runs use `Fabric Inbox Development`; walks use `--user-data-dir` | `tests/release-retention.test.ts`, `tests/desktop-profile.test.ts` |
| — | LC-09 | `AGENTS.md → Lifecycle`: footprint table, retention line, harness rule | — |

## Not done, and why

- **F2 notifications** — a product decision, not implemented: board **B-41**, awaiting the operator.
- **Silent Keychain item under the Developer ID** — only a signed build shows it. The upgrade check
  is in `docs/release.md` step 7 (step 6 before the merge with `main`) and on the board as
  **B-42**. No build here was signed or notarized, and the built app was not launched: an
  unsigned binary would create the real "Fabric Inbox Safe Storage" item with its own access list,
  which the signed release would then have to ask about.
- F4 (30-day Access sign-in) and F5 (a new token per server update) were not in this packet.

## Verification (local, this branch)

| Check | Result |
|---|---|
| `npm test` | exit 0 — 480 tests, 479 pass, 1 skipped |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `python3 docs/ux/lint.py`, `docs/ux/doctor.py`, `docs/brand/lint.py`; `git diff --check` | exit 0 each |
| `npm run desktop:dmg -- --unsigned` at the first commit of this branch | exit 0; receipt `checks.fuses` = 2 slices hardened, `usageDescriptions` = none; `prunedFromRelease` removed a planted 0.7.0 image and kept 0.8.1 |
| Independent read of that image: `@electron/fuses` `getCurrentFuseWire`, `plutil -p` | `RunAsNode=0 EnableCookieEncryption=1 NodeOptions=0 Inspect=0 AsarIntegrity=1 OnlyAsar=1`; 0 `UsageDescription` keys; `ElectronAsarIntegrity` present; Electron Framework ad-hoc signature verifies |

Planted defects watched: removing the retire call in `loadMail`, or not awaiting the start-up
sweep, fails `tests/desktop-profile.test.ts`.

## Landing, 2026-10-04

`origin/main` (`dcc3879`) was merged into the branch (`a63ce20`), no rebase. Conflicts, each kept
from both sides: `desktop/dist-mac.mjs` (main's `assessImage`/`writeReceipt` refactor; retention
runs before the receipt is written), `desktop/main.cjs` (the profile sweep before any window, then
main's `fabric-inbox://connect` drain), `tests/desktop-policy.test.ts` (the fake `require` serves
both modules), `docs/release.md` (main's CI release flow; the hardening receipt moved to the disk
image's stage 1 and the store build, the upgrade check to step 7), `docs/evidence/backlog.md`
(main's board, which already carried B-41/B-42). `AGENTS.md → Lifecycle` gained a row for main's
connect link; `CHANGELOG.md` gained an `## Unreleased` section for this packet.

Gate on the merged tree: `npm ci`, `npm test` (524 tests, 523 pass, 1 skipped), `npm run
typecheck`, `npm run build`, `npm run mcp:docs -- --check`, UX lint and doctor, brand lint,
`git diff --check` — exit 0 each. No build was signed, and no image was built on this pass.

## Exact next task

Landed on `main` as `dc532a0` (2026-10-04; board B-46 done). At the next signed release, run the
upgrade check in `docs/release.md` step 7 and close B-42 with its receipt; the operator decides
B-41.
