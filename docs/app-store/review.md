# Independent review — first release group

Reviewer examined immutable baseline3d67ada through 7221353. Scope: draft persistence/recovery, attachment MIME/idempotency, MAS preflight/build and installed signing API, image policy, dependency update. Real providers and signing were not exercised; controller owns automated and UI checks.

Two P2 findings:

1. Default image CSP blocked trusted CID images rewritten to server attachment URLs. Root correction: `app/lib/mail-image-policy.ts` generates attachment-scoped, percent-encoded same-origin sources separately from optional HTTPS permission; `EmailIframe.tsx`, `SingleMessageView.tsx`, `ThreadMessage.tsx` use it. `tests/mail-image-policy.test.ts` checks scoped permission and hostile IDs. Initial helper absence failed, subsequent three tests passed. Source URLs are built from mailbox/message/attachment identifiers, not extracted from email HTML. External-image consent behavior was observed on synthetic messages with equal HTML and different IDs.
2. Discard of a never-persisted draft failed after initial quota error because `DraftStore.discard` treated missing record as uncertain. Reviewer reproduced with extracted immutable source. Resolved in integrated 7972623: absent initial record can receive a durable tombstone after storage recovers; revision and uncertain-attempt guards remain. Follow-up reviewer confirmed resolution.

No further actionable issue was identified in this bounded review. This is not whole-product approval; follow-up attachment composer and mail organization changes require separate review after integration.

## Follow-up review

Immutable7221353..2f2e9aa review found one P2: selected files were absent from the durable draft while asynchronous byte capture ran. Close/reopen could reset component-local loading state and send without them. Reviewer reproduced the race with deferred capture against immutable source; late append was refused after locking, too late to preserve attachment intent. Corrective commit a7549af stages draft-owned references and pending IDs before reading files/network; both preparation and lock reject pending IDs; completion clears them only after byte storage and draft acknowledgement. `tests/attachment-composer.test.ts` adds deferred-read/reload/failed-ack coverage. Follow-up verification is recorded in verification.md.

The same reviewer confirmed the earlier inline-image and initial-quota-discard findings resolved. No other actionable issue was identified in the bounded provider-action/transport/lockfile review. This does not establish production provider acceptance, a complete accessibility audit, or store eligibility.

Final bounded rereview at a7549af confirmed the pending-capture race resolved, with three lifecycle regression tests passing against an isolated immutable snapshot. No additional actionable finding; full-product and live-provider limits above remain.
