# S09. Forward takes the original files along, each removable (B-274)

**Asked:** «чтобы мы при форвардах типа автоматически у нас прикреплялись типа все аттачменты, но мы при желании могли
во время форварда типа убрать это, просмотреть интерфейс типа форварда, сэнда вот этого всего, чтобы корректно все
работало».

Revised after review round 1 (KIMI-9, UX-12, UX-20, IR-7, IR-12, CB-13). Lands in W3, after S03.

## Today

- Forward lists the original files but attaches them only on "Include original attachments"
  (`app/components/inbox/Composer.tsx:579-614`, `includeOriginals` `:284-360`).
- `missingOriginals` means "in the original but not included" (`compose-payload.ts:11-15`), so removing an included
  original makes Send refuse again ("Include all original attachments before forwarding", `:42-45`;
  `tests/attachment-composer.test.ts:308-331` checks the refusal).
- The bound for one message is 10 files and 5 MiB (`shared/mail/attachments.ts:10-11`).

## Target

- **Step 0 of the build: walk today's forward and send** in WebKit on the preview fixture (HTML and text originals, with
  and without files, Cc and Bcc, a send that fails) and record each defect here with `file:line`, fixed in this change
  or filed as a row.
- **Originals attached at once**, in the original's order, as the composer opens (the same `includeOriginals` path);
  while they load each shows its progress and Send waits with "Attaching files…" («Прикрепляем файлы…»).
- **Each file can be removed.** A removed original is left out on purpose: the draft keeps a `leftOut` set of original
  attachment ids (allowed by the draft sanitizer, `draft-store.ts:190`, and part of `contentKey`, `server-drafts.ts:193`;
  drafts saved before default to an empty set). `missingOriginals` becomes "in the original, not included and not left
  out". Send is refused only by an original that failed to load and was neither retried nor removed. The string
  "Include all original attachments before forwarding" and its Russian are retired.
- **More than fits:** originals are attached in order while they fit in 10 files and 5 MiB; the rest are listed as
  "Did not fit in one message" («Не поместился в одно письмо», plural forms through `t.plural`) with their size, in
  `leftOut`. Adding the person's own file when there is no room says "No room left: remove a file first" («Места нет:
  сначала уберите файл»).
- **The safety chip** (S03's file colour, by attachment id): amber files are attached with their chip and its word;
  a red file is not attached by itself and goes into `leftOut`, so Send is not refused ("Not attached: the safety check found this file dangerous" / «Не прикреплён:
  проверка нашла файл опасным», with "Attach anyway" / «Всё равно прикрепить»); a file with no verdict is attached with
  a grey "Not checked" chip.
- **The screen:** From (the account the message arrived at, changeable as today), To, Cc, Bcc, subject "Fwd:
  <subject>", the person's text, then the original as it was (SCN-009, 2026-10-21), then the files. Send states as the
  composer's (`send-state.ts`).

## Acceptance

- Unit (`tests/attachment-composer.test.ts`, the refusal test rewritten): originals attached on open; removing one
  allows send and survives a reload; over the bound fills in order and lists the rest; a failed load blocks until
  Retry or Remove; a red file is not attached by itself.
- WebKit walk: a message with 3 files, one removed, forwarded; the sent payload carries 2.
- SCN-009 updated; the defects of step 0 listed with their outcome.

## Step 0: today's forward and send, defects found (read on `dec524ef`)

Walked as a code read of the forward and send path, not in WebKit (see "Built as").

| # | Defect | Where | Outcome |
|---|---|---|---|
| D1 | The original's files attach only on "Include original attachments" | `Composer.tsx:579-614` | Fixed: attached as the composer opens |
| D2 | Removing an included original makes Send refuse | `compose-payload.ts:42-45` | Fixed: `leftOut`, the refusal string retired |
| D3 | More than 10 files or 5 MiB of originals: the whole include is refused by the bound, so such a forward could never be sent | `attachment-store.ts:37`, `:59` (called from `includeOriginals`) | Fixed: planned in order while they fit, the rest left out as did not fit |
| D4 | One original failing to load leaves every later one unloaded (the capture loop stops at the first failure) | `attachment-store.ts:184-193` | Fixed: originals are captured one at a time; each failure has Retry and Remove |
| D5 | The forwarded original shows inside the attachments section, after the files | `Composer.tsx:574` | Fixed: after the text, before the files |
| D6 | A forward reopened from Drafts comes back as a new message with no `forwardSource`: its eyebrow says "New message" and its originals are plain saved files (no Retry, no Attach for a left-out file) | `server-drafts.ts:248`, `:255` | Open: the server draft keeps no forward source; for the W4 audit's board |

## Built as (2026-11-14)

- **Files and tests.** `app/components/inbox/forward-files.ts` (the plan, `leftOut` changes, retry), `compose-payload.ts`
  (`missingOriginals` skips `leftOut`; the refusal is "Some of the original's files are not attached. Retry or remove each
  one."), `draft-store.ts` (`leftOut` sanitized; `forwardSource.files[].safety` optional), `server-drafts.ts`
  (`contentKey` carries `leftOut`), `Composer.tsx` (`attachOriginals`, `LeftOutFiles`, `SafetyChip`). Unit tests in
  `tests/attachment-composer.test.ts` (the refusal test rewritten), the agent's `forward` `leaveOut` in
  `tests/mcp-parity.test.ts`.
- **`leftOut` entries carry a reason** (`{ id, why: "removed" | "no-room" | "dangerous" }`), not bare ids, so the screen
  says why each file is out and offers Attach or Attach anyway. Every entry can be put back.
- **"While they fit" fills greedily in order:** a file that does not fit is left out and a later, smaller one is still
  attached (4 MiB, 2 MiB, 0.5 MiB attaches the first and the third).
- **The safety chip waits for S03.** S03 is not built on this branch, so no file has a colour yet. The plan and the
  screen read an optional `safety` on each original (`green`, `grey`, `amber`, `red`); a red one is left out as
  dangerous, and the chip ("Checked", "Not checked", "Suspicious", "Dangerous") shows only where a colour is given.
  With no colour nothing is shown, rather than "Not checked" on every file before any check exists. When S03 lands, it
  fills `safety` when the forward is made (`unified-inbox.tsx`, `forwardSource`), grey for a file with no verdict.
- **The agent's door.** The app's new function (remove one original from a forward) is the `forward` tool's new
  `leaveOut` (attachment ids from `read_message`; an unknown id is refused, nothing sent); no route changed.
- **Not walked in WebKit.** The walk of a 3-file forward with one removed is left to the W4 audit; its unit form (the
  sent payload carries 2 of 3) is in `tests/attachment-composer.test.ts`.
- **Copy check:** the 18 new English strings and their Russian, the organization's copy check in the `ui` register, 37
  reports, no findings.
