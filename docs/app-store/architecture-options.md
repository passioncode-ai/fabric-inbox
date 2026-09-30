# Release architecture decision

## Decision — operator, 2026-09-28

Delivery model: **ready-to-connect local client for personal accounts, Cloudflare for project
addresses.**

- Existing personal and Workspace accounts (many: Gmail, Google Workspace domains, iCloud)
  connect **on the Mac**. The desktop app syncs them over IMAP with app passwords held in the
  macOS Keychain; their mail and credentials do not go to the cloud. The Gmail API with a desktop
  OAuth client stays optional, for Workspace organisations where it is worth it.
- Addresses on project domains (support@, hello@ …) are received by the Cloudflare Worker through
  Email Routing. Each address has a reusable agent that answers **by policy**: it sends what its
  policy allows and drafts the rest for approval.
- The backlog of unread mail is **triaged in the client** (important first, the rest collapsed by
  group and filter). Changes to the accounts themselves — mark read, archive — happen only when the
  operator presses the button, with a preview of the count and undo.
- Order: project addresses and agents first, then local accounts and triage, then the product page.
  [Roadmap and packets](tasks/2026-09-28-roadmap.md).

Seller/team, pricing and the AI processor disclosure below remain open; they do not block the
project-address track.

The proposal that led to this decision follows unchanged.

## Proposal as written before the decision

This is a proposal, not a shipped architecture. Requirement REL-01 and SCN-001/002/003/019 drive the decision. Baseline source is [3d67ada](https://github.com/passioncode-ai/fabric-inbox/tree/3d67ada3043aebaa2897298948a1b8e22a0a1151).

## Measured starting point

`workers/app.ts:50–84` validates one Cloudflare Access workspace and explicitly grants its authorized users all mailboxes. `desktop/main.cjs:76–130` loads remote UI; failure sends the user back to setup. There is no packaged offline renderer. `desktop/preload.cjs` bridges setup configuration only. Gmail refresh tokens and cached mail live in a server Durable Object (`workers/providers/account-service.ts`); current provider directory says Outlook/IMAP unavailable (`app/routes/fabric-accounts.tsx:134`).

Do not expose that shared workspace as a public signup service. Branding and account filters do not provide tenant isolation.

## Ready-to-connect client (recommended product direction, not approved architecture)

A locally packaged renderer and local account service own Gmail/IMAP/SMTP credentials in the operating-system protected store. Mail cache belongs to a user/device and can be cleared independently. Gmail uses a desktop OAuth client with PKCE and native browser return. Provider tokens are never sent to an arbitrary renderer; a narrow typed bridge checks sender frame and operation scope. IMAP/SMTP needs TLS, explicit host/port settings, and no implicit insecure fallback. Outlook needs its own consent/app registration and token recovery.

Cloud automation is opt-in and independently authorized per account/rule: disclose the selected email data and destinations before enabling it. Cloudflare custom-domain mail still needs a managed or user-owned routing service; existing domain routing cannot be silently changed. Cloud processing is a separate capability, not a hidden consequence of adding Gmail. If a managed service is selected, design tenant-scoped DO IDs, query/write boundaries, credential storage, lifecycle deletion and cross-user denial tests before serving accounts. This is substantial backend work.

Trade-off: more local integration and synchronization work; clearer first-run and offline behavior. Hosting/operator costs and Google verification still require a concrete choice. A desktop client does not automatically avoid Google's applicable verification rules.

## Own-server client (closest to current architecture)

Keep workspace-level authorization and make ownership explicit: one trusted server is a shared mailbox workspace. Improve server setup, external identity-provider sign-in handoff, diagnostics and cached offline renderer. Provide usable setup documentation and a review environment; do not advertise consumer signup. Server configuration and deployment remain the owner's responsibility.

Trade-off: less backend redesign, but setup remains technical and a server is required. App Review acceptance cannot be assumed from a successful package build.

## Tools in the Mac App Store build

Use fixed, reviewed, sandbox-compatible actions and allowed remote HTTPS tools. A shell-command runner, installing MCP servers or escaping the sandbox is not a default release feature. SCN-018 must distinguish unavailable device capability from permission denied and retryable offline. The product can still automate approved mail actions and remote tools. Device capabilities must have a concrete sandbox prototype and review description before being promised.

## Decisions needed before dependent implementation

- Delivery model: **decided 2026-09-28** — see the top of this document.
- Seller/team and pricing govern store record and purchases. No StoreKit or checkout chosen until answered.
- Cloud AI processor/model and retention govern consent text. Existing Cloudflare Workers AI is implementation evidence, not a completed legal disclosure.

Independent work (draft recovery, attachment validation, safe mail rendering and MAS build validation) continues on either path.
