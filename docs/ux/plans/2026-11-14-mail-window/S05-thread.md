# S05. A thread reads top to bottom, and each message shows what it answered (B-221)

**Asked:** «я хочу, чтобы все было сверху вниз по мере прихода ... у нас получается такая цепочка, где каждое
сообщение видно, видно вложенности, все письма должны быть атрибутированы по треду, также мы должны видеть какой блок,
на что было отвечено, типа чтобы мы могли развернуть посмотреть, на что конкретно это письмо отвечено».

## Today

- The unified reader shows a thread oldest first (`app/components/inbox/thread.ts:92`), every message whole in its own
  cell, the last 25 with "Show N earlier messages" (`app/components/inbox/ConversationList.tsx:11,49,64-92`).
- A cell's header: who sent it ("Agent", "You" for outgoing), a chip (Draft, Agent's answer, Agent's waiting reply,
  Sent by a person) and the date (`:97-113`). Recipients are not shown per cell (S02).
- Quoted text is not detected or folded; the body goes into the frame unchanged (`EmailIframe.tsx:181-186`), so a
  reply repeats the whole history below its own lines.
- No cell shows which earlier message it answers; `In-Reply-To` and `References` are used only when composing
  (`unified-inbox.tsx:887-889`).
- The open message's actions (HeldPanel, AgentRunPanel, body, attachments, `:939-984`) render inside its cell; a click
  on another cell opens that message.

## Target

1. **Order and attribution:** oldest first as today; every cell names who acted, in one header line:
   "<Name> → <recipients>" (S02's compact form), the role chip as today, and the date. Cells by our side (a person,
   an agent, a rule) are set on the right half's tint (`--pc-panel-raised`), received ones on the plain panel, so the
   conversation reads as two sides without bubbles that waste width.
2. **What it answers:** a cell whose `In-Reply-To` (or last `References` entry) matches an earlier message of the thread
   shows a thin line above its body: "In reply to <Name>, <date>" («В ответ на <Name>, <date>»); clicking it scrolls to
   that cell and outlines it for 2 seconds. A reply to a message not in the thread shows "In reply to an earlier
   message" with no link.
3. **Quoted history folded:** the quoted part of a body is folded into one line "Show quoted text" («Показать
   цитату»), opening in place. Detection: an HTML `blockquote` with `type="cite"`, Gmail's `gmail_quote`, Outlook's
   `divRplyFwdMsg` / `OLK_SRC_BODY_SECTION`, Apple Mail's `blockquote type=cite`; in text, a trailing block of `>` lines
   or after an "On <date>, <name> wrote:" line in English or Russian («<date>, <name> пишет:»). What cannot be detected
   stays shown; nothing is cut from a message that has no quote.
4. **Every cell readable without opening it:** the body of every cell shows (as today); the open cell is the one whose
   actions (reply, forward, agent panel, safety badge) apply, marked by its outline.
5. **Events as thin rows:** a rule's action and the safety check's decision on a message of the thread show as one-line
   event rows between cells ("Rule 'Invoices' forwarded this to ...", "The safety check held this message"), from the
   run and safety records the server keeps (B-221's "a rule or the safety check acted").

## Data and API

- The Cloudflare thread route already returns `in_reply_to` and `email_references` per row
  (`workers/index.ts:400-420`); `normalizeMessage` keeps them (`model.ts:150-160`). Remote threads: `rfcMessageId`
  and `references` exist on `OpenMessage`; In-Reply-To is read from the same fields.
- Rule and safety events: the thread route gains `events: {at, kind, text-key, args}` for the thread's messages,
  read from the automation runs and the safety table by message id (Cloudflare first; remote accounts where the run
  record names them). MCP `read_thread` returns them too (`npm run mcp:docs`).

## Words

| English | Russian |
|---|---|
| In reply to {name}, {date} | В ответ на {name}, {date} |
| In reply to an earlier message | В ответ на более раннее письмо |
| Show quoted text | Показать цитату |
| Hide quoted text | Скрыть цитату |

## Acceptance

- Unit: quote detection on fixtures from Gmail, Outlook, Apple Mail, a plain text reply, a Russian «пишет:» line, and a
  message with no quote (nothing folded).
- Unit: the reply link resolves by In-Reply-To, then References, then shows the no-link line.
- WebKit walk: a thread of six with two replies to the same message, folding and the scroll to the answered cell.
- SCN-008 and B-221's scenario updated.

## Out of scope

Threading changes on the server (which messages form a thread stays as it is).
