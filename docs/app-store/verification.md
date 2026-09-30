# Release work verification — 2026-09-27

Tested integrated code and styles: [d61966e](https://github.com/passioncode-ai/fabric-inbox/tree/d61966ecde2d16b5f926394f97c3e830a8ec9513). Root branch `codex/app-store-release`; integration updates existing draft PR1 on `codex/fabric-inbox`, not main. No production deploy, store-signed package, TestFlight upload, App Review submission or live release occurred.

## Checks actually run

| Command / method | Result and scope |
|---|---|
| `npm test` | 149 passed, 0 failed/skipped. Final run after capture-race fix. Includes provider mocks, real Miniflare SQLite/R2 integration, MIME byte roundtrip, draft revisions/recovery, attachment pending lifecycle and MAS preflight constraints. |
| `npm run typecheck` | Exit 0; Wrangler/React Router generation and TypeScript passed after final capture fix. |
| `npm run build` | Exit 0; client and Worker production builds passed after final capture fix and sticky composer footer. Build warnings remain informational, not a signed desktop acceptance. |
| `npm audit --omit=dev --json` | 0 known production advisories in current lockfile. |
| Full `npm audit --json` | 7 dev/build findings remain: 6 high, 1 low, listed in dependency-update.json. Cloudflare plugin/Wrangler/Miniflare, nested sharp/undici/ws and esbuild need compatible toolchain remediation before release. No `--force` or legacy-peer bypass was used. |
| `python3 docs/ux/lint.py` | Exit 0; UX contract consistent. |
| `python3 docs/ux/doctor.py .` | Exit 0, current contract; optional vision.md absent. |
| `python3 docs/brand/lint.py` | 0 errors, 332 adoption warnings (scanner includes imports/CSS literals as well as unregistered copy). This is not a completed whole-app copy audit. |
| `git diff --check` | Exit 0. |
| Update policy check | The local update-policy check printed no applicable update for this checkout; no revision acknowledgement claimed. |

Source check outputs are reproducible with the commands above; transient local logs are not handoff dependencies. Tests establish bounded synthetic behavior, not Google/Cloudflare production delivery or Apple acceptance. [Independent review](review.md) records three corrected findings; final pending-capture rereview ran three lifecycle tests against an isolated immutable a7549af snapshot and reported no additional actionable finding.

## Browser observation through supported CUA

Local synthetic fixture: `PREVIEW_HTML=1 PREVIEW_ACTIONS=1 FIXTURE_PORT=5190 node scripts/preview-fixture.mjs`, proxying `npm run dev` on 5174. It contains three synthetic accounts and six synthetic messages, no real provider credentials. Opt-in star/trash/restore mutate in-memory fixture rows only; send requests are always refused. Restart resets fixture message state. Existing default fixture behavior remains refusal of all mutations.

Observed:

- Created two independent drafts with different senders/subjects; reload retained both. A third draft retained Gmail sender, To, Cc, Bcc, subject, body and a 73-byte selected text file after reload. Sending that restored draft reached the fixture refusal after successful local byte preparation; no real mail was sent.
- After the pending-capture fix, chose another synthetic file, immediately closed and reopened the draft: both references were present and ready. This small-file interaction did not force a slow read. The deliberately deferred close/reopen/reload race is covered by the isolated lifecycle regression tests, not claimed as a browser timing reproduction.
- Gmail star toggled the pressed icon and list star; trash removed the selected message, Trash showed it, and Restore message removed it from Trash. Cloudflare unstar/trash/Restore to inbox also updated the fixture UI. Provider readback/failure/cache/account-isolation semantics are covered by tests; no live server mail was moved.
- HTML image permission began blocked. Clicking Load external images changed the actual iframe CSP to permit HTTPS. Selecting a different message with the same HTML reset permission. Actual `srcdoc` showed no-referrer and form/base restrictions. Scoped CID attachment sources were unit-tested, not exercised with a real provider inline image.
- Light and dark dialogs were visually inspected at the normal 1280×720 viewport. Added a sticky send footer and responsive body height after the first screenshot hid actions below the fold. Verified the final light composer at 1280×720 and 900×680; viewport override was reset. This is a bounded visual check, not a full accessibility audit or final App Store screenshot set.

The final synthetic browser remains available at localhost:5190 for review while the development servers run. It is not the delivery location: code, contracts and receipts are tracked in Git. Browser profile test drafts and `/tmp/fabric-release-synthetic.txt` stay local only and contain synthetic data.

## Delivery and exact continuation

[README](README.md) is the one release entry; [remaining packets](tasks/remaining-features.md) cover the open scope and shared contracts. Inbox is the sole modified repository in this iteration. Website/profile/Fabric pointers remain at the prior [multi-owner handoff](../desktop-mail/workbench-handoff.md); no public availability claim or parent submodule pin was changed. Existing Fabric `codex/inbox-product-links` integration remains pending and must not be merged wholesale with unrelated changes.

Owner remote: `git@github.com:passioncode-ai/fabric-inbox.git`. **Single branch: `main`.** On 2026-09-27 `main` was fast-forwarded from `dac09f9` to `0fb74ae` (the tip of `codex/app-store-release` and `codex/fabric-inbox`, draft PR1), after `npm test` (149 pass, 0 fail) and `npm run typecheck` (exit 0) at that commit. Every other `codex/*` branch was either an ancestor of `0fb74ae` or patch-equivalent to commits in it (`git cherry` reported no unique patch; `codex/inbox-ux` was superseded by `a13f761` and later edits), so all branches and linked worktrees were deleted. The implementer commits cited by the reports in this folder stay fetchable under annotated tags: `archive/mas-release-build`, `archive/release-drafts`, `archive/release-attachments`, `archive/release-attachment-composer`, `archive/release-mail-actions`. Branch names in the reports and task packets are history, not live pointers. A full ref backup (bundle + per-ref TSV) is kept outside the repository on the operator's machine.

Next (superseded 2026-09-28): the delivery model is decided and the continuation is the [release entry](README.md) exact next task and the [roadmap](tasks/2026-09-28-roadmap.md). Apple seller/team/access and pricing answers remain open. Signing identities/profile, OAuth verification, remaining build-tool advisories and real acceptance remain release gates. No automatic agent loop or recurring work was scheduled.

Skills actually used: task-pipeline for bounded implementation/review, ux-scenarios for the scenario contract, a design skill for existing Fabric tokens and composer layout, copywriting for operational states, brand-voice for canonical facts/terms, evidence-docs for source/check receipts. project-audit was inspected but not applied because this is release implementation, not a cold project audit. No agent-stack system was changed in this iteration.
