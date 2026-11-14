# S10. The rules screen made readable (B-275)

**Asked:** «нажимаю кнопку Rules for this account, не совсем понятно вот этот экран, что он, как настраивается,
поработать над интерфейсом, сделать нормальный рабочий интерфейс».

## Today (`app/routes/automation.tsx`, route `automation/:account`)

- Four names for one screen: "Rules for this account" (`unified-inbox.tsx:1670-1674`), "Rules & history" (sidebar
  dialog, `:1758-1786`), "Rules and history" (its `h1`, `automation.tsx:247`), "Rules · Fabric Inbox" (tab title).
- The account shown as its raw id (`gmail:…`, `:247-248`); "← Settings" always goes to Settings, even when the person
  came from a message (`:243`).
- One long page: saved rules, an editor that appears after "New rule", recent runs, an outbox (`:273-741`).
- Jargon and raw tokens: MCP, "Tool server URL", "Arguments (JSON)", "Credential name", "v3", "dry-run",
  "[run] waiting device", "[outbox] accepted", raw ids and error codes, "Cost unavailable" on every run.
- Enable is locked until a dry-run, and the reason shows only inside the editor (`:36`).
- The Addresses tab promises rules that "label" mail (`AddressesSection.tsx:310`); there is no label action
  (`workers/automation/policy.ts:8-50`). Cloudflare's Email Routing is also called a "rule" there (`:358`).
- The page uses its own Tailwind styles, not the workbench's.

## Target

One name: **Rules** («Правила»), everywhere (the link in the reader becomes "Rules for this address" / «Правила
этого адреса», the sidebar entry "Rules", the `h1` "Rules for <address>"). Built in the workbench's styles
(`app/styles/workbench.css`), with the sheleg-design tokens.

### Layout

- **Header:** "Rules for <address or account name>" with the provider; a back link to where the person came from
  ("Back to mail" or "Back to settings"), read from the navigation state.
- **Three tabs:** Rules («Правила»), History («История») with a count of runs waiting for the person, Sending
  («Отправка», the outbox) shown only when it has items.

### Rules tab

- Each rule as a sentence card: "When mail arrives from **ann@acme.example** with **invoice** in the subject →
  **forward to accounts@owner.example**. Asks you first. Up to 20 a day." with a switch On/Off and Edit. A paused
  rule's card is dimmed with "Paused".
- **Empty state:** three starting points as buttons, each opening the editor filled in: "Archive newsletters from a
  sender", "Prepare a reply draft when a customer asks about …", "Forward invoices to another address"; one line on
  what a rule is: "A rule acts on new mail that arrives at this address."
- **The editor in four steps,** one screen, each step a section with its own short heading:
  1. **When** («Когда»): from (an address), the subject contains, and "and the message is about…" (the AI condition,
     with an example in its placeholder). At least one is required; the hint says which.
  2. **Do** («Сделать»): Archive, Mark as read, Prepare a reply draft, Forward to …, and "Call a tool" under
     "More" with its fields (tool server, tool, arguments, credential) and a line on what it does.
  3. **How** («Как»): "Ask me before each action" (default) or "Act on its own"; "At most N actions a day".
  4. **Try it** («Проверить»): pick one of the last 20 messages; "Try on this message" shows what the rule would do
     ("Would forward it to …" / "Would not act: the subject does not contain 'invoice'"), never acting.
  "Turn on" is enabled after a try with the current values; the reason is shown next to the button while it is not
  ("Try it on a message first, so you see what it will do"). "Save without turning on" is always allowed.

### History tab

- Each run as a line: the message (sender, subject, link), what the rule did or wants to do, its state in words
  ("Waiting for your approval", "Done", "Skipped: it did not match", "Failed: <reason in words>"), when; actions on
  the line: "Approve", "Cancel".
- Raw ids, rule version and error codes go under a "Details" fold per run. "Cost unavailable" is removed; a cost is
  shown only when known.
- Empty: "Nothing yet. When a turned-on rule matches new mail, it shows here."

### Words to fix elsewhere

- Settings → Addresses: "rules ... archive, label, forward or call a tool" becomes "archive, mark as read, prepare a
  reply draft, forward or call a tool"; Cloudflare's routing "rule" is called "forwarding" («пересылка»).

## Data and API

No change to the rule model (`workers/automation/policy.ts`) or the routes; the dry-run is the existing preview route,
named "Try" in the interface. The MCP tools are unchanged; their descriptions keep the API words.

## Acceptance

- Unit: the sentence builder for every condition and action combination, English and Russian.
- Unit: Turn on locked until a try of the current values; a change after the try locks it again (FLW-05's gate, kept).
- WebKit walk: empty state → a starting point → try → turn on → a run in History waiting for approval → Approve.
- SCN-014, SCN-015, SCN-016 updated; the UX plan of 2026-10-07's SCR-07 and SCR-08 lines superseded by this spec.
