Contract: brand-contract v1
Locale: ru
Primary: no
Address form: вы (lower case)
Length coefficient: 1.3
Humor: none on errors or actions
Never translated: Fabric Inbox, Gmail, Google, Google Cloud, Cloudflare, Email Routing, Outlook, Microsoft, Microsoft Entra, Microsoft 365, IMAP, SMTP, OAuth, iCloud Mail, Fastmail, Zero Trust, Workers AI, MCP, Claude Code, Cursor
Keywords: none; private interface, no acquisition research
Reviewed by: unreviewed

# Locale delta

Russian for every interface of the product (operator, 2026-10-06; fabric-workspace
knowledge/localization.md L10N-01…06). The dictionary is `shared/i18n/ru/` (English source → Russian);
`node scripts/check-locale.mjs` keeps it complete and the Mac app's copy current.

- **Register.** Plain operational Russian, the same calm precision as the English. «вы» in lower case,
  never «Вы», never «ты».
- **Actions.** Buttons, menu items and link-actions are infinitives, perfective where natural:
  «Сохранить», «Отменить», «Добавить адрес», «Подключить», «Проверить почту», «Выбросить». Instructions
  in running text are the polite imperative: «Выберите домен», «Откройте „Настройки → Домены“».
  Work in progress is the first person plural present: «Сохраняем…», «Проверяем…». States are short
  participles or adjectives: «Подключено», «Не создан», «Пока не получает». Menus follow Apple's Russian
  macOS («Завершить», «Скрыть остальные», «Правка», «Окно»).
- **Case.** Sentence case everywhere; no Title Case in buttons, headings or menus.
- **Typography.** «ёлочки», „лапки“ inside them; the dash «—» with spaces; «…» as one character; ё where
  it is standard (ещё, её, всё, сохранён, удалён); a no-break space between a number and its unit
  («5 МиБ») and in grouped thousands («1 234»).
- **Counts.** Three forms, chosen by `Intl.PluralRules`: «1 письмо, 2 письма, 5 писем»; a count is never
  written as «письмо(а)».
- **Dates and numbers.** `ru-RU` through `Intl`: «15 апр.», «ср, 15 апр., 15:42», «1 234,5».
- **Names.** Product, provider and console names stay as their owners write them; the buttons a person
  must click in Google Cloud, Microsoft Entra or the Cloudflare dashboard (English interfaces) stay in
  English inside the Russian sentence: «выберите Publish app». macOS names follow Apple's Russian
  interface: «Терминал», «Связка ключей», «Программы», «Системные настройки».
- **Keys.** Keyboard labels are not translated: ⌘, ⇧, ⌫, Esc, Enter, Tab.
- **Length.** Russian runs about 30% longer; row titles, badges and buttons take the shorter natural
  phrasing, and the layouts were checked at 800 px and 1360 px.
- **Not translated.** Mail the person writes, agents' answers, prompts, what agents read through MCP,
  logs and error codes.

| Term | Перевод | Note |
|---|---|---|
| Inbox | Входящие | the folder |
| Discarded | Выброшенные | the folder; the action is «Выбросить» |
| Report spam | Это спам | |
| Settings | Настройки | |
| Agent access | Доступ агентов | |
| App password | пароль приложения | Apple's own menus: «пароль для приложений» |
