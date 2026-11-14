# S09. Forward takes the original files along, each removable (B-274)

**Asked:** «чтобы мы при форвардах типа автоматически у нас прикреплялись типа все аттачменты, но мы при желании могли
во время форварда типа убрать это, просмотреть интерфейс типа форварда, сэнда вот этого всего, чтобы корректно все
работало».

## Today

- Forward lists the original files but does not attach them; the person must press "Include original attachments"
  (`app/components/inbox/Composer.tsx:579-614`, `includeOriginals` `:284-360`).
- Each included file has Remove (`:537-566`), yet sending is refused while any original is missing ("Include all
  original attachments before forwarding", `app/components/inbox/compose-payload.ts:42-45`, `missingOriginals`
  `:11-15`): in practice an original cannot be left out.
- The bound for one message is 10 files and 5 MiB (`shared/mail/attachments.ts:10-11`).

## Target

- **Forward attaches the originals at once**, in the order of the original, as the composer opens (the same
  `includeOriginals` path, started by itself). While they load, each shows its progress; Send waits for them, with
  "Attaching files…" («Прикрепляю файлы…»).
- **Each file can be removed** before sending; a removed original is left out on purpose, so sending is allowed. The
  "Include all original attachments before forwarding" refusal is removed; `missingOriginals` remains only for files
  that failed to load and were not removed (those still block, with Retry and Remove on each).
- **More than fits:** the files that fit within 10 files and 5 MiB are attached in order; the rest are listed as "Left
  out: too large for one message" («Не поместилось в одно письмо») with their size; sending is allowed (Q9).
- **The forward screen reviewed:** From (the account the message arrived at, changeable as today), To, Cc and Bcc,
  subject "Fwd: <subject>", the person's text, then the original (HTML as it was, SCN-009 2026-10-21), then the files.
  A file with an amber verdict (S03) is attached with its verdict chip; a red one is not attached by itself ("Not attached: the safety check found this file dangerous", with "Attach anyway").
- **Send states:** the composer's (`send-state.ts`), unchanged.

## Words

| English | Russian |
|---|---|
| Attaching files… | Прикрепляю файлы… |
| Left out: too large for one message | Не поместилось в одно письмо |
| Not attached: the safety check found this file dangerous | Не прикреплён: проверка сочла файл опасным |
| Attach anyway | Всё равно прикрепить |

## Acceptance

- Unit (`tests/attachment-composer.test.ts` extended): originals attached on open; removing one allows send; over the
  bound attaches the first that fit and lists the rest; a failed load blocks until Retry or Remove.
- WebKit walk on the fixture with a message of 3 files, one removed, forwarded; the sent payload carries 2.
- SCN-009 updated (its "Only chosen successfully prepared attachments go" stays true).
