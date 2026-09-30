> **History — do not follow as instructions.** Current entry: [release entry](../app-store/README.md); status authority: the [roadmap](../app-store/tasks/2026-09-28-roadmap.md). PR #1 is merged (2026-09-27); "PR1 remains draft" and the `codex/*` branches below describe the state before that.

# Fabric Inbox — unified workbench handoff

## Objective and result

Show all supported accounts together and filter one account without replacing the workspace. Apply canonical Fabric white/dark styling, publish a product page, and connect the GitHub family information.

Implemented: account-aware merged API, stable keyset paging and partial-provider errors; three-column workbench; account/folder/search filters; reader and attachment downloads; sender-aware composer with local draft/recovery preservation; light/dark preference and shared product mark; branded native setup. Advanced account/rule routes remain reachable. General IMAP/Outlook, live OAuth/delivery acceptance, offline mail cache and local tools remain outside implemented capability.

## Entry points and bounded packets

- [Brief and acceptance rubric](workbench-brief.md)
- [API contract and backend packet](unified-api.md); shared contract `shared/mail/inbox.ts`
- [Verification receipt](workbench-verification.md)
- [Canonical brand provenance](brand-source.json)
- [UX integration receipt](../ux/implementation-receipt.md) and [scenarios](../ux/scenarios.md)
- Product entry `app/routes/unified-inbox.tsx`; sender/recovery helpers `app/components/inbox/send-state.ts`.
- `scripts/preview-fixture.mjs` is a loopback-only synthetic demo; it refuses mutations. Start the actual dev server with `npm run dev -- --port 5174 --host 127.0.0.1`, then `FIXTURE_PORT=5183 node scripts/preview-fixture.mjs`. It is not a production backend.

## Repository delivery index

| Owner | Remote | Branch / source | State and entry |
|---|---|---|---|
| Inbox | passioncode-ai/fabric-inbox | codex/fabric-inbox (PR1), integrated from codex/unified-workbench | This entry; implementation 05d619eb9a7786c0b760186e64f71eb58ea07e75; source links below. Inbox backend has not been deployed. |
| Public website | passioncode-ai/passioncode-ai.github.io | main receipt 3d44aa64bdc4e7fdae923151c87f67974403c7db; deployed source 630f4f7f5c94fc36f15d9047ff487d1142c3479f | [Website handoff](https://github.com/passioncode-ai/passioncode-ai.github.io/blob/3d44aa64bdc4e7fdae923151c87f67974403c7db/docs/INBOX_HANDOFF.md); [live Inbox](https://passioncode.ai/inbox/),23public files verified against built bytes. |
| Fabric docs | passioncode-ai/fabric | codex/inbox-product-links pin 26b073c1c8e1f6b496ae831b07c8a5cf807c8389; source 796b31c3434b772ce837d74ee570ff49fc8c85b4 | [Canonical handoff](https://github.com/passioncode-ai/fabric/blob/796b31c3434b772ce837d74ee570ff49fc8c85b4/docs/launch/inbox.md). Pushed; main unchanged, because branch includes broader pending Fabric work beyond this Inbox change. |
| Fabric workspace | passioncode-ai/fabric-workspace | child 6574a1c708b87ccb243a27eb3508db5077251827 | Published release 78, source identity verified; parent pin checked. [Map](https://wiki.passioncode.ai/docs/reports/map.html#iteration-2026-09-26-inbox-handoff), [family](https://wiki.passioncode.ai/docs/reports/map.html#toolkit-products). |
| Organization profile | passioncode-ai/.github | main merge dc4e0b1afcbda9c2d70c98d0c132ef9bbb28eb1d; working receipt 905ded4e81ec8580e3031689fc81b054bee55721 on codex/inbox-profile | [Live profile](https://github.com/passioncode-ai); [profile source](https://github.com/passioncode-ai/.github/blob/dc4e0b1/profile/README.md). PR1 merged, anonymous raw profile fetch verified. |

No email routing, DNS, credentials, original agentic-inbox service or unrelated website/Fabric work was changed. Private source visibility was preserved. Hosted nightly CI was not dispatched or represented as passing; local checks are listed in the receipt.

## Exact next task

Review Inbox PR1 and configure an isolated real provider acceptance environment using [setup](setup.md). Exercise two Gmail identities and Cloudflare with real login, inbound mail, send acceptance and reconnect; record results before deploying the Inbox backend or advertising a public release. Integrate the Fabric documentation branch under its existing policy rather than moving main across unrelated pending iterations. Follow up package signing/notarization for distribution.

## Design review and retrospective

The chosen shape is a standalone toolkit product, retaining account ownership for every message and rule. Shared tokens avoid a second brand palette; failure states preserve usable accounts; uncertain sends retain their immutable identity. Real-provider readiness remains separately measured. The standing Fabric review question — whether the work was planned correctly and whether it is being done correctly — is answered here by that concrete separation of tested UI behavior and unverified provider delivery.

## Skills actually used

- task-pipeline: isolated task worktrees, bounded agents and review; source `task-pipeline/references/build.md`.
- ux-scenarios (super-ux): all-account/single-account scenarios and same-change coverage.
- a design skill: canonical Fabric token/glyph adoption and compact white/dark workbench.
- brand-voice: product facts/terminology; copywriting: interface and public product copy.
- accessibility-review: named controls, dialog focus and contrast checks (external to the family; no complete WCAG claim).
- evidence-docs: executable receipts and multi-repository handoff.
- cloudflare: exact-source website publication and live byte verification (external plugin).
- agent-sync: Fabric documentation lease.

Routing followed the operator's standing instructions; Fabric repository and workspace publication instructions govern their own changes. No skill installation was needed. Figma stayed deferred; no release-ready design file is claimed.

## Final delivery verification

Inbox implementation [05d619eb9a7786c0b760186e64f71eb58ea07e75](https://github.com/passioncode-ai/fabric-inbox/commit/05d619eb9a7786c0b760186e64f71eb58ea07e75) was pushed to both `codex/fabric-inbox` (existing PR1) and `codex/unified-workbench`; remote refs matched. A fresh SSH clone of the remote branch resolved to that SHA, all relative handoff links resolved and every vendored brand hash matched. The original local `fabric-inbox` checkout was clean and fast-forwarded to the same implementation. [PR1](https://github.com/passioncode-ai/fabric-inbox/pull/1) remains draft; no Inbox main merge or production deployment is claimed.

Commit-addressed source: [workbench](https://github.com/passioncode-ai/fabric-inbox/blob/05d619eb9a7786c0b760186e64f71eb58ea07e75/app/routes/unified-inbox.tsx), [recovery and recipients](https://github.com/passioncode-ai/fabric-inbox/blob/05d619eb9a7786c0b760186e64f71eb58ea07e75/app/components/inbox/send-state.ts), [verification](https://github.com/passioncode-ai/fabric-inbox/blob/05d619eb9a7786c0b760186e64f71eb58ea07e75/docs/desktop-mail/workbench-verification.md).

Local package content inspection confirmed `setup.html`, `fabric-tokens.css` and `inbox-mark.svg` inside the built app.asar. The deliverable remains unsigned for distribution. Local-only: credentials, caches, dependency trees, build/release binaries and fixture-server state must stay out of Git.
