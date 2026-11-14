# S11. Settings name their server and see the others (B-276)

**Asked:** «переходим в адресы, домены, аккаунты, почему-то у меня в аккаунтах только один ... аккаунт, а ну потому что
сверху включен, я понял, то есть у меня в аккаунтах сверху выбран какой-то один аккаунт, но в e-mail я могу поставить
все, то есть» (the notes stop here; Q11).

Revised after review round 1 (KIMI-11, UX-13, UX-14, IR-13, CB-20).

## Today

- Settings read only the server the window shows (`app/components/settings/sections/data.ts:19-37`); the held-servers
  bridge is used by `ServerTabs.tsx`, `TriagedList.tsx`, `app/lib/other-servers.ts` and `unified-inbox.tsx` only.
- No settings screen names its server ("your server", "this server": `AccountsSection.tsx:48,155,189,207-210`,
  `DomainsSection.tsx:142`, `paths.ts:51`, `AppSection.tsx:18,109`); the navigation has no server name
  (`settings.tsx:92-107`).
- With All chosen in the mail, Settings → Accounts shows one server's accounts with no hint that others exist.

## Target

- **The header names the server:** "Settings · <server name>" («Настройки · <name>») when the app holds two or more
  servers, with the same switch as S01 (segments up to four servers, the menu for more; Settings has no list column, so
  the count of servers alone decides).
- **What S01 brings to Settings:** the segments or the menu, the names, the signed-out and unreachable states (sign in and
  retry by choosing the segment); not the unread counts (Settings has no mail). The disabled All is a state of its own
  here: shown, not focusable by arrows, its reason in its tooltip.
- **All stays visible on every section.** On Accounts, Addresses and Domains it shows every server's items grouped by
  server name; on the other sections (Agents, Knowledge, Keys, App, Name & signature) All is disabled with the reason
  in its tooltip: "This section belongs to one server" («Этот раздел относится к одному серверу»).
- **Settings open on the mail's choice:** with All chosen in the mail, Accounts, Addresses and Domains open on All; the
  other sections open on the server the window shows.
- **On All:** each group shows its count and state (signed out: "Sign in"; not reachable: "Retry"). An item of another
  server opens that server's settings at that item: the window switches to that server with the path
  `/settings/<section>/<id>` passed to `fabric:show-server` (`desktop/main.cjs:292-299, 495`), and the switch says so
  before it happens when an agent console session runs, since switching stops it (`main.cjs:296`): "The agent console
  session will stop" («Сессия консоли агента остановится»). Choosing another server's segment does the same switch and gives the same warning first. Adding an account, address
  or domain asks "Which server?"
  («На каком сервере?»), defaulting to the one shown.
- **Words:** where a sentence says "your server" and the app holds several, it names the server.

## Data and IPC

- A new bridge read `fabric:other-settings` with a kind (`accounts`, `addresses`, `domains`) reading `/api/accounts`,
  `/api/project-addresses` and `/api/domains` from each other held server through its own session, on opening the list
  and on Retry (no timer); 401 and 403 map to signed out, as `readAll` does. Files: `desktop/mail-preload.cjs`,
  `desktop/main.cjs`, `app/lib/other-servers.ts` (an optional method, detected on its own, so an older desktop build
  keeps the mail switch and Settings simply shows one server). AGENTS.md's lifecycle table gains the row.
- No server route and no MCP change.

## Words

| English | Russian |
|---|---|
| Settings · {name} | Настройки · {name} |
| This section belongs to one server | Этот раздел относится к одному серверу |
| Which server? | На каком сервере? |
| The agent console session will stop | Сессия консоли агента остановится |

## Acceptance

- Unit: grouping and states; opening on the mail's choice; All disabled with its reason; adding asks which server.
- Desktop unit: `fabric:other-settings` reads each other server once per open, maps 401 and 403; an older bridge
  without it keeps the mail switch.
- WebKit walk with the preview fixture holding three servers.
- SCN-099 gains "Settings name their server and list every server's accounts".
