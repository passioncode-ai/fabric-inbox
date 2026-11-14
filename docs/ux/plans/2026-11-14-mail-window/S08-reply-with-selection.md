# S08. Select text, press Reply: the reply quotes that text (B-273)

**Asked:** «если мы выделяем какой-то текст и нажимаем reply, то у нас reply будет выделением именно этот текст ...
чтобы подсказывались, что типа выделяем какой-то текст и нажимаем reply».

## Today

Reply and Reply all start with the signature only; the original is not quoted (`unified-inbox.tsx:876`); no code reads
a selection (`getSelection` appears nowhere in `app/`). The body is in a sandboxed frame without `allow-same-origin`
(`EmailIframe.tsx:217`), so the reader cannot read the frame's selection directly.

## Target

- The frame's script (the one that reports height) reports a non-empty selection on `mouseup` and `keyup`
  (`postMessage({type: "selection", text})`, at most 4,000 characters) and an empty one when it clears.
- While a selection is held in a message, a small floating button "Reply with quote" («Ответить с цитатой») shows
  next to it, and the reply bar's Reply and Reply all show "Reply quoting the selection" on pointing.
- Reply or Reply all with a selection: the draft's body starts with "On <date>, <name> wrote:" («<date>, <name>
  пишет:») and the selected text as a quote (`>` lines in text, a `blockquote type="cite"` in HTML), then an empty
  line for the answer, then the signature. The selection belongs to the message it was made in: replying from that
  message's cell answers that message.
- Without a selection: unchanged (Q8).
- Keyboard: the existing reply shortcut does the same with a selection.

## Words

| English | Russian |
|---|---|
| Reply with quote | Ответить с цитатой |
| Reply quoting the selection | Ответить, процитировав выделенное |
| On {date}, {name} wrote: | {date}, {name} пишет: |

## Acceptance

- Unit: the quote builder (text and HTML), selection trimmed, at most 4,000 characters, HTML escaped.
- Unit: the frame script posts the selection and clears it.
- WebKit walk: select a sentence, Reply, the composer opens with the quote.
- SCN-008 gains the step.
