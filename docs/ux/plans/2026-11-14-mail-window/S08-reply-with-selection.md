# S08. Select text, press Reply: the reply quotes that text (B-273)

**Asked:** «если мы выделяем какой-то текст и нажимаем reply, то у нас reply будет выделением именно этот текст ...
чтобы подсказывались, что типа выделяем какой-то текст и нажимаем reply».

Revised after review round 1 (SEC-13, SEC-14, KIMI-5, UX-11, IR-11, CB-14, CB-15).

## Today

Reply starts with the signature only (`unified-inbox.tsx:867-874`); nothing reads a selection. HTML bodies are in a
sandboxed frame without `allow-same-origin` (`EmailIframe.tsx:217`); text bodies render in the page as `<pre>`
(`unified-inbox.tsx:957-958`). The reply composer works in plain text (`server-drafts.ts:93`, `shared/mail/text.ts:34`).
A quote builder with "On {date}, {sender} wrote:" exists (`app/lib/utils.ts:167-188`).

## Target

- **The frame script everywhere:** this spec makes the frame's script run for every message, not only with `autoSize`
  (`EmailIframe.tsx:133`, `SingleMessageView.tsx:44`, `ThreadMessage.tsx:161`); S04 (W3) extends the same script.

- **The hint, always:** Reply's and Reply all's tooltip reads "Select text in the message to quote it" («Выделите текст
  в письме, чтобы процитировать его»).
- **Reading the selection:**
  - HTML bodies: the frame's script posts `{type: "selection", text, rect}` on `mouseup` and `keyup` and an empty one
    when it clears. The text is only what is rendered and visible (each range's text nodes whose computed style is
    visible, non-zero size, not clipped), with zero-width and bidi characters removed, at most 4,000 characters.
  - Text bodies: `document.getSelection()` inside the `<pre>`.
  - The reader accepts a selection message only from its own frame, with user activation, re-checks type and length,
    and clears the held selection when the frame reloads or another message opens.
- **While a selection is held:** a small button "Reply with quote" («Ответить с цитатой») sits at the selection's end
  (from `rect`, inside the reader's pane).
- **Reply or Reply all with a selection:** the body starts with the existing quote header in text ("On {date}, {name}
  wrote:" / «{date}, {name} пишет:»), the selection as `>` lines (reusing the builder in `app/lib/utils.ts` as text),
  an empty line, then the signature. The quote is ordinary, editable text in the composer.
- **Without a selection:** unchanged (Q8).
- No keyboard shortcut is added (the window has no reply shortcut today).
- Quoted text that later reaches an agent (a reply agent reading the thread) is quoted text inside the untrusted fence,
  as every message body already is.

## Words

| English | Russian |
|---|---|
| Select text in the message to quote it | Выделите текст в письме, чтобы процитировать его |
| Reply with quote | Ответить с цитатой |

## Acceptance

- Unit: the quote builder (text), trimming, the 4,000 limit, a selection with `</blockquote><img onerror>` stays text.
- Unit: the frame script's visible-text extraction skips a `visibility:hidden`, a zero-size and an off-screen span.
- Unit: a selection message from another source or without activation is ignored; reload clears it.
- WebKit walk: select a sentence in an HTML and in a text message, Reply, the composer opens with the quote.
- SCN-008 gains the step.
