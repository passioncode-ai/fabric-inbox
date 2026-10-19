# B-27, second half: rename or move an address keeping its mail

Spec for the next change, written 2026-10-19 after the pause half shipped (PR #187). Board row B-27 in
[../../evidence/backlog.md](../../evidence/backlog.md). Decisions are the operator's defaults of 2026-10-19
(reversible, nothing lost), recorded in the handoff ([../README.md](../README.md)).

## What a person gets

Settings → Addresses → ⋯ → Rename or move … on an address: a new local part, on the same domain or another
served domain. The dialog says what moves (every message, attachment, draft, folder, setting, signature,
who answers, category labels) and what the old address does afterwards (it forwards to the new one for
30 days, then is removed). Agents use `rename_address { address, to }`, answered as a job that can be read
again (`rename_status`).

## Facts the design rests on (read in the code)

- A mailbox is a Durable Object named by its address: `MAILBOX.idFromName(email)` (`workers/lib/mailbox-store.ts`).
  Renaming is a copy into the new address's object.
- Its tables are `emails`, `folders` and `attachments` (`workers/durableObject/migrations.ts`). Message bodies and
  attachment files live in R2 under keys named by the message id, not the address: `bodies/<id>.html` and
  `attachments/<id>/…` (`workers/durableObject/index.ts:183`, `:1299`). Copied rows keep pointing at the same
  objects, so nothing in R2 is copied, and **the old object must be emptied without deleting R2 files**:
  `deleteMailbox` calls `purge()` and deletes every key it returns (`mailbox-store.ts:104`), which would take the
  new address's files too.
- Settings are `mailboxes/<address>.json` in R2; when the address was made is in the created record
  (`workers/lib/address-created.ts`); a pause is `paused/<address>.json`; category verdicts and agent runs are kept
  by account id and mailbox id elsewhere.

## Steps (each resumable and idempotent; a journal `renames/<from>.json` holds the step reached)

1. **Check** before anything is written: `from` exists and is not the domain's catch-all; `to` is a valid name on a
   served domain, does not exist (or exists only as this rename's own unfinished target), and Cloudflare can route it.
2. **Create** `to` with a copy of `from`'s settings (name, signature, who answers, copy, rules).
3. **Copy** rows in pages: `MailboxDO.exportPage(cursor)` from `from`, `importPage(rows)` into `to` with
   `INSERT OR IGNORE` on the same ids, so a repeat after a restart adds nothing twice. Folders first, then emails
   with their attachments rows. The journal keeps the cursor.
4. **Verify**: counts per folder equal on both sides, and a sample of bodies reads the same.
5. **Route**: `to` gets its rule (`ensureRule`); `from` keeps its rule and becomes an alias: `renamed/<from>.json`
   `{ to, until }`, and delivery (`resolveRecipient`) puts mail for `from` into `to` until `until` (30 days).
6. **Carry**: category verdicts and the created time move to `to`; agent runs stay under `from` as history.
7. **Empty** `from`'s object with a purge that keeps R2 files; remove its settings. After `until`, remove its rule
   and the alias.

## Tests

- workerd: a rename with mail, attachments, drafts and a custom folder; every message readable at `to` with its body
  and attachment; `from` empty; R2 files still there.
- The same rename cut after each step (a thrown error injected at the step) and run again: the end state is the same,
  nothing is duplicated and nothing lost.
- Mail to `from` during the 30 days lands in `to`; after them it follows the catch-all or is refused.
- Refusals before any write: a catch-all `from`, an existing `to`, an unserved domain, a name the server refuses.
