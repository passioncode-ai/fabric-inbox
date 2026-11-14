# S11. Settings name their server and see the others (B-276)

**Asked:** «переходим в адресы, домены, аккаунты, почему-то у меня в аккаунтах только один ... аккаунт, а ну потому что
сверху включен, я понял, то есть у меня в аккаунтах сверху выбран какой-то один аккаунт, но в e-mail я могу поставить
все, то есть» (the notes stop here; Q11).

## Today

- Settings read only the server the window shows (`app/components/settings/sections/data.ts:19-37`); nothing in
  settings uses the held-servers bridge (only `ServerTabs.tsx`, `app/lib/other-servers.ts`, `unified-inbox.tsx` do).
- No settings screen names its server: the copy says "your server" or "this server" (`AccountsSection.tsx:48,155,189,
  207-210`, `DomainsSection.tsx:142`, `paths.ts:51`, `AppSection.tsx:18,109`); the navigation has no server name
  (`settings.tsx:92-107`).
- So with All chosen in the mail, Settings → Accounts shows one server's accounts with no hint that others exist.

## Target

- **The header names the server:** "Settings · <server name>" («Настройки · <name>»), with the same server switch as
  the mail (S01) when the app holds two or more servers. Choosing another server shows that server's settings in the
  same window (the window switches server, as the mail's switch does). "All" is offered in the switch only on
  Accounts, Addresses and Domains (Q10).
- **All on the three lists:** each list reads every held server and groups the items under the server's name, each
  group with its count and state (signed out: "Sign in"; not reachable: "Retry"). An item of another server opens that
  server's settings at that item. Adding (an account, an address, a domain) asks which server, defaulting to the shown
  one.
- **Every other section** (Agents, Knowledge, Keys, App) shows the shown server only, with its name in the header, and
  the switch without All.
- **Words:** "your server" becomes the server's name where one is known ("<name>'s accounts" / «Аккаунты сервера
  <name>»); with one server held the copy stays as it is.

## Data and API

- The desktop bridge gets one read, like the inbox's (`desktop/all-servers.cjs` `readAll`): `fabric:other-settings`
  with a list kind (`accounts`, `addresses`, `domains`) reading `/api/accounts`, `/api/project-addresses` and
  `/api/domains` from each other held server through its own signed-in session, on opening the list and on Retry (no
  timer). It returns each server's state as `readAll` does. AGENTS.md's lifecycle table gains its row.
- No server route changes; no MCP change (an agent works on one server at a time through its own key).

## Words

| English | Russian |
|---|---|
| Settings · {name} | Настройки · {name} |
| All servers | Все серверы |
| Which server? | На каком сервере? |

## Acceptance

- Unit: the grouping and states; an item of another server opens that server; adding asks which server.
- Desktop unit: `fabric:other-settings` reads each other server once per open, maps 401/403 to signed out.
- WebKit walk with the preview fixture holding three servers.
- SCN-099 gains "Settings name their server and list every server's accounts".
