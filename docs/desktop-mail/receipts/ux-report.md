# Fabric Inbox UX chain handoff

Objective: formalize the approved desktop mail and cloud automation brief before new UI work. Entry point: [docs/ux/README.md](../../../docs/ux/README.md). Shared scope and contracts: [brief](../../../docs/desktop-mail/brief.md), [architecture](../../../docs/desktop-mail/architecture.md), [commit-addressed evidence](../../../docs/desktop-mail/evidence.md). This report is the bounded UX task packet; root owns implementation and integration.

Completed: foundation, flows, screen registry and scenarios; explicit evidence ledger; minimal draft English voice/terminology/facts/channels/locale/string registry. Source enumeration finds one persona, three jobs, three journeys, seven stories, seven flows, eight screens and twenty scenarios. Existing Kumo/Tailwind retained. No code, shared task register, provider configuration, external design file or production service changed.

Decisions: accepted scope is inherited from the owner-approved brief. Detailed proposed recovery policies stay draft. No entry is marked implemented, and all product outcomes are unobserved. Code references in screen records identify reusable surfaces, not full coverage. The brief's earlier macOS uncertainty is stale; approved status and D04 establish the current scope. Optional Figma is deferred for this text-only task, with no claim the owner declined it. Root reported it will proceed provisionally in the existing Kumo app after the unanswered optional question; this is an implementation assumption, not user approval of a tooling choice.

Prerequisites and open work: additional providers, first real tools and recipients remain owner questions. Real OAuth/provider validation needs configured controlled accounts; cloud runs need deployed infrastructure; desktop behavior needs a built artifact. No personal mail content or credentials were read. The new state copy and brand voice remain proposed. Existing source inventory is bounded, not an exhaustive label audit. No reference-service sweep, interviews or runtime UI walkthrough occurred.

Checks actually run from this worktree:

| Command | Exit | Evidence and limitation |
|---|---|---|
| `python3 docs/ux/lint.py` | 0 | 0 errors, 2 U057 warnings: FLW-05/FLW-06 have no implementing screens yet |
| `python3 docs/ux/doctor.py .` | 0 | Current ux-contract v4; optional vision absent |
| `python3 docs/brand/lint.py` | 0 | 0 errors, 39 B022 warnings for unregistered legacy strings; scanner also treats import/class literals as strings |
| `git diff --check` | 0 | Whitespace check before staging; not runtime evidence |

Scripts are unmodified copies from super-ux 0.56.2. Skill sources read: installed `skills/ux-foundation/SKILL.md`, `skills/ux-flows/SKILL.md`, `skills/ux-scenarios/SKILL.md`, `skills/brand-voice/SKILL.md`, and `skills/copywriting/SKILL.md` under the super-ux 0.56.2 package. Format contracts and UI/design principles were read before writing. A local update-policy check ran twice with exit 0 and no output; no revision acknowledgement is claimed.

Exact next task: root integrates this commit, implements against the relevant scenario IDs and shared architecture, updates scenario/screen coverage in the same change, and runs actual UI/desktop/provider acceptance before declaring any scenario implemented. Check draft recovery decisions against owner-approved scope during that work. No push is performed by this delegated task.

Humanization: on; own pass over four proposed state messages, 0% changed; uncertainty and recovery meaning preserved. No claim of exhaustive existing-copy review.
