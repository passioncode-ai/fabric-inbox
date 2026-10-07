Contract: brand-contract v1

# Terminology

## Product terms — always
| Our term | Never write | Applies to |
|---|---|---|
| Rule | Automation recipe | Saved bounded automation |
| Run | AI job | One recorded rule invocation |
| Dry-run | Trial send | Preview with no external side effects |
| Agent | Bot, AI assistant (for address agents) | Reusable versioned definition that answers mail on assigned addresses |
| Project address | Alias, forwarding address | An address on a served project domain, received by the Worker |
| Reply policy | Auto-reply settings | What an agent may send without the operator: mode, allowed intents, daily limit |
| Answer | AI response (in run history) | One agent run for one incoming message |
| Settings | Manage accounts, Mailboxes screen, Accounts and rules, Server settings, Domains & addresses (screen names before 0.11) | The one screen for everything set up rather than read, with its sections: Addresses, Domains, Accounts, Forwarding destinations, Categories, Spam rules, Discard rules, Agents, Knowledge, Agent access, App; a section is named "Settings → Domains" |
| Server address | Server settings (the Mac app's menu item) | The address of the server the Mac app opens, chosen in its own window (Fabric Inbox → Server address…) |
| Receive mail here | Connect domain, Import domain | Moving a domain's mail to the server, keeping each old destination as a copy |
| Forwarding destination | Forward target, verified email | An outside address a copy may go to, confirmed through Cloudflare's link |
| Your server | Backend, instance, origin (to a user) | The Fabric Inbox Worker in the person's own Cloudflare account |
| Knowledge collection | Knowledge base, KB, vector store (for one set) | A named set of documents an agent may search when it is ticked on it |
| Passage | Chunk, snippet (to a user) | A part of a document found for a message and given to the agent with its source |
| Notes the agent always sees | Knowledge (for the inline field, since 0.4) | The short text sent with every message |
| Category | Filter, label, smart folder | A view of the mail that matters beside Focus: where it looks, and optionally what belongs, in words or plain conditions |
| Project | Workspace, group (for a set of domains) | A named set of domains and addresses one product uses, chosen as the place a category looks |
| Sort (a message into a category) | Classify, tag (to a user) | The conditions or the model placing a message in a category, with a reason |
| Your addresses | Internal, own mail | The triage group for mail sent from the domains this server serves |
| Spam | Junk, junk mail, bulk folder | The folder mail goes to when the filter or the operator says it is unwanted; deleted after 30 days |
| Report spam | Mark as junk, Block sender | Moving a message to Spam and putting its sender on the Always spam list |
| Not spam | Not junk, Unblock | Bringing a message back from Spam and putting its sender on the Never spam list |
| Spam rules | Spam settings, filters | The screen with what goes to Spam and the Always spam / Never spam lists |
| Discarded | Bin, Rubbish, Thrown away (for this folder) | The folder of mail thrown away on purpose (⌘⌫), apart from Trash and Spam; counts as deleted, kept 30 days so a mistake can come back; Russian UI: «Выброшенные» |
| Discard (a message) | Throw away, Bin (for ⌘⌫) | Sending a message to Discarded and teaching a rule from it; "Discard" on a draft is another action (throwing the draft away) |
| Not discarded | Undiscard, Undelete | Bringing a message back from Discarded to the inbox |
| Discard rule | Block rule, auto-delete rule | What a discard teaches: a mailing list (List-Id) or a sender whose new mail goes straight to Discarded |
| Discard rules | Discard settings | The Settings section with every discard rule, why it was learned, and Always allow |
| Always allow | Whitelist, safe-sender list | Senders and domains no discard rule ever takes on arrival |
| Stop discarding mail like this | Unblock sender | Removing the rule that would discard such mail again |
| Agent access | API access, integrations, MCP settings | The screen where the owner gives outside agents their keys and sees what they changed |
| Agent key | API key, agent token, access token, credential (to a user) | One outside agent's way in: a Client ID and a Client Secret, with a level and a sending mode |
| Cloudflare API token | API key, Cloudflare key, credential (to a user) | What a person creates in Cloudflare (My Profile or Manage Account → API Tokens) and gives the server: one for the server's own account, one for each other account connected in Settings → Accounts; "token" alone once the context has named it (operator, 2026-10-01) |
| Outside agent | Bot, integration, app (for a keyed agent) | An AI agent the owner runs elsewhere (Claude Code, Cursor, their own) that works with Fabric Inbox through its key; never an Agent that answers an address |
| Drafts only / Can send | Read-write, full access (for sending) | Whether an agent key's mail waits in Drafts for the owner or leaves, within its daily number |
| Revoke | Delete key, disable | Ending an agent key: it stops working at once |
| App password | Mail password, IMAP password | A password the person makes at their mail provider for one app (Apple names it app-specific password in its own menus); checked with the provider, then kept encrypted on the server and never shown again |
| IMAP account | IMAP connection, mail connector | A mail account read over IMAP and sent over SMTP with an app password (iCloud Mail, Yahoo Mail, Fastmail…); named `imap:<id>` to agents |
| Other mail | Other accounts, generic mail | The Settings card ("Other mail (IMAP)") and the sidebar group for IMAP accounts |
| Enter a new app password | Reconnect (for an IMAP account), re-authenticate | What fixes an IMAP account whose provider refused the app password |
| Outlook account | Hotmail account, Exchange account, Microsoft account (for the mailbox) | An Outlook.com, Hotmail, Live or Microsoft 365 mailbox read and sent through Microsoft Graph with the person's own Microsoft sign-in; named `outlook:<id>` to agents |
| App registration | Azure app, Microsoft app, OAuth app (for Microsoft) | The owner's own application in Microsoft Entra that Outlook accounts sign in through, by Microsoft's own name |
| Client secret | Microsoft password, app key | The app registration's secret Value, saved on the server with the date it expires; never the Secret ID |
| Administrator's approval | Admin consent (to a user), tenant approval | What an organization that lets only administrators allow apps needs before its people can connect: the link the person sends their administrator |
| Address (the part before @) | Local part, username, mailbox name (to a user) | What is typed in Add address; the domain is chosen beside it |
| Add address | New mailbox, Create alias, Add alias | The one dialog that creates addresses, from every entry point; its button reads Create <address> |
| Test message | Routing test, ping (to a user) | The message an address sends to itself to prove mail reaches it; watched until it arrives or 3 minutes pass |
| Fix it | Repair, Retry rule | The one action beside a step or state that did not happen (a rule not made, a domain whose Email Routing is off) |
| Not receiving yet | Not arriving here (before 0.12), Broken | An address whose mail Cloudflare does not send here (routing missing); always shown with Fix it or the reason it cannot be fixed here |

## Entity and tier names — exact spelling
| Name | Wrong forms seen |
|---|---|
| Fabric Inbox | FabricInbox |
| Focus | focus (the view's name) |
| Important | important (the section's name) |
| Spam | spam (the folder's name) |
| Discarded | discarded (the folder's name) |
| Trash | trash (the folder's name) |
| Gmail | GMail |
| Google | google (provider name) |
| Google Cloud | google cloud, GCP (to a user) |
| Testing | testing (the publishing status of a Google Cloud app, by its own name) |
| OAuth | Oauth |
| Cloudflare | CloudFlare |
| Mac | mac (device name) |
| Outlook | outlook (provider name) |
| Microsoft | microsoft (company name) |
| Hotmail | hotmail (the service's name) |
| Live | live (the service's name, in Outlook.com, Hotmail and Live) |
| Microsoft 365 | Office 365, O365, M365 (to a user) |
| Microsoft Entra | Azure AD, Azure Active Directory, Entra ID (outside Microsoft's own menu name) |
| Outlook.com | outlook.com, Outlook (for the consumer service alone, where it must be told apart) |
| IMAP | Imap, imap (to a user) |
| SMTP | Smtp, smtp (to a user) |
| iCloud Mail | iCloud mail, ICloud |
| Fastmail | FastMail |
| Mail.ru | mail.ru (the provider's name) |
| GMX | Gmx |
| Drafts | drafts (navigation label) |
| MiB | Mib, MB (when the bound is 1,048,576-byte units) |
| Claude | claude (the assistant's name) |
| Code | code (in Claude Code, the product's name) |
| Cursor | cursor (the editor's name) |

## Banned
| Word or phrase | Why | Use instead |
|---|---|---|
| seamless | Unmeasured promise | Name the actual result |
| leverage | Filler | use |

## Glossary
| Term | Meaning |
|---|---|
| Account | Connected provider identity and its capabilities |
| Mailbox | Existing Cloudflare mailbox; not proof of a separate provider connection |
| All inboxes | Combined cached-mail view retaining account identity; one account can be selected in place |
| Queued | Awaiting a delivery attempt |
| Sent | Provider confirmed acceptance, not recipient reading |
| Accepted | Provider took the message; recipient delivery is unconfirmed |
| Forward text | Legacy Gmail and automation text-only forwarding |
| Forward | Unified composer reviews original files and explicitly loads them before sending |
| Search cached mail | Query cached mail in the current account/folder scope; not full provider history or offline desktop mail |
| Outcome unknown | An attempt may have succeeded; do not retry blindly |
| Waiting for device | A permitted local action awaits the connected Mac |
| Paused | Rule does not start new runs; existing run history remains |
| Off | No agent answers the address; mail is kept for the operator |
| Draft waiting | The agent wrote an answer the policy did not allow it to send; the reason is shown |
| Skipped | The agent did not answer (automated mail, answered thread, flagged text); the reason is shown |
| Focus | List order with Important first and other groups collapsed |
| Important | Raised by triage rules (a person's unread mail, security, alerts, store rejections, failed payments, CI failures, starred); each row names why |
| Routing verified / missing / unknown | Email Routing sends the address to the Worker / does not / could not be read; shown as Arriving here / Not receiving yet / Routing unknown; unknown is never shown as working |

## Workbench action terms

| Term | Meaning |
|---|---|
| Continue draft | Reopen the selected saved workbench draft, retaining its sender and send recovery |
| Retry same attempt | Reconcile or retry the locked send with its existing recovery key and unchanged content |
| Check for new mail | Read new mail and changes now for the Gmail, IMAP and Outlook accounts in view (⌘⇧N), then reload the combined list; it does not import a whole mailbox, and the status beside it names any account it could not read |
| Updated 3 min ago / Live | The status beside Check for new mail: the server's last successful read of the accounts in view; Live for Cloudflare addresses, which receive by push |
| Archive (from the keyboard) | Delete or Backspace: out of the inbox into Archive and marked read |
| Keyboard shortcuts | The help (?) listing every key the mail list answers to |
| Light theme / Dark theme | Appearance preference; no change to message, account or send state |

## Russian (locale ru)

One Russian word per product term, used in every screen, the Mac app and the server's pages
([locales/ru.md](locales/ru.md); the shared organization terms come from fabric-workspace
knowledge/localization.md and are identical across products: аккаунт, вход, правило, «Устанавливать
обновления автоматически», «Перезапустить для обновления», «Завершить», «Связка ключей», «Терминал»).
A new term joins this table before its first use in `shared/i18n/ru/`.

| English | Русский | Never write |
|---|---|---|
| Inbox / All inboxes | Входящие / Все входящие | Инбокс |
| Archive (folder / action) | Архив / Архивировать | |
| Discarded / Discard (⌘⌫) | Выброшенные / Выбросить | Отброшенные, Корзина (for this folder) |
| Not discarded (bring back) | Вернуть | |
| Discard rule(s) | правило выбрасывания / Правила выбрасывания | |
| Stop discarding mail like this | Больше не выбрасывать такую почту | |
| Always allow | Всегда пропускать | белый список |
| Spam / Report spam / Not spam | Спам / Это спам / Не спам | Нежелательная почта |
| Always spam / Never spam | Всегда спам / Никогда не спам | |
| Spam rules | Правила спама | |
| Trash / Sent / Drafts | Корзина / Отправленные / Черновики | |
| Focus / Important | Фокус / Важное | |
| Your addresses | Ваши адреса | |
| Settings | Настройки | Параметры |
| Addresses / Add address | Адреса / Добавить адрес | Создать алиас, ящик |
| Domains | Домены | |
| Accounts / account | Аккаунты / аккаунт | учётная запись (in running text) |
| Connect account / Disconnect | Подключить аккаунт / Отключить | |
| Forwarding destination | адрес пересылки | |
| Agents / Agent | Агенты / агент | бот |
| Agent access / Agent key | Доступ агентов / ключ агента | API-ключ, токен (for an agent key) |
| Outside agent | внешний агент | интеграция |
| Drafts only / Can send | Только черновики / Может отправлять | |
| Revoke | Отозвать | Удалить ключ |
| Reply policy | правила ответа | автоответ |
| Rule / Run / Dry-run | правило / запуск / Пробный запуск | рецепт |
| Knowledge / Knowledge collection / Passage | Знания / коллекция знаний / фрагмент | база знаний (for one set), чанк |
| Category / Project | категория / проект | фильтр, ярлык |
| App password | пароль приложения | пароль почты |
| IMAP account / Other mail (IMAP) | аккаунт IMAP / Другая почта (IMAP) | |
| Outlook account / App registration / Client secret | аккаунт Outlook / регистрация приложения / секрет клиента | |
| Administrator's approval | одобрение администратора | admin consent |
| Test message | тестовое письмо | пинг |
| Fix it | Исправить | Починить |
| Arriving here / Not receiving yet / Routing unknown | Приходит сюда / Пока не получает / Маршрут неизвестен | |
| Receive mail here / Bring them here | Получать почту здесь / Перенести сюда | |
| Catch-all | общий ящик | catch-all (to a user) |
| Check for new mail / Live | Проверить почту / В реальном времени | Синхронизировать |
| Keyboard shortcuts | Сочетания клавиш | Горячие клавиши |
| Your server / Server address | ваш сервер / Адрес сервера | бэкенд, инстанс |
| Cloudflare API token | API-токен Cloudflare | ключ Cloudflare |
| Setup (the setup file) | конфигурация | сетап |
| Queued / Sent / Accepted / Outcome unknown | В очереди / Отправлено / Принято / Результат неизвестен | Доставлено (for Accepted) |
| Usage counts | счётчики использования | телеметрия |
| Language: System / English / Русский | Язык: Системный / English / Русский | the language names are written in their own language |
