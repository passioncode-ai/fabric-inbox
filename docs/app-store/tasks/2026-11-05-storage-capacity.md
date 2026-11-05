# B-206: how full the server's storage is, a warning before it fills, and a cleanup that keeps mail restorable

Operator, 2026-11-05: a mail to a support address said its "storage space is 98.6% full" and asked to "clear cache";
the operator asked to find what takes space, check that everything is fine, get Telegram alerts on such events, and
have the server clean Trash, Spam and the like at about 95%, archiving first so mail can be restored.

## What was true on 2026-11-05

- The mail was phishing, and the server had put it in Spam on 2026-11-04 (its spam reason named the unverified
  sender and the link to another domain). Its sender used the product's name with an unrelated domain; its "Clear
  Cache" link went to a third-party site with the address in the fragment.
- A Cloudflare address has no mailbox quota in percent. Each mailbox is one SQLite-backed Durable Object; Cloudflare
  stops its writes at 10 GB on Workers Paid (1 GB on Free) with `SQLITE_FULL` while reads and deletes go on
  ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). New mail would then not be stored.
  The mail of Gmail, Outlook and IMAP accounts lives in one shared object (`GmailAccountsDO`) under the same limit.
- Files (R2) have no limit: the owner's bucket held 190 objects, 21.6 MB (`wrangler r2 bucket info`).
- Nothing on the server measured the size. Spam and Discarded are already deleted after 30 days
  (`purgeSpam`, `purgeDiscarded` in `workers/durableObject/index.ts`); Trash is never emptied.

## Step 1 (0.94.0): measure

`GET /api/storage` and the tool `get_storage`: every mailbox, every address's automation object and every shared
store (accounts, agents, knowledge, categories, campaigns, ledger) with its SQLite size (`ctx.storage.sql.databaseSize`)
and percent of the per-object limit (`STORAGE_LIMIT_GB`, default 10), a level (ok, warn from 80%, full from 95%,
unknown when unreadable), a mailbox's messages per folder, and the files' count and bytes. The fullest first.
Code: `workers/lib/storage-usage.ts`, `workers/routes/server-errors.ts`, `storageUsage` and `storageBytes` on the
objects. Tests: `tests/storage-usage.test.ts`.

**Measured on the owner's server, 2026-11-05 01:35 UTC** (0.94.0, `fba42c2`, `get_storage`): level ok, nothing
unreadable. 162 objects held 34.1 MB together; the largest mailbox 2.65 MB (122 messages in Inbox, 68 in Sent, 72 in
Spam), the largest store the agents' 3.59 MB, the accounts store of Gmail, Outlook and IMAP under 0.01 MB; every
object under 0.1% of 10 GB. Files: 190 objects, 21.6 MB. The phishing mail's 98.6% had no basis.

## Step 2: a warning (designed, not built)

- The server checks once a day (the ledger's alarm) and writes `storage.warn` or `storage.full` as an event and as a
  failed operation `storage.<level>` in the hourly digest (B-205), so Fabric and Observatory see it.
- The Mac app shows a notice to an administrator, as for an older server (B-204).
- Telegram: the operator's rule (2026-11-04) is that every message to a person goes through the operator's own
  Telegram gateway. A customer's server cannot reach it; a watcher on the operator's Mac reads `get_storage` of the
  servers it knows and sends through the gateway. It needs a gateway grant for this project (scope `send` and the chat):
  the operator's act, not yet given (no `TELEGRAM_GATEWAY_TOKEN` slot on 2026-11-05).

## Step 3: a cleanup that keeps mail restorable (designed, not built; scenario first)

At `full` (95%) in one mailbox, and only there:

1. Trash, Spam and Discarded older than 7 days are written to R2 as an archive (one file per message, the export's row
   format of `export_mailbox`, so `import_mailbox` brings it back), then deleted from the mailbox.
2. If the mailbox is still at 95% or more, Archive and Sent older than a year follow the same way. Inbox and starred
   mail are never touched.
3. The archive is kept 90 days, then deleted; restoring it is one tool call per mailbox.
4. Every step is an event with counts, and the warning of step 2 names what was moved.

A scenario in `docs/ux/scenarios.md` comes before code, since this deletes mail.

## Exact next task

The scenario for step 3 (what is archived, when, how it is restored, what the person sees), then step 2's server half
(the daily check, the event and the digest's operation). Telegram waits for the operator's gateway grant.
