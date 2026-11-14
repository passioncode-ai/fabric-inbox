# S02. Who wrote, to whom: the open message's header (B-268)

**Asked:** «Когда я выбираю какое-то письмо, я хочу, чтобы сверху было видно, кто написал, от кого это письмо, кому, на
какой, и вся копия, скрытая, вся эта информация, название письма, дальше само письмо, аттачменты».

Revised after review round 1 (KIMI-10, UX-18, IR-8, CB-11, CB-12, CB-21).

## Today

- The reader shows the provider and one pill with our receiving address (`unified-inbox.tsx:1610-1617`), the subject
  (`:1614`), and only for a single message the sender, "To", "Cc" when present and the date (`:1625-1637`). In a thread
  each cell shows the sender and date only (`ConversationList.tsx:97-113`).
- Not shown: Bcc, Reply-To, the recipients of a thread's messages.
- `OpenMessage` (`app/components/inbox/model.ts:86-106`) has `to` and `cc?` as strings, no `bcc` or `replyTo`.
  `read_message` already returns `bcc`, `replyTo` and `inReplyTo` (`workers/mcp/tools.ts:139-143, 320`), reading
  Reply-To from the stored headers (`headerValue(parseStoredHeaders(...))`).

## Target

The open message (a single one, or the open cell of a thread) shows, in this order:

1. **Subject**, with the safety badge (S03) at the right of its line. In a thread the subject stays in the reader's
   heading, and the badge there is the open cell's (it follows the open cell); other cells show only a small amber or
   red mark with its word. The subject leads because it names the
   conversation; the operator's list put it after the recipients, recorded as decision D-S02-1 in review.md.
2. **From:** display name and address, the address always shown.
3. **To:** every recipient; our receiving address marked "you" («вы»), which also answers "на какой" (the separate
   "received at" pill merges into it, the provider shown beside it). **Cc** when present.
4. **Bcc:** on mail we sent, its Bcc list. On received mail, Bcc is not known; when our address is in neither To nor
   Cc, and the message has no `List-Id` and did not reach a catch-all, the line reads "Your address is not in To or Cc"
   («Вашего адреса нет в «Кому» и «Копия»»), which is what is known.
5. **Reply-To:** only when it differs from From.
6. **Date:** full date and time in the person's locale; relative time on pointing.
7. Then the body, then the attachments (with S03's chips once S03 lands).

A long recipient list shows the first three and "and {n} more" («и ещё {n}»), opening in place. Each address can be
copied. The other cells of a thread show the compact form in one line: "<name> <address> → <first recipient>, +N".

## Data

`OpenMessage` gains `bcc?: string` and `replyTo?: string` (strings like `to` and `cc`); `normalizeMessage` maps them
from the Cloudflare row (`bcc`, Reply-To from the stored headers, as `read_message` reads it) and from the remote
message routes (Gmail `Bcc` on sent mail, the IMAP envelope, Graph `bccRecipients` and `replyTo`); `List-Id` and
`Delivered-To` are read the same way for the Bcc line. No MCP change: `read_message` already has these fields.

## Words

| English | Russian |
|---|---|
| From | От |
| To | Кому |
| Cc | Копия |
| Bcc | Скрытая копия |
| Reply to | Ответ на адрес |
| you | вы |
| Your address is not in To or Cc | Вашего адреса нет в «Кому» и «Копия» |
| and {n} more | и ещё {n} |

## Acceptance

- Unit: mapping for each account kind; the Bcc line's three conditions; Reply-To only when it differs.
- WebKit walk: a single message, a thread of four with Cc, a sent message with Bcc, a different Reply-To, a mailing-list
  message (no Bcc line).
- SCN-004 refined with these steps (no new row).

## Out of scope

Editing recipients (the composer); every raw header (the headers route stays an action).
