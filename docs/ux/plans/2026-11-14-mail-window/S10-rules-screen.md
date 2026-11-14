# S10. The rules screen made readable (B-275)

**Asked:** «нажимаю кнопку Rules for this account, не совсем понятно вот этот экран, что он, как настраивается,
поработать над интерфейсом, сделать нормальный рабочий интерфейс».

Revised after review round 1 (KIMI-12, UX-15, UX-21, IR-15, CB-19).

## Today (`app/routes/automation.tsx`, route `automation/:account`)

- Several names for one screen: "Rules for this account" (`unified-inbox.tsx:1670-1674`), "Rules & history"
  (`:1089`, the dialog `:1758-1786`), "Rules and history" (`automation.tsx:247`, `AccountsSection.tsx:267, 321`,
  `ImapAccount.tsx:244`, `gmail-inbox.tsx:292`), the Addresses tab (`AddressesSection.tsx:213, 311`), the tab title
  "Rules · Fabric Inbox".
- The account shown as its raw id (`gmail:…`, `automation.tsx:247-248`); "← Settings" always goes to Settings (`:243`).
- One long page: saved rules, an editor shown after "New rule", recent runs, an outbox (`:273-741`).
- Jargon and raw tokens: MCP, "Tool server URL", "Arguments (JSON)", "Credential name", "v3", "dry-run",
  "[run] waiting device", "[outbox] accepted", raw ids and error codes, "Cost unavailable" on every run.
- Enable is locked until a dry-run (`:36-43`), the reason shown only inside the editor.
- The Addresses tab promises rules that "label" mail (`AddressesSection.tsx:310`); the rule model has no label action
  (`workers/automation/policy.ts:8-50`). Cloudflare's Email Routing is also called a "rule" there (`:358`).
- The page uses its own Tailwind styles, not the workbench's.

## Target

**One name:** "Rules" («Правила»): the `h1` "Rules for <address>" on a Cloudflare address, "Rules for <account>" on a
Gmail, IMAP or Outlook account; the reader's link "Rules for this address" or "Rules for this account" by the same
rule; the sidebar entry and every settings button "Rules". Built in the workbench's styles with the sheleg-design
tokens.

**Brand term:** the UI says "Test run" for what the API calls a dry-run; `docs/brand/terminology.md` changes its English
column first (Dry-run → Test run); the Russian «Пробный запуск» stays.

### Layout

- **Header:** "Rules for <name>" with the provider; a back link to where the person came from ("Back to mail" or "Back
  to settings", from the navigation state; Settings when unknown).
- **Tabs:** Rules («Правила»); History («История») with a count of runs waiting for the person; Sending («Отправка», the
  outbox) only when it has items. A tab list (fix wave F3, A-29): only the chosen tab is in the Tab order, Left and
  Right move to the previous and next tab and wrap, Home and End go to the first and the last, and the one panel below is
  labelled by the chosen tab; the waiting count is visible, with its words ("1 waits for you") for a screen reader.
- **States:** loading, the rules failing to load (Retry), a save failing (the form kept, the reason in words), a narrow
  window (the editor's steps stack).

### Rules tab

- Each rule as a sentence card: "When mail arrives from **ann@acme.example** with **invoice** in the subject →
  **forward it to accounts@owner.example**. Asks you first. Up to 20 a day.", with an On/Off switch and Edit. A paused
  rule is dimmed with "Paused" («На паузе»). Turning on a rule whose current values were never test-run opens the editor
  at the Test run step.
- **Empty state:** "A rule acts on new mail that arrives here." («Правило действует на новые письма, которые приходят
  сюда.») and three starting points that open the editor filled in: "Archive newsletters from a sender", "Prepare a
  reply draft when a customer asks about something", "Forward invoices to another address".
- **The editor in four steps** on one screen:
  1. **When** («Когда»): from (an address), the subject contains, and "the message is about…" (the AI condition, with an
     example). At least one; the hint says so.
  2. **Do** («Сделать»): Archive, Mark as read, Prepare a reply draft, Forward to …; "Call a tool" under "More" with its
     fields (tool server, tool, arguments, credential) and a line on what it does.
  3. **How** («Как»): "Ask me before each action" (default) or "Act on its own"; "At most N actions a day".
  4. **Test run** («Пробный запуск»): pick one of the last 20 messages; the result in words ("Would forward it to …",
     "Would not act: the subject does not contain 'invoice'."), a whole sentence before "Nothing was changed." (A-28),
     acting on nothing.
  "Turn on" is enabled after a test run of the current values; while it is not, the reason sits next to it ("Test-run
  it on a message first, so you see what it will do"). "Save without turning on" is always allowed.

### History tab

- Each run as a line: the message (sender, subject, link), what the rule did or wants to do, its state in words
  ("Waiting for your approval", "Done", "Skipped: it did not match", "Failed: <reason in words>"), when; "Approve" and
  "Cancel" (the existing `runs/:id/dismiss` route).
- Rule version, raw ids and error codes fold under "Details" per run. A cost shows only when it is known; SCN-016's
  "unavailable cost is labeled unavailable" changes in the same change to "a cost is shown when known".
- Empty: "Nothing yet. When a turned-on rule matches new mail, it shows here."

### Words to fix elsewhere

- Settings → Addresses: "archive, label, forward or call a tool" becomes "archive, mark as read, prepare a reply draft,
  forward or call a tool"; Cloudflare's routing "rule" there is called "forwarding" («пересылка»).

All strings go through copywriting and the copy check in both locales; the Russian for every string is written in the
change with the copy-check report ids.

## Data and API

No change to the rule model or the routes. MCP tool texts keep the API's words.

## Acceptance

- Unit: the sentence builder for every condition and action, English and Russian.
- Unit: Turn on locked until a test run of the current values, locked again by a change (FLW-05's gate kept); the switch
  on an untried rule opens the Test run step.
- WebKit walk: empty state, a starting point, test run, turn on, a run waiting in History, Approve.
- SCN-014, SCN-015, SCN-016 updated; the 2026-10-07 plan's SCR-07 and SCR-08 lines marked superseded by this spec.
