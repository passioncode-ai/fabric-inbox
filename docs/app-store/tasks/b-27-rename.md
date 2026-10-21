# B-27, second half: rename or move an address keeping its mail

Spec written 2026-10-19 after the pause half shipped (PR #187); shipped in 0.21.0 and redesigned after the
review of 2026-10-21 so that no mail and no change is lost while it runs. **The steps below are what the code
does now** (`workers/lib/address-rename.ts`); the first design's differences are listed at the end. Board row B-27 in
[../../evidence/backlog.md](../../evidence/backlog.md). Decisions are the operator's defaults of 2026-10-19
(reversible, nothing lost), recorded in the handoff ([../README.md](../README.md)).

## What a person gets

Settings → Addresses → ⋯ → Rename or move … on an address: a new local part, on the same domain or another
served domain. The dialog says what moves (every message, attachment, draft, folder, setting, signature,
who answers, category labels) and what the old address does afterwards (its mail goes to the new one for
30 days, then follows the domain's catch-all or is refused, like any unknown address; its Cloudflare rule is
left to the person). A rename already started is shown when the dialog opens: **Finish the rename**, and
**Cancel the rename** while it can still be undone. Agents use `rename_address { address, to }` (call again
while it answers `running`), `rename_status` and `cancel_rename`.

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

1. **Check** before anything is written: `from` exists, is not the domain's catch-all and is not paused; no send
   and no incoming handling is owed in it (`MailboxDO.renameBlockers`); neither address takes part in another
   rename; `to` is a valid name on a served domain, does not exist, is not a recent alias, and no Cloudflare rule
   sends it elsewhere.
2. **Alias and freeze**, at once: `renamed/<from>.json` `{ to, until }` (30 days) is written and `from` is frozen
   (`setRenaming`: its routes refuse changes with 409, its purges wait). Delivery reads the alias before the
   mailbox, so mail for `from` lands in `to` as soon as `to` exists; until then `from` takes it and the copy
   carries it.
3. **Create** `to` with a copy of `from`'s settings (name, signature, who answers, copy, rules).
4. **Copy** rows in pages: `exportPage` from `from`, `importRows` into `to` as an upsert on the same ids
   (`ON CONFLICT(id) DO UPDATE`; `INSERT OR REPLACE` would delete first and the foreign keys would cascade).
   Folders first (a name taken in `to` gets " (2)"), then emails, then attachments rows.
5. **Verify** by id: every message and attachment id of `from` is in `to` (`renameIds`); a gap copies again.
6. **Route**: `to` gets its rule (`ensureRule`). Until here the rename can be cancelled.
7. **Carry**: category verdicts, the created time, agent-key account scopes (`config/agent-keys.json`) and the
   hidden list (`config/hidden-accounts.json`) move to `to`; agent runs stay under `from` as history.
8. **Empty**: one more look by id, `to`'s purges armed, then `from`'s object is emptied keeping R2 files, its
   settings, pause mark and delivery notes removed. The journal goes; the alias lasts its 30 days.

**Cancel** (before step 7): the `to` mailbox this rename made is emptied keeping files and removed, the alias and
the journal go, `from` is unfrozen and takes its mail again.

While a rename runs, either address refuses remove, pause, bring here and being chosen as the catch-all.

## Differences from the first design (2026-10-19)

- The alias was written at the route step; mail delivered to `from` after its copy was emptied with it.
- `INSERT OR IGNORE` kept stale rows, and verification compared counts per folder, not ids.
- `from` stayed writable during the copy, and the other operations did not know about a rename.
- After `until` the old rule is not removed by the server; the unknown-address policy applies to its mail.

## Tests

`tests/address-rename-workerd.test.ts` (workerd, local R2, no network): a full rename with mail, attachments,
drafts and a custom folder; a rename cut off mid-copy and finished; refusals before any write; mail arriving
during a rename (delivered to `to`, and one reaching `from` anyway) present at the end; remove, pause and
another rename refused for both addresses; cancel; agent-key scopes and the hidden list carried.
