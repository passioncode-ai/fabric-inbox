# Russian copy pass handoff — 2026-10-12

## Objective and source

The operator (2026-10-12): the Russian interface "looks very bad" and the whole of it needs a
review. This pass rewrote the Russian side of the dictionary (`shared/i18n/ru/`) against the brand
pack ([voice](../brand/voice.md), [Russian locale](../brand/locales/ru.md),
[terminology → Russian](../brand/terminology.md#russian-locale-ru)), Settings and setup first.
English source strings (the keys), placeholders, commands, product names and numbers are unchanged;
only Russian values moved. Base: `bb05322` on `main`. Branch: `agent/ru-copy-pass`.

## Completed

624 of 3071 Russian entries rewritten (character edit distance across the rewritten entries: 27%).

| Catalog | Area | Entries changed |
|---|---|---|
| `settings.ts` | Settings → Addresses, Add address, Forwarding destinations, signature, domain steps | 87 of 236 |
| `common.ts` | the frame, Settings shell and section descriptions, Settings → App, Setup | 51 of 229 |
| `rules.ts` | Settings → Domains, Categories, Spam rules, Discard rules | 66 of 247 |
| `connect.ts` | Settings → Accounts, Gmail / Outlook / IMAP setup, provider presets, result pages | 139 of 477 |
| `desktop.ts` | the Mac app: menus, dialogs, connect links, first-run window, agent console, updates | 56 of 330 |
| `agents.ts` | Settings → Agents, Knowledge, Agent access; chat agent and AI panel | 31 of 313 |
| `inbox.ts` | mail list, reader, triage, Undo toast, keyboard help, refresh status | 35 of 292 |
| `compose.ts` | composer, drafts, attachments, send states | 23 of 127 |
| `server.ts` | the server's sentences: routing, tokens, relay, agent runs, rule history | 121 of 599 |
| `legacy.ts` | older mail views and the rule editor | 15 of 221 |

`desktop/locales/ru.json` was regenerated with `node scripts/check-locale.mjs --write`.

What was wrong, by kind:

- **One action, two names.** Discard changes, Undo changes and Cancel were all «Отменить
  изменения»/«Отменить»; Keep editing and Continue were both «Продолжить». Now «Не сохранять»,
  «Вернуть как было», «Вернуться к правке». The legacy Sync now is «Проверить почту», as
  terminology requires for Check for new mail. Star is «Отметить звёздочкой» everywhere.
- **Calques.** «Токен не видит домен» → «у токена нет доступа к домену»; «попытка повторится сама» →
  «повторим автоматически»; «больше не принимает доступ» → «отозвал доступ»; «запечатывается» →
  «шифруется»; «Новая почта остаётся для вас» → «новую почту читаете вы»; «изменились несколько раз
  одновременно» → «одновременно меняли из нескольких мест»; «не пустил» → «отклонил вход».
- **Developer register on a person's screen.** «ключ учётных данных» → «ключ шифрования»;
  «ключ восстановления не даст отправить дважды» → «дважды письмо не уйдёт»; «оставлено оператору» →
  «письмо ждёт вас»; «Непредвиденная проблема/ошибка» → «Ошибка».
- **Terminology drift.** Catch-all was «общее правило» in the server's sentences; terminology says
  «общий ящик» (the Cloudflare rule: «правило общего ящика»). Key levels were «Admin», «Read»,
  «Mail» in one refusal and «Администратор», «Чтение», «Почта» elsewhere. OS user accounts were
  «учётная запись», which terminology bans in running text: now «пользователь».
- **Invariant risk.** Reprocessed mail «снова отправлено правилам» → «снова передано»: «отправлено»
  is reserved for mail the provider accepted.
- **Inverted or hidden next steps.** «Исправит: «Исправить».» → «Нажмите «Исправить», чтобы
  исправить.»; search empty states «Ни один … не подходит под «…»» → «Нет … по запросу «…»».
- **Typography.** «ёлочки» instead of straight quotes around intents and agent ids; buttons as
  infinitives («Ответить всем»).

## Missing terms (reported, not added — `terminology.md` belongs to brand-voice)

| English | Used here | Why it needs a row |
|---|---|---|
| Sort (a message into a category) | разбирать / разбор | the product term has no Russian row |
| Scope (where a category looks) | область поиска | used in a dozen Category strings |
| Credential key (`MAIL_CREDENTIAL_KEY`) | ключ шифрования | no English term row either |
| Reconnect | переподключить | used by Gmail, Outlook, IMAP and the reader |
| Relay | ретранслятор | Accounts and the server's relay sentences |
| Intent / Allowed intents | намерение / Разрешённые намерения | reply policy |
| Coding agent | агент для кода | Agent access, the agent console |
| Key levels Read / Mail / Admin | Чтение / Почта / Администратор | named in `agents.ts` only, not in the pack |
| Workspace (everything an Admin key reaches) | рабочее пространство | the Project row bans "Workspace" for a set of domains |
| Setup (a first-run or provider setup, not the file) | настройка | terminology maps Setup only to «конфигурация» (the file) |

## Not done, and why

- `voice.md` B005 (calibration older than its sources) and the adoption warnings (B022) are
  brand-voice's and the registry's, untouched by a copy pass.
- The installed super-ux linter (0.59.2) reports 4 B021 errors: English registry rows for
  `desktop/setup.html` whose text it cannot find in the source. They concern English rows this pass
  did not touch; the repository's own `docs/brand/lint.py` (the gate) exits 0.
- Russian has not been read by a native reviewer (`locales/ru.md`: `Reviewed by: unreviewed`).
- No screen walk at 800 / 1360 px was made for the new lengths; the rewritten strings are mostly
  the same length or shorter, the longest additions are in help paragraphs.

## Verification (local, this branch)

See the pull request for the exact commands and exit codes of this run.

## Exact next task

A native Russian reader walks Settings → Accounts → Connect account (Gmail, Outlook, Other mail) and
the Mac app's first-run window in the built app at 800 px, and brand-voice adds the missing terms
above to `terminology.md → Russian`; then replace the interim words here if the chosen ones differ.
