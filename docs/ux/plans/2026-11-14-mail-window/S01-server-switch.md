# S01. The server switch above the mail list (B-267)

**Asked:** «Вот там, где сверху фильтры ... переключение между серверами надо типа поправить дизайн, чтобы оно было
лучше сделано, сейчас выглядит плохо».

Revised after review round 1 (KIMI-11, UX-14, IR-13, IR-16, CB-16, CB-17).

## Today (`main` `1f988fc8`)

- `ServerTabs` (`app/components/inbox/ServerTabs.tsx:9-53`) renders pill chips between the list heading and the filter
  bar (`app/routes/unified-inbox.tsx:1311-1313`), only in the inbox folder, without a search, when the app holds two or
  more servers (`:311`).
- "All" has no count; another server's chip switches the window (`ServerTabs.tsx:49-52`) and is never shown as pressed;
  a signed-out server is a dashed chip "name · Sign In", an unreachable one a `span` "name · Not reachable now" with a
  text "Retry" (`:34-47`). Each uses `title` for the full name (`tests/server-tabs-layout.test.ts:19-20`).
- The chips are `.fi-chip` pills (`app/styles/workbench.css:1515-1540`), the row wraps (`:1804-1815`). Two "All" chips
  sit one above the other with different meanings (servers, then groups).
- Another server's unread count is counted in its last 50 inbox rows (`desktop/all-servers.cjs:52-54`), and the reader
  drops any field it does not know (`app/lib/other-servers.ts:74-75`).

## Target

One control that reads as a switch of where the list comes from, not as a filter chip.

- **Placement:** the right side of the list heading (`.fi-list-heading`). The "Important first" / "Newest first" hint
  moves under the Focus/Newest control it explains; the heading keeps "N selected" when messages are selected (it
  replaces the switch while a selection exists, as the hint does today, `unified-inbox.tsx:1308`).
- **Two to four servers and a list column at least 360 px wide:** a segmented control built on `.fi-segmented`
  (`workbench.css:1508`): All, then each server by its name, each with its unread count; radius `--pc-radius-control`;
  28 px tall in every state. A long name is cut at 160 px; the full name shows in Kumo's `Tooltip` (as `Header.tsx`
  uses it).
- **Five or more servers, or a narrower column:** one button "All servers ▾" or "<name> ▾" opening a menu with the same
  rows: name, count, state.
- **Semantics:** a navigation (`nav` with `aria-label="Servers"`), each choice a link-like button with
  `aria-current="page"` on the chosen one; arrow keys move between choices, Enter chooses.
- **States, as text with an icon, never colour alone:**
  - signed out: the choice's own label reads "<name> · Sign in", and choosing it signs in (one control, no button
    inside a button);
  - not reachable: "<name> · Retry" with a warning icon, choosing it retries; the reason in the tooltip.
- **Which is chosen:** All when the merged list is shown, else the server whose mail the list shows; choosing another
  server switches the window as today.
- **Counts:** `readAll` returns `full: true` when a server's read came back with 50 rows; its count then shows as
  "<n>+" («<n>+»); All's total shows "+" when any part is a lower bound.
- The group chips' "All" becomes "All groups" («Все группы»).
- Shown, as today, only in the inbox folder without a search (the merged list exists only there).

## Words

| English | Russian |
|---|---|
| Servers | Серверы |
| All servers | Все серверы |
| All groups | Все группы |
| {name} · Sign in | {name} · Войти |
| {name} · Retry | {name} · Повторить |
| Not reachable now | Сейчас недоступен |

## Acceptance

- Unit (`tests/server-tabs-layout.test.ts` rewritten): segments below five servers and at 360 px or more, the menu
  otherwise; one height in every state; "50+" from `full`; All's "+"; `aria-current`; arrow keys.
- Desktop unit: `readAll` returns `full`.
- WebKit walk with the preview fixture at 1500, 1100 and 700 px, with 2, 3 and 6 servers, one signed out, one
  unreachable; screenshots with the PR.
- SCN-099 step 1 and its alt paths updated.

## Out of scope

What All merges and where it reads from (SCN-099, `desktop/all-servers.cjs`).
