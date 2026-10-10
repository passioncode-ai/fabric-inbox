# Fabric Inbox — Mac App Store release

Objective: complete the approved mail scenarios and ship a usable macOS client through App Store review. Operator requested this on 2026-09-27. This is the durable release entry; no store submission or approval has occurred.

Baseline: [3d67ada](https://github.com/passioncode-ai/fabric-inbox/commit/3d67ada3043aebaa2897298948a1b8e22a0a1151), [previous handoff](../desktop-mail/workbench-handoff.md), [scenario contract](../ux/scenarios.md). Product is a remote Cloudflare workspace client today, not a public multi-tenant mail service. Gmail and Cloudflare implementations exist but real provider acceptance is unobserved.

## Decisions and dependencies

Confirmed by existing instructions: macOS desktop, all accounts plus single-account scope, Fabric white/dark themes, original deployment preserved, commit/push authorized. The repository is now public; deployment-specific state remains local-only. Current user request authorizes completing missing functionality and pursuing release. Existing scenarios are the scope baseline, not a claim of completeness.

Pending operator answers: public ready-to-connect client versus own-server client; Apple Developer team and App Store Connect access; free/paid/subscription. These block architecture-dependent onboarding, billing and actual submission, not independent mail reliability or packaging work. No Apple legal agreement will be accepted on behalf of the operator.

Measured 2026-09-27: `security find-identity -v -p codesigning` returns one Developer ID Application identity (the owner's team), no MAS distribution identity. **Since 2026-10-03 the store identities exist, for CI only:** a Mac App Distribution and a Mac Installer Distribution certificate and the Fabric Inbox Mac App Store profile (`ai.passioncode.fabric-inbox`, expires 2027-10-03) are secrets of this repository's protected `release` environment, used by [`release.yml`](../../.github/workflows/release.yml) and on no machine ([release procedure](../release.md#mac-app-store)). `xcode-select -p` resolves installed Xcode. This does not prove current program membership or App Store Connect role. Free disk was initially 1.3 GiB, later 10 GiB (`df -h .`); packaging rechecks capacity rather than relying on either snapshot.

## Requirements and acceptance

| ID | Requirement | Baseline / next evidence |
|---|---|---|
| REL-01 | Install, connect personal accounts and reconnect without another user's mail being visible. | Architecture choice pending; current Access users share workspace; live provider acceptance required. |
| REL-02 | Cloudflare, Gmail and other accounts have honest capabilities, sync and source identity. | Two adapters exist; generic IMAP/SMTP and Outlook missing. Provider matrix and test accounts needed. |
| REL-03 | Keep multiple independent drafts and uncertain send attempts through restart. | Independent versioned drafts, conflict detection, migration and uncertain-send recovery implemented; restart observed on synthetic drafts. Server draft sync remains absent. |
| REL-04 | Send/reply/forward with To/Cc/Bcc and attachments, preserving thread and selected sender. | To/Cc/Bcc and immutable local file bytes implemented with 10-file/5-MiB limits, source-file forward checks and pending-capture blocking. Real provider acceptance and Reply all/full threads remain open. |
| REL-05 | Read safely, search, organize and use mail through temporary connectivity loss. | Read/archive/star/soft trash/restore, external-image permission, read-on-open and Focus triage (important first, collapsed groups, unread and group filters) implemented. Cached search remains limited; bulk operations and offline mail absent. |
| REL-06 | Explain/draft with AI, dry-run/pause rules, approve external actions and inspect history. | Cloud rules, and reusable versioned agents on project addresses with a reply policy, granted MCP tools and a run history (roadmap P2–P5) implemented and tested in workerd. No real model call, live evals or consent wording yet. |
| REL-07 | Desktop integration works in Apple's sandbox with explicit capability limits. | Notifications, mailto and device tools missing. Arbitrary process execution cannot be assumed available in MAS. |
| REL-08 | Produce a verified MAS package from an exact source revision; never label unsigned/dev output submit-ready. | Exact-source MAS preflight/build/sign/verify scripts and tests implemented; since 2026-10-03 the `mas` job of [`release.yml`](../../.github/workflows/release.yml) builds and signs the package with the CI-only identities and profile, and uploads it when a release publishes. No signed package observed yet (the rehearsal waits for approval); the App Store Connect app record exists since 2026-10-03 (Apple id `6818818207`, SKU `fabric-inbox`); signed sandbox acceptance is absent. |
| REL-09 | Privacy/support, review access, metadata and screenshots describe measured shipping behavior. | Product page live; privacy disclosures, review environment and App Store metadata incomplete. |
| REL-10 | Real account isolation, delivery, failures, upgrades and clean install pass before upload and release. | Local gate green on the latest run — the count and commit are recorded once, in the [run brief](tasks/2026-09-28-agents-triage-run.md#checks-actually-run). No live mail acceptance or store review. |

## Execution order

1. Independent first group: [MAS packaging](tasks/mas.md) and [multiple drafts](tasks/drafts.md); controller inventories remaining provider/runtime contracts and release risks.
2. Resolve onboarding/hosting and monetization answers; record architecture, provider plan, UX changes and bounded packets.
3. Complete mail feature packets (attachments/addressing, organization, offline/reconnect), then unified AI and sandbox-compatible tools.
4. Configure isolated real-provider environment; verify with controlled accounts and messages, fix failures, complete privacy/review content.
5. Build and verify store-signed candidate, upload to App Store Connect, TestFlight/acceptance, submit review; update public product links only when accurate. Apple review timing and acceptance are external dependencies.

Every row stays open until evidence exists. A package script is not a signed build; upload is not approval; approval is not a live release. The local gate (`npm test`, `npm run typecheck`, `npm run build`, UX lint) is the check; since 2026-10-01 `.github/workflows/ci.yml` runs it again on every pull request and on `main`, and a missing or skipped run is not a passing one.

## Work isolation and delivery

Controller (history): linked worktree `fabric-inbox-workbench`, branch `codex/app-store-release`; since 2026-09-27 all work lives on `main` and the linked worktrees are removed. Each implementer gets its own worktree. Shared registers are edited under an agent-sync lease since 2026-09-30 ([AGENT_SYNC.md](../AGENT_SYNC.md)). Pipeline build skill requests bounded subagents, so these are authorized by that instruction. Existing model inherited, no override. Root writes this entry/scenario integration; agents own exclusive modules. No automatic loop is armed. Credentials, local configs, dependency trees and binaries stay local only.

### Release signing moves to CI (2026-10-03)

From here on a release is built only by [`release.yml`](../../.github/workflows/release.yml) in the
protected `release` environment (organization decision, 2026-10-03): approval by a person from
`release-approvers`, who may be whoever pushed the tag (amended the same day; an agent never
approves); the disk image with the CI Developer ID, the app and
then the image notarized through the shared action; attested, `SHA256SUMS` GPG-signed, published;
the Mac App Store package signed with the CI-only store identities and uploaded when publishing.
The by-hand procedure the releases below followed is retired; a locally signed build is a debug
build. Procedure: [docs/release.md](../release.md). Open: the first rehearsal's signing jobs wait
for an approver (human step 5). The App Store Connect app record exists (human step 6, done 2026-10-03).
Next on this path, after human step 5: read the rehearsal run (both notarization submissions
Accepted; the `signed-release-<tag>` artifact with `SHA256SUMS.asc`; the `mas-pkg-…` artifact with a
`signed-package-local-checks-passed` receipt) and record it here. After human step 6 the next
published release uploads its store build.

### Release 0.8.2 — the second pass (2026-10-01)

[GitHub release v0.8.2](https://github.com/passioncode-ai/fabric-inbox/releases/tag/v0.8.2), from
`6791c61` on the public `main` (PR #7). What was found and fixed — the live server's lost message,
forgeries against Never spam, seven core bugs, the relay rotation —
[accounts brief → Second pass](tasks/2026-09-30-cloudflare-accounts.md#second-pass-2026-10-01-082).

| What | Receipt |
|---|---|
| Gates on `6791c61` | `npm test` 451 pass / 0 fail (exit 0), `npm run typecheck` 0, `npm run build` 0, UX lint 0, doctor 0, brand lint 0 errors, `git diff --check` 0; backlog and CHANGELOG edited under agent-sync leases |
| Image | `Fabric-Inbox-0.8.2.dmg`, 251 927 726 bytes, sha256 `a808dd6fada61324b1b00cfbc2ebd59a441f9e924444040230a9805b979e152a`; public build, 0 of 73 owner identifiers in `app.asar`; submission `e2a5dcde-4e8e-4464-962c-c9dc4e5bca82` Accepted, stapled |
| Download and installed copy | `shasum -a 256 -c` OK; `spctl` → `source=Notarized Developer ID`; `stapler validate` on app and image; `check-installed-app.mjs` exit 0 (`fabric-inbox 0.8.2`, 65 tools, 403 without Access) |
| The owner's server | deployed from `6791c61`, version `4485c31d`, three token secrets kept; its Workers log for the two hours after: no invocation ending other than `ok`, no 5xx |

### Release 0.8.1 — the review of several accounts (2026-10-01)

[GitHub release v0.8.1](https://github.com/passioncode-ai/fabric-inbox/releases/tag/v0.8.1): the
disk image, its `.sha256` and the build receipt, from `3909782` on the public `main` (PR #4). What
the review found and fixed: [accounts brief → Review 2026-10-01](tasks/2026-09-30-cloudflare-accounts.md#review-2026-10-01).

| What | Receipt |
|---|---|
| Gates on `3909782` | `npm test` 446 pass / 0 fail (exit 0; 15 new tests, a planted defect caught for each high finding), `npm run typecheck` 0, `npm run build` 0, UX lint 0, doctor 0, brand lint 0 errors, `git diff --check` 0 |
| Image | `Fabric-Inbox-0.8.1.dmg`, 251 922 400 bytes, sha256 `728948b1b0f71a324a774634cf850b67d9a9fa97256c0fdcf75e6bfdd5a914b5`; public build (no setup), 0 of 73 owner identifiers in `app.asar` |
| Signing and notarization | Developer ID Application, hardened runtime, `x86_64 arm64`; image submission `72463885-e897-4063-8032-0efd302e9ad4` Accepted; app and image stapled |
| Download as a teammate | `gh release download v0.8.1 …`, `shasum -a 256 -c` OK |
| Installed copy (temporary folder) | `spctl -a -vv -t execute` → `source=Notarized Developer ID`; `stapler validate` on app and image; `CFBundleShortVersionString` 0.8.1 |
| Its agent protocol | `node scripts/check-installed-app.mjs` exit 0: server bundle 0.8.1 (`3909782`), `initialize` → `fabric-inbox 0.8.1`, `tools/list` → 65, without Access → 403, no outbound request but the Access stand-in's key set |
| The owner's server | deployed from `3909782`, version `50e73435`; its three Cloudflare token secrets kept |
| Tag | `v0.8.1` names `3909782`, checked to be on the public `main` before it was pushed (retro instruction 9) |

Not checked: the screen and a relay delivery on the owner's server (B-39).

### Release 0.8.0 — several Cloudflare accounts (2026-09-30): built, withdrawn

The 0.8.0 tree is `a9f9516`, the root commit of the public `main`. What changed: [CHANGELOG](../../CHANGELOG.md);
decisions, contracts and the REQ table: [accounts brief](tasks/2026-09-30-cloudflare-accounts.md).

**The GitHub release was published and then withdrawn the same night.** The repository had been
re-created public with a one-commit history minutes earlier; the release's tag pointed into the
private history and pushing it uploaded that history. The tag, the release and a docs branch were
deleted; GitHub still serves those commits by SHA until they are purged (human step 4 below). The
image below is kept on the release machine and is published again once the history question is
settled, on a tag in the public history (rebuilt there, so its receipt names that commit).

| What | Receipt |
|---|---|
| Image (built from the same tree, not published) | `Fabric-Inbox-0.8.0.dmg`, 251 906 800 bytes, sha256 `98ea03525df9b390d4f0ff149e71dd27f72bdc90f79a56b58088ac7c40008426`; public build (no setup), 0 of 73 owner identifiers in `app.asar` |
| Signing and notarization | Developer ID Application, hardened runtime, `x86_64 arm64`; image submission `795bc06d-e697-4d2c-8d5d-9b89f3d4cd4f` Accepted; app and image stapled |
| Download as a teammate (while published) | `gh release download … --pattern 'Fabric-Inbox-*.dmg' --pattern 'Fabric-Inbox-*.dmg.sha256'`, `shasum -a 256 -c` OK |
| Installed copy (temporary folder) | `spctl -a -vv -t execute` → `source=Notarized Developer ID`; `stapler validate` on app and image; `CFBundleShortVersionString` 0.8.0 |
| Its agent protocol | `node scripts/check-installed-app.mjs` exit 0: server bundle 0.8.0, `initialize` → `fabric-inbox 0.8.0`, `tools/list` → 65 tools, `list_accounts` → none; without Access → 403; no outbound request but the Access stand-in's key set |
| The owner's server | runs the 0.8.0 tree, version `1d8af191`; secrets `CLOUDFLARE_API_TOKEN` (reissued with Access: Service Tokens) and one `CLOUDFLARE_API_TOKEN_<account id>` for each of the two other accounts, all from the Observatory door; each token probed with its own rights; unauthenticated relay and API paths → the Access login |

Not checked: the new screen and a relay delivery on the owner's server (B-39, human step 3).

### Release 0.7.1 — the first published release (2026-09-30)

GitHub release v0.7.1: the disk image, its `.sha256` and the build receipt. It is no longer
served: the repository was re-created public with a fresh history on 2026-09-30 (see 0.8.0 above),
and on 2026-10-01 `releases/tag/v0.7.1` answers 404; the first release in the public history is
[v0.8.1](https://github.com/passioncode-ai/fabric-inbox/releases/tag/v0.8.1). The tag and the image come from `9b6d273` on
`main` (PR #5). 0.7.1 and not 0.7.0: the `v0.7.0` tag names `c37dee0`, whose Mac app carried 0.6.2
([CHANGELOG](../../CHANGELOG.md)). Procedure: [docs/release.md](../release.md).

| What | Receipt |
|---|---|
| Image | `Fabric-Inbox-0.7.1.dmg`, 251 924 163 bytes, sha256 `110ff9fcffa0d14d5a4f8b263cf129d1d1f72a72df2a0ea8a8278944cbffe660`; public build (no setup), 0 of 64 owner identifiers in `app.asar` |
| Signing | Developer ID Application (the owner's team), hardened runtime; `codesign --verify --deep --strict` valid; universal (`x86_64 arm64`) |
| Notarization | app `Fabric Inbox.zip` `2d7e3492-154a-4581-85ec-85e040a67d32` and image `Fabric-Inbox-0.7.1.dmg` `33ed8678-6b90-4806-9c7d-b97cee77ec61`, both Accepted; both stapled (`stapler validate`) |
| Gatekeeper | `spctl -a -vv -t execute` on the app and `-t open --context context:primary-signature` on the image: accepted, `source=Notarized Developer ID` |
| Download as a teammate | in an empty folder, `gh release download -R passioncode-ai/fabric-inbox --pattern 'Fabric-Inbox-*.dmg' --pattern 'Fabric-Inbox-*.dmg.sha256'` exit 0; `shasum -a 256 -c` OK, exit 0 |
| Installed copy | copied from the downloaded image into a temporary folder (not `/Applications`): `spctl` exit 0, `stapler validate` exit 0, `CFBundleShortVersionString` 0.7.1 |
| Its agent protocol | `node scripts/check-installed-app.mjs "<folder>/Fabric Inbox.app"` exit 0: its server bundle (0.7.1, `9b6d273`) at `http://127.0.0.1:<port>/mcp` answered `initialize` → `fabric-inbox 0.7.1`, `tools/list` → 62 tools, `list_accounts` → no accounts, Gmail not configured; `initialize` without Access → 403; no outbound request but the Access stand-in's key set |
| Its launch | `--user-data-dir=<temp>` with that server's origin: ran as its own instance (3 helpers on the temporary data folder), requested `GET /` from the server (403, no Access sign-in in the check), quit by pid (exit 0), no process left, unregistered from Launch Services; the operator's installed copy kept running and its data folder's times were unchanged |

A trial build from the branch stopped on the builder's new Gatekeeper check (`source=null`):
`spctl` prints its verdict to stderr ([retro](../evidence/retro.md)). Fixed before the release.
Not checked: an MCP session against a real Cloudflare server from this image. The owner's server
still runs 0.7.0 and was not touched; an agent key still needs human step 1 below.

### State at pause (2026-09-29)

The operator moved the work to the Fabric repository, where the family's overall vision is being
written; this repository was left at a clean stop. Everything is committed and pushed on `main`
(last code commit d84ee43), the server runs 0.7.0 (`b06434a5`), and the owner's Mac runs the 0.7.0
app. Nothing is half-done in the tree.

- **Where things stand.** 0.6.0 spam and one path for mailboxes; 0.6.1 the sidebar filter and the
  reliability and update audits; 0.6.2 an agent waits for a stranger's spam check (B-30); 0.6.3
  numbered schema steps for the other Durable Objects (B-32); **0.7.0 the agent protocol** — every
  function of the app over MCP at `/mcp`, agent keys as Access service tokens (read / mail / admin),
  two steps for irreversible actions, a journal, the Agent access screen, and the skill
  `working-with-fabric-inbox` ([agent protocol](../agents/mcp.md), [brief](tasks/2026-09-29-agent-protocol.md) with its security review and release receipts).
- **The rule that now binds every change:** a route is not done until its agent tool, the
  generated reference and the skill agree — `AGENTS.md`, held by `npm test`.
- **Where it was going.** Accept the agent path live, publish the skill in the PassionCode set,
  then the board from the top: B-21 (the same search for both providers), B-19, B-20, B-38 (the
  owner approves an agent's irreversible actions), B-35–B-37 (agent protocol follow-ups).
- **Read first:** this file → [docs/agents/mcp.md](../agents/mcp.md) → the [agent-protocol brief](tasks/2026-09-29-agent-protocol.md) → [architecture](../architecture.md) → [board](../evidence/backlog.md). Checks: `npm ci && npm test` (396) `&& npm run typecheck`, the UX and brand lints (`AGENTS.md`).

**Human steps** (each needs a person; everything after them an agent does):

1. ~~Add Access: Service Tokens to the server's token~~ — done 2026-09-30 without a person: the
   Observatory door issued the server a new token with it (preset `fabric-inbox-server`,
   passioncode-ai/project-observatory-dashboard#93) and the old one was revoked.
2. Add the repository secret **`MEMBERS_READ_TOKEN`** to `passioncode-ai/passioncode`: a
   fine-grained token with Contents: read on `passioncode-ai/fabric-inbox`, entered in your own
   terminal (`gh secret set MEMBERS_READ_TOKEN -R passioncode-ai/passioncode`), never in a chat.
3. **0.8.0 in your app** (B-39): quit and reopen Fabric Inbox (the open window keeps the page it
   loaded before the deploy), open Settings → Domains, and **Receive mail here** on the domain
   that failed with "must be a subdomains". Then say which domain of another account should be the
   first to receive through the relay: its routing changes.
4. **The private history in the public repository.** Commits of the private history (up to the
   0.8.0 docs, including those that held the owner's deployment before it left the tree) are no
   longer on any ref but GitHub still serves them by SHA. Either ask GitHub Support to purge the
   repository's unreachable objects, or re-create the repository and push only the public `main`.
   Until then, do not push a tag or branch whose history is not the public `main`.
5. **Approve the release rehearsal** (any member of `release-approvers`, whoever pushed the tag
   included; never an agent):
   the newest `release` run on a `v*-rc.*` tag waits in "Review deployments" for its `macos`,
   `mas` and `publish` jobs. A rehearsal publishes nothing and uploads nothing.
6. ~~**Create the App Store Connect app record**~~ — done 2026-10-03: "Fabric Inbox", Apple id `6818818207`, SKU `fabric-inbox`, en-US, macOS.
   The API cannot create a record; a publishing run's `mas` job checks for it first.

Exact next task: **review and merge [PR #51](https://github.com/passioncode-ai/fabric-inbox/pull/51), the Windows and Linux desktop app** (operator, 2026-10-09: "адаптацию сборки под Windows, чтобы всё корректно работало. И под линукс тоже"; board B-75; fabric-workspace `knowledge/platforms.md` PL-01…PL-08). Branch `agent/win-linux-port`. Done there: Windows/Linux runtime (menus, connect-dialog listener via netstat/ss, taskbar flash, PL-05 Secret Service refusal), `desktop/dist-platform.mjs` (per-user NSIS, AppImage, `.deb` to `/opt/fabric-inbox`), updates through the verified installer or AppImage (`desktop/platform-installer.cjs`, `tests/desktop-update-platform.test.ts`), release jobs and per-platform feeds (`release.yml` `windows`, `linux`, `update-check-platforms`), docs ([desktop-data-and-updates → Windows and Linux](../desktop-data-and-updates.md#windows-and-linux), [release](../release.md)). CI `platforms` builds, installs and launches each on its own runner; the Windows ARM64 install is the last one being proven (BCJ payload filter, `8feca15`) — read the latest `platforms` run on the PR before merging. Then: (1) cut the next version with all four platform files (docs/release.md; the CHANGELOG says Windows installers are unsigned); (2) B-76 — Windows Authenticode waits for the organization's Azure identity validation (a person), then the `release` environment's `AZURE_*` variables. Before this, the next task was: **build the Nicegram support agent on support@nicegram.me** (done 2026-10-09 on the server: agent `nicegram-support` v2, collections `nicegram-help` and `nicegram-product`). (operator, 2026-10-09: a reply agent that answers by itself, with a knowledge base from the product site and FAQ, the community questions nicegramappbot collects and the Nicegram data room, and instructions on how to hold the conversation and which tools to call when). 0.13.0 is published ([release](https://github.com/passioncode-ai/fabric-inbox/releases/tag/v0.13.0), run [37843294081](https://github.com/passioncode-ai/fabric-inbox/actions/runs/37843294081): `gate`, `macos`, `mas`, `update-precheck`, `publish`, `update-check` all green; merge `84f6759`, PR #46). Checked on 2026-10-09 from the download: GPG `Good signature` (PassionCode.ai releases, EDDSA 63B30DC3…), `shasum -c` OK for all four files, `gh attestation verify … --signer-workflow passioncode-ai/.github/.github/workflows/release-publish.yml` exit 0 for the image and the zip, Gatekeeper `Notarized Developer ID` (KJ35UYYL22), staples valid on the app and the image, app version 0.13.0, `check-installed-app.mjs` exit 0 (89 tools, refused without Access), update feed `currentRelease` 0.13.0 with the zip's sha256 (`4ea5e19e…`). The server already runs the same code and more (PR #47, #48; Worker `62a84a5b`). Open from before: the agent signals server waits for the Heroku app (sshlg-fabric-server README), the owner's installed app picks 0.13.0 up by itself (LC-16).

Before 0.13.0 was published, the next task was: **release the Mac app with PR #41's fixes** — merged as `8a08773` and the server is already deployed from it (2026-10-08: Worker version `69779f15`, the owner's server moved from 0.9.0 code to 0.12.0 code, `MAIL_CREDENTIAL_KEY` added; 89 tools, read sweep clean; board B-63…B-74). In order: (1) confirm **B-74** live on the next copy a forwarding address sends (j1@sshlg.me had 5 failures before the deploy); (2) re-run `/ux-audit` on the touched scenarios (SCN-005…016, 020, 022, 025, 039…047, 050, 053, 057, 060, 065) and record the verdicts; (3) cut the next version per `docs/release.md` (CHANGELOG section, tag, approvals) so the desktop parts reach the app (connect prompt B-65, AI panel, settings); (4) **B-70**, the agent console, together with the shared signal API the operator asked for on 2026-10-08 (an agent or rule calls it for urgent mail; it is a remote MCP host, so `AUTOMATION_MCP_HOSTS` must name it). The 0.12.0 acceptance below is still open.

Before the UX-audit fixes, the next task was: **accept 0.12.0 live** — 0.12.0 is published ([release](https://github.com/passioncode-ai/fabric-inbox/releases/tag/v0.12.0), run [37557722147](https://github.com/passioncode-ai/fabric-inbox/actions/runs/37557722147): `gate`, `macos`, `mas`, `update-precheck`, `publish`, `update-check` all green; merge `44af31f`, PR #37). Checked on 2026-10-07 from the download: GPG `Good signature` on `SHA256SUMS`, `shasum -c` OK for all four files, `gh attestation verify … --signer-workflow passioncode-ai/.github/.github/workflows/release-publish.yml` exit 0 for the image and the zip, Gatekeeper `Notarized Developer ID` (KJ35UYYL22), staple valid, `ElectronSquirrelPreventDowngrades` true, `node scripts/check-update-release.mjs --dir <download> --version 0.12.0` passes. Left: (1) **B-51** — the owner's installed 0.11.0 (running since 2026-10-06 15:50, no window) finds 0.12.0 when its window next comes forward, downloads it in the background and installs it at quit; confirm `~/Library/Caches/ai.passioncode.fabric-inbox.ShipIt/` stages it, then that `/Applications/Fabric Inbox.app` reads 0.12.0 after the quit; (2) **B-42** — that first 0.12.0 start asks for no Keychain password; (3) release events in usage counts after it; (4) the first release after 0.12.0 proves the verified hand-off (`file://` feed, LC-16) end to end; (5) the store build waits for more features before App Review (operator, 2026-10-06); (6) the live acceptances that need a person's accounts — B-55, B-56, B-57.
Before 0.12.0, the next task was: **finish and release 0.12.0** (done: PR #37). Before that: **accept 0.11.0 live** — 0.11.0 is published ([release](https://github.com/passioncode-ai/fabric-inbox/releases/tag/v0.11.0), run [37448640790](https://github.com/passioncode-ai/fabric-inbox/actions/runs/37448640790); GPG signature, checksums, attestations with the organization's signer workflow, Gatekeeper `Notarized Developer ID`, staples, `check-installed-app.mjs` (server 0.11.0 at `56ce103`, 80 tools, 403 without Access), the update feed and passioncode.ai/inbox all checked on 2026-10-06; the store package 11.0.99 was uploaded). Left: the upgrade check on the owner's Mac once the person quits the installed 0.8.2 (B-42), release events in usage counts after that launch, submitting the store build for App Review (a person), and the live acceptances that need a person's accounts — Gmail wizard (B-55), Outlook after the Entra registration (B-56), IMAP with real app passwords (B-57). Before 0.11.0, the next task was: **accept 0.8.0 live (B-39)** — after human step 3, read the Cloudflare accounts
section (three accounts, all with mail), the failed domain's steps, and for the chosen domain of
another account the `relay` step, a real message arriving through it and a reply leaving; record
the receipt in the [accounts brief](tasks/2026-09-30-cloudflare-accounts.md). Then merge the door's
PR #93 in `passioncode-ai/project-observatory-dashboard` under its release process. After that, the
earlier next task: **accept the agent path live and publish the skill.** Now that the server can make service tokens: in
Agent access make a temporary Mail · Drafts only key; connect an MCP client with its two headers;
run `list_accounts`, `list_messages`, `read_message`, `save_draft`, and a refused `send_email`; see
them in What agents changed; revoke the key and confirm it is refused; record the receipt in the
brief. After human step 2: bring `agent/fabric-inbox-member` (8c0e449, which vendors the 0.7.0
skill) up to the `v0.7.1` skill, merge it into `main` of `passioncode-ai/passioncode`, tag `v0.1.8`, read the release run's verdict, then
`npx @passioncode-ai/passioncode@latest update` on the owner's machine and restart the agents. Then **B-21** (search the same text for both providers), **B-19** (a first run of Create my server on a new Cloudflare account) and **B-20** (knowledge from Fabric memory once MEM-P2 ships). 0.6.1 added the sidebar filter (With mail / All, hidden addresses) and closed two audits — how the server keeps mail (no loss to size, a stuck journal, a cut-off delivery or a restart) and how it is updated (every setting kept, no downgrade, no destructive storage step, the spam clock fixed): the [reliability-and-updates brief](tasks/2026-09-29-reliability-and-updates.md). 0.6.0 added a spam filter (lists, Cloudflare's authenticity results and the model for strangers; a Spam folder with reasons; Report spam / Not spam; Spam rules; 30 days) and made creating and removing a mailbox one path through Cloudflare, closing an 18-finding audit of mailbox management: the [spam-and-mailboxes brief](tasks/2026-09-29-spam-and-mailboxes.md) lists each with its fix, its test and what the installed app showed. Before it, 0.5.0 added categories ([categories brief](tasks/2026-09-29-categories.md)), 0.4.0 knowledge collections ([knowledge brief](tasks/2026-09-29-knowledge.md)) and 0.3.0 the Cloudflare work ([Cloudflare plan](tasks/2026-09-28-cloudflare-complete.md); all 19 owner domains receive here and send; the pilot receipt is kept with the owner's deployment record outside the repository, see [deployments](../../deployments/README.md)). Open work is on the [board](../evidence/backlog.md). Still open from the [roadmap](tasks/2026-09-28-roadmap.md#p6--deploy-and-live-acceptance): Gmail acceptance; L1 (IMAP accounts on the Mac) once app passwords exist. The delivery model was decided on 2026-09-28 ([decision](architecture-options.md#decision--operator-2026-09-28)); seller/team and pricing remain open.

## First integrated checks

At source 7221353, production lockfile audit reports zero known production advisories after targeted compatible updates; installed-tree 124 tests, typecheck and client/worker build passed. [Dependency update receipt](dependency-update.json) records exact package changes. No --force or --legacy-peer-deps used; broad audit-fix dry-run failed a Wrangler/types peer constraint, so it was not applied. Signing/profile validation was implemented, not a signed app: [MAS record](mas.md). [Draft report](drafts-report.md) and [attachment transport report](attachments-report.md) record bounded agent checks; controller CUA observed two independent drafts surviving reload and per-message image permission at the synthetic 5190 fixture.

Integrated: [attachment composer](attachment-composer-report.md), [mail organization](mail-actions-report.md), per-message privacy and capture-race recovery. See [final verification](verification.md), [independent review](review.md), [architecture proposal](architecture-options.md) and [remaining packets](tasks/remaining-features.md). No real provider, production deployment, TestFlight, App Store upload or approval is claimed.
