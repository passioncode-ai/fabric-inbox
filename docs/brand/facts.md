Contract: brand-contract v1

# Facts

No public numeric claims are authorized by this pack.

| Fact | Value | Source | Checked | Review by | Public |
|---|---|---|---|---|---|

## Proof that is not a number
| Claim | Attribution | Source | Checked | Review by | Public |
|---|---|---|---|---|---|
| Product name is Fabric Inbox | Owner brief | docs/desktop-mail/brief.md | 2026-09-26 | 2026-12-26 | yes |
| macOS and cloud automation are approved scope, not verified delivery | Owner brief | docs/desktop-mail/brief.md | 2026-09-26 | 2026-12-26 | no |

## Current implementation limits

These are internal product constraints, not launch claims. The unified workbench lists cached Gmail and Cloudflare messages together and filters account scope in place (`app/routes/unified-inbox.tsx`, `UnifiedInbox`/`scope`; `workers/routes/inbox.ts`). It does not establish real account authorization, full provider-history search or offline desktop mail. `app/routes/fabric-accounts.tsx` explicitly excludes Outlook/IMAP. The unified forward captures original attachment metadata and requires explicit loading of all original files before sending; new/reply drafts accept selected files up to the shared 10-file/5-MiB bound (`app/components/inbox/Composer.tsx`, `compose-payload.ts`, `shared/mail/attachments.ts`). Legacy Gmail and automation text-forward routes retain their narrower behavior, and local draft storage has an explicit failure path (`app/components/inbox/use-drafts.ts`, `save`; `draft-store.ts`, revision checks; `Composer`, `storageError`). Provider acceptance does not establish recipient delivery (`Composer`, `send`). Desktop requires network access and has no local tool runner (`desktop/setup.html`). No uptime, speed, provider coverage or user-outcome number is authorized by this pack.

The owner-requested white/light and dark Fabric themes derive from website `design-system/tokens.css` at commit `6085d1073b28dc3b97fb9b029350a038d20afd3c`, SHA-256 `86866df1bec49b85e9def4132021401894483bb819dc2d3a3a70511d2e4b2a61`. This is internal source provenance. Scoped token contrast evidence and synthetic UI checks are in [research ledger](../ux/research-ledger.md) and [workbench verification](../desktop-mail/workbench-verification.md); they authorize no public accessibility or live-provider claim.

## Required disclaimers
| Claim it attaches to | Required text |
|---|---|
| Additional provider support | Availability depends on a configured supported adapter. |
| Sent state | Provider acceptance does not prove the recipient read the message. |
