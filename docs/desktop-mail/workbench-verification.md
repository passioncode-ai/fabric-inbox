# Unified workbench verification — 2026-09-26

## Executed checks

- `npm test`: 87 tests, 87 passed, 0 failed. Includes real local workerd/R2 unified route fixture, keyset/date order, provider-ID collisions, account filter, partial failures, immutable send recovery, quoted recipient names and exact vendored brand hashes.
- `npm run typecheck`: exit 0. `npm run build`: exit 0.
- `npm run desktop:package -- arm64`: completed; unsigned local Mac app under `release/Fabric Inbox-darwin-arm64/Fabric Inbox.app`. Earlier attempts failed from exhausted disk/code-signing temporary-write error; task-created failed package directories were removed and packaging then passed. Developer ID signing/notarization remain separate release steps.
- Canonical website source 6085d1073b28dc3b97fb9b029350a038d20afd3c, `design-system/tokens.css`: 35 measured contrast pairs, minimum 5.29:1; prior 42 dark values preserved (website `scripts/check-design-tokens.mjs`). Exact copies are guarded by `tests/brand-source.test.ts` and [source manifest](brand-source.json).

## Browser observations (CUA, synthetic data)

The actual React UI was observed through `scripts/preview-fixture.mjs` on localhost:5183, forwarding UI assets from the local development server. Three synthetic accounts and six synthetic messages were used. No real mail was read, sent, archived or forwarded.

Observed: all three accounts together; combined list with per-message account; Gmail and Cloudflare readers; account filter narrowed to two messages while retaining the account list; light/dark switch and dark preference after reload; reply preselected and locked the owning Gmail sender; Escape preserved typed draft; selecting Cloudflare and reopening the draft kept the original Gmail sender and text; discard of an unsent synthetic draft; empty search retained all accounts and Clear search restored the list; 820px reader replaced the list and exposed Back to messages. At1280px, measured document width equalled viewport width (no horizontal overflow); the final sidebar measured 720px content/720pxviewport. Healthy account rows use two lines so addresses remain visible; provider identity is available on hover and in the reader. Native dialog supplies modality/focus trapping; initial message-field focus and focus return are implemented in Composer.

The no-account state was observed against the actual local API on 5174. Partial provider failure, paging and malformed recipient recovery are covered by code tests, not live-provider interaction. Full WCAG compliance is not claimed. A separate production-preview URL on 5203 was blocked by the browser client; no bypass was attempted. Production build itself passed the compiler. The production middleware also intentionally fails closed without POLICY_AUD/TEAM_DOMAIN (`workers/app.ts`, Access middleware); no production auth bypass was added.

## Review fixes

Read-only review identified and the change fixed: later HTTP refusals unlocking earlier uncertain sends; replies to self-sent messages targeting yourself; terminal failed receipts trapping the composer; display-name commas invalidating recipient payloads. Regression tests live in `tests/inbox-ui.test.ts`; helpers are in `app/components/inbox/send-state.ts`. Draft-storage failure copy now appears inside the composer; uncertain attempts cannot be discarded as if unsent.

## Limits

Gmail shows cached server mail, not an offline desktop cache. Cache scans beyond 20,000 storage rows explicitly return a per-account issue. General IMAP/Outlook and local tool runner remain absent. Cloudflare/Gmail OAuth, provider delivery, credentials, and Inbox production deployment were not performed this turn. The public product page describes a development preview, not a release.

UX lint and doctor passed after receipt creation. Brand lint:0errors,274B022heuristic warnings. No missing-link warnings remain.
