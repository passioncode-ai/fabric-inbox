# S05. A thread reads top to bottom, and each message shows what it answered (B-221)

**Asked:** «я хочу, чтобы все было сверху вниз по мере прихода ... у нас получается такая цепочка, где каждое
сообщение видно, видно вложенности, все письма должны быть атрибутированы по треду, также мы должны видеть какой блок,
на что было отвечено, типа чтобы мы могли развернуть посмотреть, на что конкретно это письмо отвечено».

Revised after review round 1 (UX-7, UX-8, IR-8, IR-10, CB-5, CB-6, CB-21).

## Today

- The unified reader shows a thread oldest first (`app/components/inbox/thread.ts:92`), every message whole in its own
  cell, the last 25 with "Show N earlier messages" (`app/components/inbox/ConversationList.tsx:11,49,64-92`).
- A cell's header: who sent it ("Agent", "You" for outgoing), a role chip and the date (`:97-113`); no recipients.
- Quoted text is not detected or folded; the body goes into the frame as it is (`EmailIframe.tsx:201`).
- No cell shows which message it answers: `normalizeMessage` keeps `message_id` and `email_references` but not
  `in_reply_to` (`model.ts:159-160`); thread rows drop all three (`thread.ts:31-66`); the client `Mail` type has no
  `inReplyTo` (`app/services/fabric.ts:75-92`); Outlook's conversion sets it to "" (`workers/providers/outlook/convert.ts:137`).

## Target

1. **Order and attribution:** oldest first; every cell names who acted in its header: the compact form of S02
   ("<name> <address> → <first recipient>, +N"), the role chip and the date. Our side's cells (a person, an agent, a rule) sit on
   the raised panel colour, received ones on the plain panel.
2. **Nesting:** a reply that answers the cell directly above it is shown flat. A reply that answers an earlier cell is
   indented one level with a rule line, and its header carries "In reply to <name>, <date>" («В ответ на <name>,
   <date>»). That line is a disclosure (`aria-expanded`): it opens, in place, the first lines of the answered message;
   a "Go to message" link there moves focus to that cell (opening "Show N earlier messages" first when it is folded).
   A reply to a message not in the thread shows "In reply to an earlier message" without a disclosure.
3. **Quoted history folded:** the quoted part of a body folds into "Show quoted text" («Показать цитату»), opening in
   place. Detection: `blockquote type="cite"`, Gmail's `gmail_quote`, Outlook's `divRplyFwdMsg` and
   `OLK_SRC_BODY_SECTION`; in text, a trailing block of `>` lines, or the lines after "On <date>, <name> wrote:" or
   «<date>, <name> пишет:». What is not detected stays shown.
4. **Clicks:** a cell's header opens that message (as today) and shows S02's full header block for it; the open cell is
   outlined, and its actions (reply, forward, the agent panel, the badge) apply to it.
5. **Events as thin rows:** a rule's action and the safety check's decision on a message of the thread show as one-line
   rows between cells ("The rule <name> forwarded this to <address>", "The safety check held this message").

## Data, routes and tools

- `fromCloudflare` and `fromRemote` keep `inReplyTo`, `references` and `rfcMessageId`; the client types gain
  `inReplyTo`; Outlook's conversion keeps the header. The answered cell is found by `message_id` (sent and received
  rows) and by internal id (an agent's draft, whose `in_reply_to` is the internal id, `runner.ts:1193`).
- Events are read from the routes the app already has, not a new one (decided while building, 2026-11-14): the rule
  history (`GET /api/automation/:account/runs`) and the safety lookup (`POST /api/safety/lookup`), joined by message id
  in a pure function (`threadEvents`, `app/components/inbox/quotes.ts`). Agents read the same facts through the existing
  `list_rules` and `list_held_messages` tools, so no new route needs a tool, and a key's scope stays as it is. A member
  who cannot read the rule history sees no rule rows.

## Words

| English | Russian |
|---|---|
| In reply to {name}, {date} | В ответ на {name}, {date} |
| In reply to an earlier message | В ответ на более раннее письмо |
| Go to message | Перейти к письму |
| Show quoted text | Показать цитату |
| Hide quoted text | Скрыть цитату |

## Acceptance

- Unit: quote detection on Gmail, Outlook, Apple Mail, plain text and Russian fixtures, and a message with no quote.
- Unit: nesting: replies to the cell above are flat, others indented; the answered cell by `message_id` and by draft id.
- Unit: the events route and its tool.
- WebKit walk: a thread of six with two replies to the same message; the disclosure and "Go to message".
- SCN-008 and B-221's scenario updated.
