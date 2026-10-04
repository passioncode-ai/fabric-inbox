# Documentation map

One home per question. Everything not listed as current is history: kept for its evidence,
not for what to do next.

| Question | Home (current) |
|---|---|
| Where does the next agent start? | [Release entry](app-store/README.md) — its "Exact next task" is the only one |
| What is planned, in which order, and what is done? | [Roadmap](app-store/tasks/2026-09-28-roadmap.md) (tracks P, L, W and their statuses) |
| What did the latest run change and verify? | [Run brief 2026-09-28](app-store/tasks/2026-09-28-agents-triage-run.md) and its [audit](app-store/audit-2026-09-28.md) |
| How does it work? | [Architecture as built](architecture.md); target proposal: [desktop-mail/architecture.md](desktop-mail/architecture.md) |
| How is it configured and deployed? | [Setup](desktop-mail/setup.md) (configuration reference, project addresses, agents, deployment order) |
| How does an agent work with it (MCP)? | [The agent protocol](agents/mcp.md) (connect, levels, two steps, every tool); the skill: `plugins/fabric-inbox/` |
| What must the interface do? | [UX scenarios](ux/scenarios.md), [flows](ux/flows.md), [screens](ux/screens.md) |
| How does it sound? | [Brand pack](brand/README.md) |
| What is open outside the roadmap? | [Board](evidence/backlog.md); lessons in [retro](evidence/retro.md) |
| How is a release cut and published (CI signing, disk image, notarization, Mac App Store upload, GitHub release)? | [Release procedure](release.md) and [`release.yml`](../.github/workflows/release.yml); notes per version in [CHANGELOG.md](../CHANGELOG.md) |
| How is the Mac App Store package built? | [MAS procedure](app-store/mas.md) |
| What was decided about delivery? | [Architecture options → decision 2026-09-28](app-store/architecture-options.md#decision--operator-2026-09-28) |
| Where does a deployment's own configuration live, and what must never be committed? | [deployments/README.md](../deployments/README.md) (local, git-ignored `deployments/<name>/`; placeholder examples); this change: [handoff 2026-09-30](handoffs/2026-09-30-public-redaction.md) |
| Under which licence is it, and what came from elsewhere? | [README → License](../README.md#license), [third-party notices](../THIRD_PARTY_NOTICES.md) (Cloudflare's Agentic Inbox template, super-ux scripts); this change: [handoff 2026-09-30](handoffs/2026-09-30-agpl-licence.md) |
| What runs on the Mac, when, and what does a build leave behind? | [AGENTS.md → Lifecycle](../AGENTS.md#lifecycle) (resident processes, idle budget, fuses, profile, retention); this change: [handoff 2026-10-03](handoffs/2026-10-03-lifecycle-contract.md) |

## History (do not follow as instructions)

- `desktop-mail/README.md`, `implementation.md`, `evidence.md`, `brief.md`, `tasks/README.md` —
  the first implementation (T00–T08, REQ-001–009) at `fe7f2c7`.
- `desktop-mail/workbench-*.md`, `unified-api.md` — the unified workbench packet.
- `app-store/tasks/{mas,drafts,attachments,attachment-composer,mail-actions}.md` and their
  `*-report.md` — release packets done before 2026-09-28; commits outside `main` are reachable
  through the `archive/*` tags.
- `app-store/tasks/remaining-features.md` (R1–R8) — superseded by the roadmap: R1/R2 → L1,
  R3 → L4, R5 → P2–P4, R7/R8 → W1 and release.

Status authority is the roadmap; the T, REQ and R tables above are frozen.

## Checks for documentation

- Links: every relative link and anchor resolves (checked 2026-09-28 across `docs/` and the
  README with a script; see the run brief).
- `python3 docs/ux/lint.py`, `python3 docs/ux/doctor.py`, `python3 docs/brand/lint.py`.
- `git diff --check`.
- Product checks: `npm test`, `npm run typecheck`, `npm run build`; hosted CI
  (`.github/workflows/ci.yml`) runs them with the UX and brand lints on every pull request and on
  `main`.

Shared registers are edited under an agent-sync lease ([AGENT_SYNC.md](AGENT_SYNC.md), generated
from `.claude/agent-sync.json`). No code graph is built.
