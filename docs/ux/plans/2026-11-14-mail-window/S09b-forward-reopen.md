# S09b. A forward reopened from Drafts keeps its original's files (B-277)

**Asked:** the S09 walk's defect D6 ([S09](S09-forward.md), step 0): a forward saved to the server and opened again on
another device (or after this device lost its copy) comes back as a new message. Its eyebrow says "New message", its
originals are plain saved files, a file left out cannot be put back and Retry is gone. Board row B-277 (P2).

## Today

- `syncDraft` (`app/components/inbox/server-drafts.ts:88-138`) saves the text, the forwarded HTML and the files. The
  forward's origin (`Draft.forwardSource`: the account, the original message, its files with their safety colour) and
  `Draft.leftOut` stay on this device only.
- `openServerDraft` (`server-drafts.ts:240-258`) rebuilds a draft from the server as `mode: "reply"` or `"new"` with no
  `forwardSource` and no `leftOut`. Its files come back without `sourceId`, so `includedOriginalIds` finds none.
- `openServer` (`use-drafts.ts:252-270`) uses the copy on this device when one exists, so the defect is seen only where
  there is no such copy: another device or browser, the Mac app after its profile was reset, a draft an agent saved.
- Sending still works (a non-forward draft is not checked for originals, `compose-payload.ts:43`); nothing is lost but
  the list of the original's files and the ways to act on it.

## Target

1. **The server keeps the forward's origin beside the draft, never in the message.** Saving a forward draft sends one
   more field, `forward`: a JSON string the app writes and reads, opaque to the server (at most 200,000 characters,
   refused as `invalid_forward` above that or when it is not a JSON object). The server stores it as its own object in
   the mailbox's R2 bucket: `draft-forward/<mailbox>/<draft id>.json` for a Cloudflare address,
   `draft-forward/accounts/<account id>/<draft id>.json` for a Gmail account. It never enters the message's headers,
   HTML or text, so a send by the person, by an agent's `send_draft` or from Gmail's own window carries nothing of it.
   - A save without `forward` leaves the kept object as it was (K-6, K-9 of the review): an older app, an agent's
     `update_draft` or a device that could not read the meta never erases it. Only a delete or a send removes it.
   - Cloudflare: `PUT /api/v1/mailboxes/:mailboxId/drafts/:id` takes `forward`; after a save that succeeded the
     object is written with the draft's revision, and a late writer whose revision is older than the kept one writes
     nothing (K-1). `GET .../drafts/:id` answers `forward` (string or `null`). `DELETE`, a send that was accepted and
     the old replace-by-`POST` path (`draft_id`) delete the object (K-7).
   - Gmail: `PUT /api/accounts/:accountId/drafts/:draftId` takes `forward` with the same rules; `POST
     /api/accounts/:accountId/drafts` takes it beside the message, strips it before the creation's idempotency payload
     (so a retry with the same key is the same creation), and writes it once the creation is `accepted` with its
     `providerDraftId`, only where no meta is kept yet, so a replay never overwrites a later change's meta (K-3).
     `GET .../drafts/:draftId/content` answers it. `DELETE` and an accepted send delete it.
   - A write or delete of the object that fails is logged (`draft_forward_store_failed`, the route and the error, no
     content) and never fails the save, the delete or the send: the draft itself is what the person needs.
   - The MCP tools are unchanged (their inputs never carry `forward`, and agents read drafts as today). No new route,
     so `NOT_TOOLS` and `docs/agents/mcp.md` do not change.
2. **What the app writes** (`forward-meta.ts`, new): `{ v: 1, source, leftOut, attached }` where `source` is the
   draft's `forwardSource`, `leftOut` its `leftOut`, and `attached` lists each original carried as a file:
   `{ sourceId, serverId?, filename, size }` (`serverId` once the server named the file). It is written on every save
   of a draft with `forwardSource`, and left out otherwise.
3. **Reopening restores the forward.** `openServerDraft` reads `forward`, validates it with the same rules the device
   store uses (`forwardSource` and `leftOut` validators of `draft-store.ts`, exported), and on success returns
   `mode: "forward"`, `forwardSource`, `leftOut`, `originalId` = the source's original. Each server file is matched to
   an `attached` entry: by `serverId`, else by the one unmatched file with that name (both read as the server stores
   names, `storedAttachmentName`) and size; size alone never matches, so two files of one size are never swapped (K-2).
   A matched file gets its `sourceId`. **Every original not matched to a file comes back left out**, with its recorded
   reason or else `"removed"`, so reopening never attaches a file by itself, whatever the meta says (K-8); the person
   attaches one with Attach. A missing, unreadable or invalid `forward` keeps today's rebuild (no error shown; logged
   in the console as `draft_forward_unreadable`), and that draft's later saves carry no meta, so they erase nothing.
4. **The eyebrow and the files.** A restored forward shows "Forward" and the files section as a forward started on this
   device does (left-out files with Attach, Retry for a file that failed), with no new string.

## Edge cases

- A forward whose original was deleted since: the meta still names its files; Attach and Retry fail with the existing
  message for an original that cannot be read, and Remove leaves it out. Send works with what is attached.
- Two devices save the same draft: the meta follows the save with the highest revision on Cloudflare; on Gmail (whose
  revisions are not ordered) the last write wins, in the moment between a save and its meta write.
- A meta write that fails is logged and repaired by the forward's next save (every save of a forward carries it);
  a forward whose last save lost its meta and whose device is gone opens as today (K-5, accepted).
- A draft saved by a 1.7.0 app (no meta): opens as today.
- The meta's safety colours are those of the moment the forward started; Attach anyway re-checks nothing new, as on
  the device that started it.

## Second-model review (moonshotai/kimi-k3.1-pro, 2026-11-15)

K-1 taken (revision guard on Cloudflare; Gmail last-write-wins named above); K-2 taken (no size-only match, stored
names on both sides); K-3 taken (creation writes only where none is kept); K-4 not taken: the Gmail creation's key
rotation on an unconfirmed answer is today's behaviour of every draft, not this change's; K-5 accepted as a degrade
(the next save repairs it); K-6 and K-9 taken (absent leaves the meta); K-7 taken for the replace path, while objects
left by a draft deleted in Gmail's own window or by a removed account stay (small, never read: the draft is gone);
K-8 taken (nothing attached by itself on reopen).

## Checks

- `tests/forward-reopen.test.ts`: the meta round trip (write, read, invalid JSON, a wrong shape, a stale version),
  matching by id, by name and size, by size, and an attached original with no server file left out as removed.
- `tests/draft-forward-workerd.test.ts` (workerd): Cloudflare PUT with and without `forward`, a refused save writes
  nothing, GET answers it, DELETE, send and the replace path remove it, a body over the limit or not an object is
  `invalid_forward`. `tests/draft-forward-gmail.test.ts`: the Gmail routes with a fake service and bucket: the
  creation's payload without `forward`, a replay that leaves a later meta, PUT with and without it, GET, DELETE, send.
- The sent message carries no trace of the meta (the send body and the stored sent row compared byte for byte with a
  forward saved without it).
- Gate: `npm test`, `npm run typecheck`, `npm run build`, `docs/ux/lint.py`, `docs/ux/doctor.py`.
