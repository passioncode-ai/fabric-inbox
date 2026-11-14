# S02. Who wrote, to whom: the open message's header (B-268)

**Asked:** «Когда я выбираю какое-то письмо, я хочу, чтобы сверху было видно, кто написал, от кого это письмо, кому, на
какой, и вся копия, скрытая, вся эта информация, название письма, дальше само письмо, аттачменты».

## Today

- The reader shows the provider and one pill with our receiving address (`unified-inbox.tsx:1610-1617`), the subject
  (`:1618`), and only for a single message the sender, "To", "Cc" when present and the date (`:1625-1637`). In a thread
  the block is hidden and each cell shows the sender and date only (`app/components/inbox/ConversationList.tsx:97-113`).
- Not shown anywhere: Bcc, Reply-To, the recipients of a message in a thread.
- `OpenMessage` (`app/components/inbox/model.ts:86-106`) has `to` and `cc?` but no `bcc` or `replyTo`;
  `normalizeMessage` (`:120-163`) maps Cloudflare rows from `recipient` and `cc`; the stored row also has `bcc`
  (`app/types/index.ts:25-54`) and the full headers are readable for remote accounts at
  `/api/accounts/:id/messages/:mid/headers` (`workers/routes/accounts.ts:407`).

## Target

The reader's top, in this order, for a single message and for the open cell of a thread:

1. **Subject** (as today), with the safety badge (S03) at the right of the same line.
2. **From:** display name and address; the address is always shown, not only the name (a name alone is how
   impersonation works).
3. **To:** every recipient, our receiving address marked "you" («вы»); **Cc** when present; **Bcc** when we know it: on
   mail we sent, and on received mail where our address is in neither To nor Cc ("You were in Bcc", «Вы в скрытой копии»).
4. **Reply-To:** only when it differs from From, with its domain marked when it differs (that is S03's reply-path
   signal, shown here as a fact).
5. **Date:** full date and time in the person's locale; relative ("2 h ago") on pointing.
6. **Received at:** the account pill as today (provider and our address).
7. Then the body, then the attachments with their verdicts (S03).

A long list of recipients shows the first three and "and N more" («и ещё N»), opening in place. Every address can be
copied (the B-15 Copy button pattern). In a thread, each cell's header shows "From → To" in one line, and its details
open on a click with the same block as above (S05).

## Data and API

- `OpenMessage` gains `bcc?: Address[]` and `replyTo?: Address[]`; `normalizeMessage` maps them from the Cloudflare
  row (`bcc`, the stored Reply-To header) and from the remote message (Gmail, IMAP and Outlook routes return them; where
  a route does not, it reads the headers route once when the details open).
- The remote message route returns `bcc` and `replyTo` when the provider has them (Gmail `Bcc` exists only on sent
  mail; IMAP envelope; Graph `bccRecipients`, `replyTo`).
- MCP: `get_message` already returns the stored fields; its output gains `bcc` and `replyTo` where it lacks them
  (`workers/mcp/tools.ts`), and `npm run mcp:docs` regenerates the reference.

## Words

| English | Russian |
|---|---|
| From | От |
| To | Кому |
| Cc | Копия |
| Bcc | Скрытая копия |
| Reply to | Ответ на адрес |
| you | вы |
| You were in Bcc | Вы в скрытой копии |
| and {n} more | и ещё {n} |
| Received at | Получено на |

## Acceptance

- Unit: `normalizeMessage` maps bcc and replyTo for each account kind; "You were in Bcc" only when our address is in
  neither list; Reply-To shown only when it differs.
- WebKit walk on the preview fixture: a single message, a thread of four with Cc, a sent message with Bcc, a message
  with a different Reply-To.
- SCN-004 or a new SCN row "Read who a message is from and to whom" with these steps.

## Out of scope

Editing recipients (that is the composer); showing every raw header (the headers route stays an action).
