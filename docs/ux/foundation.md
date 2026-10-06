# UX Foundation

<!-- Managed with super-ux (ux-contract v4). Update affected layers in the same change as behavior. -->

## Evidence and scope

RE-001..RE-010 resolve in [research-ledger](research-ledger.md). This is a specification from an approved brief plus code inventory. No claimed user observation. Opportunity Frequency × Severity × Solvability and emotion ratings are unknown (no source or scale collected).

## Personas

### P-01: Owner of several mail accounts
Owns the accounts and decides who may receive mail or connected-tool data. Wants a desktop place to handle mail and authorize background follow-up. RE-001; no invented demographic or usage frequency.
- **Status:** confirmed
- **evidence_kind:** brief
- **decision_status:** accepted
- **validation_status:** unvalidated

## Jobs to Be Done

### JTBD-01: Handle mail across accounts
- **Statement:** When mail arrives in several accounts, I want to find and answer it from the right identity, so I can finish the conversation without losing its context.
- **Personas:** P-01
- **Type:** functional
- **Forces:** push: fragmented accounts; pull: one place to read and respond; anxiety: wrong sender or lost mail; habit: existing provider clients. These are brief-derived interpretations, not interview findings.
- **Success metric:** Account-scoped thread, attachments and a confirmed or explicitly pending send are visible.
- **Status:** confirmed
- **evidence_kind:** brief
- **decision_status:** accepted
- **validation_status:** unvalidated
- **Evidence:** RE-001; assumptions remain untested.

### JTBD-02: Delegate repeatable mail work
- **Statement:** When incoming mail requires the same follow-up, I want to authorize a bounded rule, so the work continues while my Mac is off and I can inspect what happened.
- **Personas:** P-01
- **Type:** functional
- **Forces:** push: repeated manual follow-up; pull: bounded background work; anxiety: unintended external action; habit: manual checks. These are brief-derived interpretations, not interview findings.
- **Success metric:** A rule can be tested, enabled, paused and traced to its source and resulting action.
- **Status:** confirmed
- **evidence_kind:** brief
- **decision_status:** accepted
- **validation_status:** unvalidated
- **Evidence:** RE-001; assumptions remain untested.

### JTBD-03: Resume with confidence
- **Statement:** When I reopen the app or lose access, I want to see what is current and what is waiting, so I can resume without repeating an uncertain action.
- **Personas:** P-01
- **Type:** functional
- **Forces:** push: uncertain state; pull: continuity across sessions; anxiety: duplicate send; habit: recheck provider inbox. These are brief-derived interpretations, not interview findings.
- **Success metric:** The user can distinguish cached, syncing, failed and unknown work and reach recovery.
- **Status:** confirmed
- **evidence_kind:** brief
- **decision_status:** accepted
- **validation_status:** unvalidated
- **Evidence:** RE-001; assumptions remain untested.

## Customer journeys

### JRN-01: P-01 — Mail across accounts (JTBD-01)
Evidence: RE-001, RE-003; inferred pain, not measured.

| # | Stage | User action | Touchpoint | Emotion (1-5) | Pain | Opportunity |
|---|---|---|---|---|---|---|
| 1 | Connect | Authorize account | SCR-02 | unknown | Authentication interruption | Show reconnect or cancel; F/S/S unknown |
| 2 | Read | Find and open a thread | SCR-03, SCR-04 | unknown | Account confusion | Keep source visible; F/S/S unknown |
| 3 | Respond | Write, attach and send | SCR-05 | unknown | Wrong sender or uncertain outcome | Keep sender and delivery state visible; F/S/S unknown |
| 4 | Return | Reopen and follow up | SCR-01, SCR-03 | unknown | Stale or missing content | Show sync state; F/S/S unknown |

### JRN-02: P-01 — Delegated follow-up (JTBD-02)
Evidence: RE-001, RE-003; inferred pain, not measured.

| # | Stage | User action | Touchpoint | Emotion (1-5) | Pain | Opportunity |
|---|---|---|---|---|---|---|
| 1 | Prepare | Inspect source with AI | SCR-04 | unknown | Unclear provenance | Link the source; F/S/S unknown |
| 2 | Test | Define and dry-run rule | SCR-07 | unknown | Unintended action | Preview destinations without side effects; F/S/S unknown |
| 3 | Run | Enable background work | SCR-07 | unknown | Loss of control | Keep pause visible; F/S/S unknown |
| 4 | Review | Inspect history and approvals | SCR-08 | unknown | Unknown effect or unavailable tool | Separate waiting, failed and unknown; F/S/S unknown |

### JRN-03: P-01 — Continuity (JTBD-03)
Evidence: RE-001, RE-003; inferred pain, not measured.

| # | Stage | User action | Touchpoint | Emotion (1-5) | Pain | Opportunity |
|---|---|---|---|---|---|---|
| 1 | Launch | Open app and restore session | SCR-01 | unknown | Expired access | Offer sign-in without claiming current data; F/S/S unknown |
| 2 | Recover | Reconnect or continue offline | SCR-01, SCR-02 | unknown | Accidental repeats | Keep pending work explicit; F/S/S unknown |
| 3 | Manage | Adjust settings | SCR-02 | unknown | Lost input after error | Preserve edits and show save state; F/S/S unknown |

## Monetization
None in this approved scope. No paywall, acquisition funnel or commercial claim is being designed.

## Product mechanics
- **Personalization:** rule-based, explicit account/destination/tool grants; model proposals cannot grant themselves permissions.
- **Engagement mechanics:** none.
- **Accessibility regime:** none stated by owner; keyboard operation, visible focus, announced status and reduced motion are design requirements, not a compliance claim.

## Design tooling
- **Figma:** disabled
- **Figma file:** none; temporarily deferred for this text-only foundation. The owner's optional Figma choice is pending in the root task; this does not record a user rejection.
- **Build state:** provisional text specification. RE-008 adds the owner-requested unified workbench and white/dark Fabric themes. Canonical values come from the website token source recorded in RE-010; legacy Kumo/Tailwind surfaces remain available. Figma synchronization is deferred, not rejected.

## Open decisions
- Additional providers beyond Cloudflare and Gmail: RE-003; show unavailable capability rather than universal support.
- First real tools and recipients: RE-003; use controlled fixtures until supplied.
- Detailed recovery and destructive-action policy is proposed in draft scenarios. No scenario grants permission to send real development messages.

## User stories

### ST-001: Connect my accounts
- **Story:** As P-01, I want to connect supported accounts, so that I can read mail from the accounts I own.
- **Traces:** JTBD-01, JRN-01; RE-001
- **Acceptance criteria:** Given a supported provider, when I complete its authorization, then its account and synchronization state appear; cancellation does not create a connected account.
- **Priority:** must
- **Status:** validated
- **Product:** unobserved

### ST-002: Triage and find mail
- **Story:** As P-01, I want to read, search and organize a unified inbox, so that I can find the right conversation with its account identity.
- **Traces:** JTBD-01, JRN-01; RE-001
- **Acceptance criteria:** Given connected accounts, when I choose all accounts or one account, then results retain their source identity and one failed account does not hide successful results.
- **Priority:** must
- **Status:** validated
- **Product:** unobserved

### ST-003: Write and deliver mail
- **Story:** As P-01, I want to compose, reply and forward with attachments and drafts, so that I can send the intended content from the chosen identity.
- **Traces:** JTBD-01, JRN-01; RE-001
- **Acceptance criteria:** Given a draft, when I send, then the selected account and recipients are retained and the UI reports the transport state without calling a queued message sent.
- **Priority:** must
- **Status:** validated
- **Product:** unobserved

### ST-004: Ask AI about a thread
- **Story:** As P-01, I want to request an explanation or draft grounded in the selected mail, so that I can review suggested work before I use it.
- **Traces:** JTBD-02, JRN-02; RE-001
- **Acceptance criteria:** Given a selected thread, when I ask AI, then the response identifies its source and a draft remains editable before sending.
- **Priority:** must
- **Status:** validated
- **Product:** unobserved

### ST-005: Configure a bounded rule
- **Story:** As P-01, I want to dry-run, enable and pause a rule, so that I can delegate repeatable work with explicit permissions.
- **Traces:** JTBD-02, JRN-02; RE-001
- **Acceptance criteria:** Given a rule, when I dry-run, then proposed actions and destinations are shown without external side effects; enabling and pausing are explicit controls.
- **Priority:** must
- **Status:** validated
- **Product:** unobserved

### ST-006: Inspect and control a run
- **Story:** As P-01, I want to view history and resolve approvals or failures, so that I can know which external actions occurred.
- **Traces:** JTBD-02, JRN-02; RE-001
- **Acceptance criteria:** Given a run, when I inspect it, then I see its source, rule version, actions, result and waiting reason; actions outside its grants do not execute.
- **Priority:** must
- **Status:** validated
- **Product:** unobserved

### ST-007: Resume and manage settings
- **Story:** As P-01, I want to reopen the desktop app and manage connection settings, so that I can continue safely across offline and expired sessions.
- **Traces:** JTBD-03, JRN-03; RE-001
- **Acceptance criteria:** Given a previous session, when I reopen offline, then cached content is labeled, missing content is unavailable, and uncertain sends are not repeated automatically.
- **Priority:** must
- **Status:** validated
- **Product:** unobserved

**Kill criteria:** No dated usage threshold is known; do not invent one. Revisit scope only with the owner.


### ST-008: Put an agent on a project address
- **Story:** As P-01, I want to connect an address on a project domain and put a reusable agent on it with an explicit reply policy and tools, so that routine mail to that project is answered without me and everything else reaches me as a draft.
- **Traces:** JTBD-02, JRN-02; RE-001
- **Acceptance criteria:** Given a project domain routed to the service, when I add an address and choose an agent, then mail to that address is handled by that agent; the agent sends only what its policy allows, drafts the rest for approval, skips no-reply and bulk senders, and mail to an address with no mailbox is never lost silently.
- **Priority:** must
- **Status:** proposed
- **Product:** unobserved
## Implementation boundary at integration

The approved jobs and acceptance criteria remain targets. The current [implementation receipt](implementation-receipt.md) records the unified account-aware list and sender-aware composer alongside text-only forwarding, partial history fields and absent offline cache/device runner. Source evidence is not a reason to reduce the requested all-account job or mark Product observed. Root CUA and workerd fixture results are engineering observations only (RE-004..RE-010). The primary workbench task is to see all accounts together, narrow to one without changing surfaces, and retain the source account while reading and responding; see [workbench brief](../desktop-mail/workbench-brief.md).
