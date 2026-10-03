# Store and provider requirements — checked 2026-09-27

This record is an engineering release checklist, not App Review approval. Final declarations must match the exact signed binary and deployed service.

| Gate | Required evidence | Current evidence / remaining work |
|---|---|---|
| Seller/access | Confirm Apple Developer team, App Store Connect role and accepted agreements | Only a local Developer ID identity observed; operator answer pending. |
| Store package | Electron MAS runtime, App Sandbox, appropriate app/installer identities and matching provisioning profile | Dedicated exact-source preflight/build implemented and locally tested. Since 2026-10-03 CI-only store identities and the Fabric Inbox profile exist in the `release` environment and `release.yml` builds, signs and (when publishing) uploads the package ([release procedure](../release.md#mac-app-store)); no store-signed candidate observed yet. The App Store Connect app record does not exist (a person creates it). |
| Product completeness | Core mail flows and review access work against running services | Synthetic UI and integrated local tests recorded in verification.md; real OAuth/inbound/send/revoke acceptance open. |
| Packaged functionality | Reviewed app behavior self-contained; no downloaded executable extensions or independent updater | Current remote-host shell needs architecture review; no shell runner to be introduced implicitly. |
| Privacy | Accessible policy in app and store, truthful data collection/retention/deletion and third-party sharing disclosures | Map actual processing first; no public policy invented from planned architecture. |
| AI consent | Disclose where email data goes and obtain permission before third-party AI sharing | Needs explicit UX and server enforcement, including rules running after app closes. |
| Google production access | Verified requested Gmail scopes and applicable security assessment | Uses gmail.modify on a server; verification status unknown. |
| Store content | Accurate name/description, actual app screenshots, support URL, category/age rating/export answers, review instructions | Product page exists; screenshots/answers after candidate behavior and seller confirmed. |
| Release | Accepted build processed, tested, submitted, approved and live | Not uploaded, submitted or released. Upload is automated on a published release once the app record exists; submission for review stays a person's act. |

Sources (primary, read this run): [Electron MAS submission](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide), [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/) sections2.1,2.4.5,2.5.2,5.1.1–5.1.2; [Apple privacy management](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy); [Gmail scope table](https://developers.google.com/workspace/gmail/api/auth/scopes); [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

Privacy data-flow inventory to complete: credentials; mail content and attachments; recipient/contact addresses; send receipts and rule logs; AI prompts/results; MCP arguments; crash/diagnostic logs; local drafts/cache; retention and deletion at each holder. Never put real content, tokens, credentials or account exports in the release report. Use synthetic examples and evidence IDs.

Release order: exact-source local checks → sandboxed development acceptance → signed distribution package inspection → upload and processing → TestFlight/controlled acceptance → complete truthful metadata and review access → submit → observe Apple's result → publish accurate download/store links. No CI passing claim from missing nightly coverage.
