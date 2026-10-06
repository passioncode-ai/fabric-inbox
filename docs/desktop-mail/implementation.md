> **History — do not follow as instructions.** Current entry: [release entry](../app-store/README.md); status authority: the [roadmap](../app-store/tasks/2026-09-28-roadmap.md). This reports the first implementation at `fe7f2c7`; its open items, test count and advisory count are superseded (unified inbox and attachment forwarding shipped since).

# Fabric Inbox first implementation — 2026-09-26

This report describes an initial desktop/cloud implementation, not completion of all REQ-001…REQ-009. Entry and next task: [README](README.md). Requirements and decisions: [brief](brief.md). Scenario coverage: [UX](../ux/README.md).

## Delivered source

| Area | Evidence | Boundary |
|---|---|---|
| Owner | Remote `https://github.com/passioncode-ai/fabric-inbox.git`, branch `main` (was `codex/fabric-inbox` until 2026-09-27); source ancestor `93b86c6c0e5c1e63a100a5d0c421cfaf7cd1102c` | New private repository, original Worker unchanged |
| Mail persistence | [mail core receipt](../../.task-pipeline/build/fabric-inbox/core-report.md), integrated commit `7088d7d` | Cloudflare provider is simulated in tests; acceptance does not prove recipient delivery |
| Gmail | [Gmail receipt](../../.task-pipeline/build/fabric-inbox/gmail-report.md), integrated commit `5930de0` | OAuth/refresh/history/send/draft code tested with fake upstream; no real grant |
| Desktop | [desktop receipt](../../.task-pipeline/build/fabric-inbox/desktop-report.md), integrated commit `bda7683` | Remote web host, not the originally proposed bundled offline renderer |
| Automation | `workers/automation/index.ts:65`, `workers/automation/engine.ts:20`, `tests/automation-integration.test.ts` | Event receipt commits selected rule snapshots atomically; approval bound to resolved proposal/message; interrupted effects become unknown |
| UI | `app/components/settings/sections/AccountsSection.tsx`, `app/routes/gmail-inbox.tsx`, `app/routes/automation.tsx`, `app/routes.ts` | Accounts/per-account reading, rules/history; no combined all-account list |
| Sender recovery | `app/services/api.ts:88`, `app/hooks/useComposeForm.ts:184`, `app/routes/gmail-inbox.tsx:41` | Cloudflare key per compose attempt; Gmail draft/key persists locally. No full Cloudflare offline draft recovery |

## Immutable source snapshot

Implementation commit: `fe7f2c7645c0343c1f889a55dfdd8f93f0286bcf`.

- [Durable rule engine](https://github.com/passioncode-ai/fabric-inbox/blob/fe7f2c7645c0343c1f889a55dfdd8f93f0286bcf/workers/automation/engine.ts#L20)
- [Atomic event ingestion and account adapters](https://github.com/passioncode-ai/fabric-inbox/blob/fe7f2c7645c0343c1f889a55dfdd8f93f0286bcf/workers/automation/index.ts#L65)
- [Gmail draft and send recovery UI](https://github.com/passioncode-ai/fabric-inbox/blob/fe7f2c7645c0343c1f889a55dfdd8f93f0286bcf/app/routes/gmail-inbox.tsx#L41)
- [Provider configuration contract](https://github.com/passioncode-ai/fabric-inbox/blob/fe7f2c7645c0343c1f889a55dfdd8f93f0286bcf/workers/providers/google-oauth.ts#L42)
- [Desktop isolation and navigation](https://github.com/passioncode-ai/fabric-inbox/blob/fe7f2c7645c0343c1f889a55dfdd8f93f0286bcf/desktop/main.cjs#L21)
- [Workerd automation acceptance](https://github.com/passioncode-ai/fabric-inbox/blob/fe7f2c7645c0343c1f889a55dfdd8f93f0286bcf/tests/automation-integration.test.ts)
- [Locked dependencies](https://github.com/passioncode-ai/fabric-inbox/blob/fe7f2c7645c0343c1f889a55dfdd8f93f0286bcf/package-lock.json)

## Checks actually run

| Command / observation | Result | What it does not prove |
|---|---|---|
| `npm test` | 74 passed, 0 failed, 0 skipped | No real email/AI/tool provider call |
| `npm run typecheck` | Exit 0 | Runtime/provider access |
| `npm run build` | Exit 0, client + Worker SSR bundles | Deployment or Access policy |
| `npm run desktop:package -- arm64` | Exit 0, unsigned arm64 app | Signing/notarization, x64 or other OS |
| Native CUA launch of root bundle | Setup → loopback server → Fabric Inbox home observed | Production login |
| Browser `/accounts` | Gmail `not_configured`, Cloudflare directory, unsupported providers explicit | OAuth grant |
| Browser `/automation/<local synthetic mailbox>` | New rule with subject condition saved as Paused/Requires approval; empty runs/outbox; screenshot inspected | Real rule delivery or AI classification |
| `git diff --check` | Exit 0 at integration | Product correctness |

Local synthetic mailbox only; no real messages were sent. The task-created local mailbox was removed after the walkthrough (local DELETE returned 204); its disabled automation rule stays in ignored development storage. The native shell tests also exercised offline retry, privilege isolation and session restart using a synthetic cookie. Its receipt records the discovered startup bug and fix.

Artifact: `release/Fabric Inbox-darwin-arm64/Fabric Inbox.app`. Measured `du -sh`: 287M. SHA-256 of `Contents/Resources/app.asar`: `72578740ba1592270691db8b3d2fa93ecd71f98fec6c4af507a95ef24e07fb17`. The artifact is ignored/local, reproducible from tracked source and packaging command; Git delivery is source and this receipt, not the binary.

## Review findings addressed

Independent automation/UI review found replay after rule edits, approval bound only to a boolean, display-name reply addresses, HTML-only message truncation, volatile Gmail draft/recovery keys and misleading unknown outcomes for known rejections. The implementation now records an incoming event receipt atomically, stores resolved proposals and checks email digests, normalizes reply addresses, renders complete HTML as sanitized plain text, persists Gmail draft/recovery state, and distinguishes known pre-effect rejection. Regression tests cover event replay, changed-message approval and known rejection. A second independent source review verified all six fixes and reran 17 focused engine/workerd tests successfully. Live Gmail UI sending remains unverified.

## Open acceptance and release blockers

- OAuth client/configuration, owner consent and controlled live mailboxes. No personal account content or credentials were read. Current Google grant UI is a prerequisite, not a coding test fixture.
- Additional providers: Outlook/IMAP adapters are not built. The owner has not supplied the service inventory. The promise “all my accounts” remains open.
- Combined inbox, full thread UI for Gmail, all attachment-send/forward paths, mailto, local device tools, offline mailbox cache and Cloudflare composer recovery. Gmail manual forwarding is visibly text-only; automated forwarding rejects attached messages before transport.
- Agent budgeting is an action count per rule/day, not a dollar meter; a classifier quality/injection evaluation corpus and real model acceptance remain open. Legacy inbox draft behavior is retained. No automatic retry of unknown effects.
- Cloudflare Access remains a shared-workspace boundary. Unified per-agent grants across inbound MCP/manual UI/rules are not complete; the same send journal alone does not establish that broader policy.
- Journal/body retention and large-account performance need policy and load verification. External IdP desktop SSO transfer, code signing, notarization and auto-update remain open.
- Dependency advisories require release review; see the final dependency audit receipt below. Successful tests do not clear audit findings.

No production deployment, package publication, hosted CI dispatch or merge occurred. Nightly CI policy was respected; local focused checks are the evidence here.

## Dependency audit receipt

`npm update hono react-router @react-router/dev drizzle-orm --ignore-scripts` updated two packages; React/React DOM were then aligned at 19.3.0 and React Router/dev at 7.18.4 to clear the direct router advisory chain. Typecheck, all 74 tests and build passed again; the Accounts screen rendered after restarting dev. Final `npm audit --omit=dev --json` reports 50 production advisory entries: 9 high, 36 moderate, 5 low, 0 critical. No direct dependency is classified high/critical in that final audit; transitive findings remain. This command remains nonzero; no clean-security claim is made. The computed [JSON receipt](dependency-audit.json) records package names/severity/fix availability without secrets. Advisory remediation remains a production-release prerequisite, including transitive chains; no forced major-version upgrade was applied.

## Skills actually used

The route followed the operator's standing instructions; implementation lives in its owning repository. Skill sources: task-pipeline 1.87.0 (`SKILL.md`, `references/build.md`), super-ux 0.56.2 (foundation/flows/scenarios/brand-voice/copywriting), a design skill (1.61.0), agent-stack 0.25.2 (orchestrator/interop), google-auth and evidence-docs. Task-pipeline's stage-five instructions explicitly required the bounded subagents. There was no unrelated repository mutation or copied registry or lease from another project.
