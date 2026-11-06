# Reading a conversation, attachments and the agent's actions (plan, 2026-11-06)

Status: plan, 2026-11-06. Specs follow per wave; scenarios first for every interface change (SCN updates in
`docs/ux/scenarios.md`, then code). Rows B-221 to B-230 in [the board](../../evidence/backlog.md).

## What the operator asked

Said 2026-11-06 in this repository's session, verbatim:

> «Дальше проверить как работают все ошибки в текущем инбоксе. Там где-то ошибка отправки, еще где-то посмотреть как
> UX или у нас вопросы удобно решаются с инбоксом. чтобы письмо само было удобно читаемо, сделать письмо нормально,
> чтобы было видно секциями. секция типа пользователь написал аишка ответила либо аишка suggested и так вот типа как в
> чате как сообщение в чате такими ячейками типа сверху вниз типа по все действия, чтобы ничего там не мешалось, не
> пресекалось, было понятно, где там кто что. Дальше вложения нужно уметь обрабатывать. Каждое вложение, перед тем, как
> его открыть. особенно pdf и всякие html что-то может быть нужно проверить [...] чтобы аишки проверяли чтобы можно было
> сделать взять summary из документов типа чтобы агент если видишь что типа пришел письмо тебя предлагал сделать summary
> то есть какие-то шорткаты пусть появятся для каждого письма маленькие снизу справа и в зависимости от шорката будет
> открываться агент с справа на виджете, и это действие ему будет передаваться. Плюс интерфейс проработать агентский,
> вот это в чате, тоже как он выглядит хорошо. При нововведении на иконке показывать подсказки, что это за кнопки, сейчас
> многие иконки всякие непонятные [...] ставим план. Дальше идем декомпозируем этот план, пишем спейки, волнами»

> «сделать чтобы правой кнопкой мышки на всякие кнопки ссылки открывалась там где копировать ссылку [...] и сразу выбор
> открытия в браузере. Не как новое меню, а сразу же в этом списке. Список браузеров, открыть в»

The organization part of the same message (personal by default, one PassionCode sign-in, organizations pulled in) is a
system-wide model owned by the organization service and the platform; it went to them on the board (thread `22876238`,
message `8aa57c73`, answers due 2026-11-09). Inbox's side of it is I10 below.

## What is there today (read 2026-11-06 at `023c4f9`)

- **Two reading surfaces.** The unified inbox (`app/routes/unified-inbox.tsx`) and the older Cloudflare mailbox view
  (`app/components/EmailPanel.tsx`, `app/routes.ts:20-33`).
- **A thread** is one `<article>` per message, oldest first, every one open, the newest 25 (`ConversationList.tsx:11`,
  `:22`, `:64`). Quoted text is never folded: the HTML goes whole into `EmailIframe`.
- **Who did what.** `ThreadRow.kind` and `sentBy` (`agent`, `agent_waiting`, `person`; `inbox/thread.ts:11-23`) give a
  chip per message (`ConversationList.tsx:97-113`). A person sending the agent's draft reads only as `person`; Gmail,
  IMAP and Outlook rows carry neither (`thread.ts:52-67`). Rule actions have no trace on the message.
- **Attachments** in the unified inbox are download buttons only (`unified-inbox.tsx:922-942`); no preview. The safety
  check reads up to 3 documents per message to 20k characters (`workers/safety/files.ts`), and nothing else uses that
  text: the reply agent cannot open attachments (`workers/agents/runner.ts:351`).
- **The agent panel** (`AgentDock.tsx`, `AgentPanel.tsx`) reads one Cloudflare mailbox and gets `{emailId, subject}`
  only (`unified-inbox.tsx:511`); no prefilled action can be passed (`AgentPanel.tsx:356-370`). Gmail, IMAP and Outlook
  mail gets a note instead (`AgentDock.tsx:102-106`).
- **No per-message AI action** (summary, translation, ask about this message) exists.
- **Icon buttons with no visible hint:** about 25 have an `aria-label` but no tooltip (`unified-inbox.tsx:1076`, `:1456`,
  `:1509`, `:1132`, `:1152`, `:1252`, `:1718`; `AgentDock.tsx:92`; `AgentPanel.tsx:518`; `Composer.tsx:433`, and others).
  Two mechanisms coexist: native `title` in the unified inbox, Kumo `<Tooltip>` elsewhere.
- **Sending.** The server's own error counts show no failed send from 2026-10-30 to 2026-11-06 (`get_server_errors`,
  read 2026-11-06); the one error was `agent.model` on 2026-11-05. The older mailbox view says only "Failed to send
  email." (`EmailPanel.tsx:155`, `useComposeForm.ts:307`), with no reason. B-155 (a failed send after dispatch read as a
  refusal over MCP) is in review.

## The items

| # | What | Row |
|---|---|---|
| I1 | **A conversation as a chat, top to bottom.** One cell per step, each naming who acted: the customer wrote; the agent answered; the agent suggests (a draft waiting); a person approved and sent the agent's draft; a person wrote; a rule or the safety check acted (a thin event row). Quoted text folded ("Show quoted"). Nothing overlaps; the reply bar stays below the last cell. Gmail, IMAP and Outlook rows get the same roles where the server knows them. | B-221 |
| I2 | **Attachments checked before they open.** Every attachment shows its verdict before Open: type matches its content, no code-running file, no hidden instructions in a PDF or HTML, a known-bad hash. Images, PDF and text preview inside the app in a sandbox; HTML opens as sandboxed text; a risky file asks once before it downloads. The checks that exist (`workers/safety/files.ts`) run for every attachment and every account kind. The browser-security product's detectors (download guard, hidden-instruction detection) are asked for as a library the server can run. | B-222 |
| I3 | **Agents read attachments.** A tool that returns an attachment's text (PDF, documents, HTML as text), within the limits the safety check uses; the chat agent and reply agents can cite it. | B-223 |
| I4 | **Shortcuts per message.** Small chips at the lower right of each message (Summarize, Summarize attachments, Draft a reply, Translate, Ask): one click opens the agent panel on the right with that action and the message's context passed in. The agent may suggest a chip itself ("this mail has a 12-page PDF: summarize?"). Works for every account kind. | B-224 |
| I5 | **The agent panel reworked.** Clear bubbles for the person and the agent, tool calls folded into one line each, sources as links to messages, the action that opened it shown on top, states (empty, thinking, error, stopped) that read at a glance. | B-225 |
| I6 | **Every icon says what it does.** One tooltip component on every icon button (label and shortcut), replacing native `title`; a one-time hint on an icon that is new in a release. | B-226 |
| I7 | **Right click on a link or button.** The context menu of the desktop app gains Copy Link and Open In with the installed browsers listed in the same menu, not a submenu of its own (macOS, Windows, Linux). | B-227 |
| I8 | **Sending errors, every surface.** Reproduce the send error the operator met; give the older mailbox view the same reasons as the composer; one wording per cause; a test per cause. | B-228 |
| I9 | **A walk of answering mail end to end.** The test panel walks reading, answering, approving an agent's draft and attachments in the app; findings become rows. | B-229 |
| I10 | **Organizations from PassionCode.** After one PassionCode sign-in the app adds the person's organizations' servers by itself, beside their own; sign-in by attestation (B-159) and the shared mailbox appearing by itself. Waits for the owners' model (thread `22876238`). | B-230 |

## Waves

1. **Now.** I8 (reproduce and align the send errors), I6 (tooltips), I7 (context menu): small, independent; their
   scenario lines first.
2. **Scenarios and look.** SCN updates for I1, I2, I4, I5 (`/ux`), their look (sheleg-design) and words (copywriting,
   Russian through `shared/i18n/ru/`), approved before code.
3. **Reading.** I1, then I9's first walk over it.
4. **Attachments.** I2 and I3, with the browser-security product's answer on its detectors.
5. **Agent actions.** I4 and I5.
6. **Organizations.** I10, after the owners answer on thread `22876238` (due 2026-11-09).

Each wave ships as its own release with its tests, the MCP tools for any new route (`workers/mcp/tools.ts`,
`npm run mcp:docs`) and Russian strings.
