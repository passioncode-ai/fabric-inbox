# Addresses in the sidebar, reliability, and updates — 2026-09-29

Request (paraphrased): let the addresses list show only the ones with mail,
or all, or hide chosen ones — and not show what is known not to belong; check how the system is
updated and how builds roll out, with no data lost; research separately how the mail server lives —
that it does not go down, how it retries, whether mail can be lost; then fix everything found.

## Decisions (operator, 2026-09-29)

| Question | Answer |
|---|---|
| What happens to a hidden address's mail | **Hidden everywhere**: out of the sidebar, All inboxes, its domain's view and the unread totals; it keeps receiving; agents and categories as before; a Hidden list brings it back |
| What "with mail" means | Addresses on Cloudflare that are catch-alls or that were created to receive mail, and have mail; the ones with no mail can be switched off from the list |

## Requirements (frozen; adding is free)

| REQ | Requirement | Verified by |
|---|---|---|
| SB-1 | The sidebar lists addresses with mail, catch-alls and the open one by default; All on a switch, remembered on the device | `tests/inbox-ui.test.ts` "the sidebar lists addresses with mail…"; installed app |
| SB-2 | Any address can be hidden and shown again; a hidden one is out of All inboxes, domains and totals, opens alone, keeps receiving; "Hide them…" hides those without mail | `tests/inbox.test.ts` "a hidden address is out of All inboxes…"; `tests/spam-workerd.test.ts` "hiding an address through the route…" |
| SB-3 | The feed says when mail did not reach its rules, agents or categories, with Retry | `tests/reliability.test.ts` (counts), code |
| RL | Findings of the reliability audit fixed, each with a test | **Reliability audit** below |
| UP | Findings of the update audit fixed, each with a test | **Update audit** below |
| DOC | Docs, board, release | receipts |

## Update audit (read-only, then fixed)

| # | Finding | Fix | Evidence |
|---|---|---|---|
| H1 | An app update dropped every plain var on the Worker except `DOMAINS` (`UNKNOWN_ADDRESS_POLICY`, `GOOGLE_CLIENT_ID`, `AUTOMATION_MCP_HOSTS`…): catch-all mail would bounce, Gmail stop | `keep_bindings` keeps `plain_text` and `json` as wrangler's `keep_vars` does | `tests/desktop-deploy.test.ts` "an update keeps every setting on the Worker…" |
| H2 | Spam's 30 days counted from arrival: Report spam on an old message deleted it within a second; the first alarm after upgrading would delete mail moved to Spam by hand before 0.6 (shipped in 0.6.0, found the same day, nothing lost on the owner's server) | migration `12_spam_at`; the purge reads when a message entered Spam | `tests/spam-workerd.test.ts` "30 days count from the move into Spam…" (failed before the fix); `tests/outbox-migrations.test.ts` "upgrading a mailbox with mail already in Spam…" |
| M1 | A downgrade with equal storage tags was silent | `FABRIC_SERVER_VERSION` recorded; an older server over a newer one is refused unless asked | same deploy test |
| M2 | A destructive storage step would be sent as it is | only new classes are ever sent | "a storage step that would delete or move data is never sent" |
| M3 | Updating a server signed in on its own domain created a workers.dev Access app and replaced `POLICY_AUD` | an existing `POLICY_AUD` is kept | "a server signed in on its own domain keeps that sign-in…" |
| M4 | The other Durable Objects have no schema versioning: the first added column will fail on deployed objects | B-32 (0.6.3): `AgentRegistryDO`, `KnowledgeDO`, `CategoriesDO` run numbered steps recorded in `schema_steps`, each in one transaction; `agent_queue.next_at` is step 2, idempotent for objects that added it in 0.6.1 | `tests/do-schema.test.ts` (rollback and idempotence tests watched failing with the transaction and the column check removed) |
| — | A stale `desktop/server-bundle` (0.2.0 in this checkout) could be uploaded by `npm run desktop` | the app uploads only the server built with it | code (`desktop/main.cjs`) |
| L1 | A retried delivery skipped the forwarding copy | see reliability M1 | — |
| L3 | A window left open across an update loses old hashed chunks | not changed | board B-33 |
| L4 | Older code rewriting the spam lists drops fields a newer version added | not changed | board B-33 |

## Reliability audit (read-only, reproduced in workerd, then fixed)

| # | Finding | Fix | Evidence |
|---|---|---|---|
| H1 | A body over 2 MB (a Durable Object row) failed with `SQLITE_TOOBIG` on every retry: the mail was never stored, its attachments left in R2 | a body over 400k characters goes whole to R2 (`bodies/<id>.html`, migration `13_body_key`); the row keeps its start; reading gives the whole body; deleting removes it; Sent copies too (M4) | `tests/backend-fixes.test.ts` "a message whose body is larger than a database row is kept whole…" (failed before the fix) |
| H2 | 25 events that always fail blocked the incoming journal for good | per-event backoff (30 s doubling to 1 h, migration `14_incoming_backoff`), set aside after 10 attempts, counted in `inboxCounts`, Retry; a redelivery retries its own event at once | `tests/reliability.test.ts` "events that always fail wait their backoff…" (watched failing with the old selection) |
| M1 | A delivery stored then cut off never sent its forwarding copy | the receipt marks the copy owed (migration `15_forward_status`); the retry sends it once | "a delivery cut off after storing still sends its forwarding copy…" (watched failing with the owed branch off) |
| M2 | An agent run cut off by a deploy was dropped from the queue while the UI promised a rerun | the queue keeps the message until the run is finished or stale (`agent_queue.next_at`) | `tests/agents-registry.test.ts` "a run cut off mid-way is not dropped…" (failed before the fix) |
| M3 | One Gmail event that always failed blocked every later one, unlogged | per-event backoff, `dead:event:` after 10 attempts, logs; a working sync is not reported as failed | `tests/providers-accounts.test.ts` "an event that always fails is set aside after 10 attempts…" |
| M4 | An outbound body over 2 MB retried its Sent copy every minute forever | same body storage as H1 | same as H1 |
| M5 | AutomationDO kept every run, counter and receipt forever | daily prune of finished runs over 30 days, counters over 3 days, receipts over 90 days | `tests/automation-integration.test.ts` "old finished runs, day counters and event receipts are pruned…" |
| L1 | An error outside one category item skipped the queue's re-arm | items fail alone; the alarm is set in `finally` | code |
| L2 | Unbounded attachment count, each a sequential R2 put | not changed | board B-34 |
| L3 | Agent runs given up after 5 starts were only logged | recorded as a failed run with the reason | code |
| L4 | The unknown-recipient counter is not atomic | not changed | board B-34 |
| L5 | `incoming_receipts` and Gmail delivered events never pruned | not changed (small; the dedupe needs them) | board B-34 |

What held up (the audit's own words, checked): no duplicate mail on any path traced — delivery ids
are a hash of mailbox, envelope sender and bytes, stored with the journal in one transaction; the
outbox never retries an unknown outcome; spam checks fail open; over 25 MB is rejected cleanly; a
MailboxDO's single alarm is only ever moved earlier, so recovery, outbox and the spam purge cannot
starve each other.

## Checked live (2026-09-29)

- The sidebar on the owner's server: 36 addresses, 2 with mail plus 6 catch-alls listed, "28 without
  mail not listed · Show · Hide them…"; nothing was hidden (the operator's choice to make). On a
  phone the domains are a chip row again (the base rule had stacked them, one visible).
- A routing test from one of the owner's addresses to itself after all of the above: it arrived through Email
  Routing, was judged our own (not spam), triaged "Your addresses", counted, with no stuck events;
  it was moved to Trash.

## Release 0.6.1 (2026-09-29)

| Image | Receipt | sha256 (first 16) |
|---|---|---|
| `Fabric-Inbox-0.6.1.dmg` (public, built from d682023; 0 of 63 owner identifiers in `app.asar`; the server bundle carries `fabric-v4`, mailbox migrations up to `15_forward_status`, `FABRIC_SERVER_VERSION`) | notarized, stapled, Gatekeeper accepted | `a3149f329d0d1c4b` |
| `Fabric-Inbox-0.6.1-owner.dmg` (installed in /Applications) | notarized, stapled, Gatekeeper accepted (`source=Notarized Developer ID`) | `4766620cdf2492ef` |

Server 0.6.1 deployed (version `2c0c4fa5`). The 0.6.0 images in `release/` carry the spam clock that
counted from arrival (fixed in b48d2da) and must not be used; they were never published.
