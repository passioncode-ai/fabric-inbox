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
