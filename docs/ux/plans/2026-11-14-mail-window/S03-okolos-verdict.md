# S03. Every message checked, and the check shown: the Okolos badge (B-222 widened, B-269)

**Asked:** «аттачменты хочу, чтобы были верифицируемы ... агент, у которого нету доступа к тулам, он проводит
верификацию и смотрит, чтобы там не было вирусов, ... фишинга и так далее, если возможно для этого наш Oculus ... мы
помечаем письмо сверху, где-нибудь справа, ... бейджик, баннерчик, что типа письмо заражено, развернуть ... если все
окей, то там будет значок, Oculus extension, типа, все окей, можно развернуть и проверить, и как раз люди будут
знакомиться с Oculus Extension. А если не окей, ... можно будет подумать, какие нужны нам первые действия».

Revised after review round 1 ([review.md](review.md): SEC-1..12, KIMI-1..4, UX-1, UX-2, UX-4, UX-16, UX-17, IR-1..4,
IR-6, CB-2, CB-3, CB-9, CB-10, CB-18).

## Today (`main` `1f988fc8`)

An arrival safety check runs before any agent with tools reads a message (`workers/categories/store.ts:608-660`,
B-178, B-179, B-180):

- Okolos signals for instructions aimed at an AI in the visible text, the hidden text and the text of up to 3 attached
  documents (`workers/safety/check.ts:43-62`, `workers/safety/files.ts:34`); a light model's YES or NO.
- Links against the signed Okolos phishing feed and Okolos's lookalike check (`workers/safety/feed.ts:60-89`).
- Files that run code, by name or declared type (`workers/safety/files.ts:9-17`).
- A suspect message is held (`check.ts:65-67`) and reviewed by a model with no tools (`workers/safety/review.ts:34-59`,
  output `{verdict, reasons}`); `verdict === "safe"` releases it, never when a feed-listed link or a file that runs code
  was found (`store.ts:642-647`). A person can release or keep it (`POST /api/safety/decide`).
- Sender authentication is read only for the spam check, from the topmost `Authentication-Results` written by
  Cloudflare's own MX (`shared/mail/spam.ts:42-64` `authResults`, `verifiedDomain`), and only for Cloudflare mail.
- The person sees a `HeldPanel` on held mail (`app/components/inbox/HeldPanel.tsx`) and struck-out links while a
  message is held (`app/components/EmailIframe.tsx:47-52`, `workers/routes/inbox.ts:372-373`). Inbox rows carry a
  safety state only when held (`inbox.ts:364-374`); clean rows are pruned after 90 days (`store.ts:660`).

Gaps against the ask: no sender checks in the safety verdict; a file's type is judged by name and declared type, never
by its bytes; the 4th document and files over 10 MiB are skipped without a word (`files.ts:18,34,49`); nothing tells
the person that a message was checked, by what, or what did not run.

## Target

### 1. The checks (server, on arrival)

The result is Okolos's shape: what fired and what could not be looked at, never a score
(`okolos/packages/core-mail/src/verdict.ts`). It is stored as `findings.check` (a new key; the existing `review`
column and `findings` keys stay as they are, so the release rule, `HeldPanel`, inbox rows and `list_held_messages`
keep working).

| Check | How | Notes |
|---|---|---|
| `senderAuth` | DMARC, SPF and DKIM, counted only when the **topmost** `Authentication-Results` header is the account's own receiver's: Cloudflare's MX (the existing `authResults`, `shared/mail/spam.ts:45-47`, changed to look at the topmost header only), Gmail's `mx.google.com` when the topmost `Received` header is also Google's | Outlook, IMAP and any message whose topmost header is not the receiver's: "did not run: the provider's own result cannot be told apart from one the sender wrote". Outlook is not counted in this version (Exchange Online's header carries no reliable authserv-id); a row is filed to study it. A `DKIM-Signature` or `Received-SPF` header alone never counts. Okolos's `checkSenderAuth` is not used (it reads the first header of that name, `core-mail/src/sender.ts:65-67`) |
| `senderIdentity` | Okolos `checkSenderIdentity` with the vendored `checkLookalike`, the default watchlist and the server's own `DOMAINS`; every From address, not only the first | A display name naming a brand on another domain fires |
| `replyPath` | Okolos `checkReplyPath` | Reply-To on another registrable domain fires minor |
| `links` | existing feed and lookalike checks, plus a link whose visible text names another domain than it goes to; entity-encoded and protocol-relative hrefs decoded first; a cap that was hit goes to not-run | S04 uses the per-link results |
| `hidden` | existing `inspectMessage` | unchanged |
| `attachments` | one entry per attachment, always (see 2) | |

The arrival queue carries what these need. Today only Cloudflare mail brings its headers (`workers/index.ts:384,699`,
`store.ts:369`); the remote arrival path carries none (`workers/providers/accounts-do.ts:100-101`). The changes:
`IncomingEvent` and the queue item gain `headers: {key, value}[]` (the `Authentication-Results`, `Received`, `From`,
`Reply-To`, `List-Id` and `Delivered-To` lines, in order, capped); Gmail's metadata request adds those names to its
header list (`workers/providers/gmail-client.ts:80-81`); Graph `$select`s `internetMessageHeaders`; IMAP fetches
`BODY.PEEK[HEADER.FIELDS (...)]`. The Okolos sender checks take a `MailMessage` built by a small adapter from these
headers and the stored addresses (not `parseMessage`, since remote mail has no raw source here).

### 2. Files

- **Every attachment gets one entry**, with its outcome: checked, or not checked and why (too large, an archive whose
  contents are not opened, the per-message cap of 10 files reached). A test holds the invariant.
- **Type by content:** the first 4 KiB, read by range from R2 (Cloudflare) or from the provider (Gmail, IMAP, Outlook;
  the whole file is never loaded only for this), matched against a table of signatures (PE, Mach-O, ELF, shell
  scripts, OLE and OOXML with macros, PDF, ZIP, RAR, 7z, ISO, DMG, image formats). An empty or too short read is "did
  not run (too short)", never "matches". A PDF that also carries a program signature in its first 1 KiB is flagged as
  a mixed file.
- **Office documents:** macros cannot be seen in the first bytes (OOXML is a ZIP). The ZIP's central directory (the last
  64 KiB, read by range) is listed for `vbaProject.bin`, `xl/macrosheets/` and `word/vbaData.xml`; no entry is
  decompressed. A central directory that cannot be read gives "macros not checked" and a grey file chip; the absence of
  macros is never inferred from the first bytes.
- **Risky kinds:** the union of today's list (`files.ts:9`, with iso, img, vhd, app, xlam) and Okolos's
  `core-download` list; `html`, `htm`, `svg`, `one` are amber in mail (attached web pages are a common phishing
  method); an archive is "contents not checked".
- **The judgement:** Okolos `judgeDownload` with `url` set to `mail-attachment:<filename>` (an attachment has no
  address; the value only names it in the verdict), `file-type` from the signature reader, and `feed` and `hash` passed
  as `ran: false` (no hash list on this server yet).
- **A matching type is never called safe:** the panel says what the file is, not that it is fine.
- The signature reader is written here (`workers/safety/sniff.ts`) and offered to Okolos on its board for
  `core-download`; once Okolos has it, it is vendored instead.

### 3. The model with no tools

- **Held mail keeps today's review.** A held message is reviewed exactly as today (`reviewHeld`, output
  `{verdict, reasons}`, its release rule and its guard against feed-listed links and files that run code,
  `store.ts:642-647`). Nothing here changes that path.
- **A new, separate review** (its own prompt and schema, version 1, stored under `findings.check.review` with that
  version) runs for a message that is not held, when any deterministic check fired (any severity, minor included) or a
  document attachment's text was read, inside its own daily budget (separate from the arrival scan's), at most 20 a day
  per sender domain; turning a document into text counts against the same budget. It never releases, holds or
  otherwise changes a message's safety state.
- **Input:** one fenced block of untrusted data (the `untrusted-fence` pattern: a random fence per call, a preamble that
  the block is data, forged fence lines neutralised), holding every attacker-derived string as structured, length-capped
  fields: the display name, the headers, the subject, the body, link texts and hosts, file names, and the deterministic
  signals and per-file judgements (which carry those strings).
- **Output, validated strictly:** a closed set of reason codes (`looks_like_phishing`, `asks_for_credentials`,
  `urgent_payment`, `impersonates_brand`, `instructions_to_ai`, `likely_benign_sender_mismatch`, `unsure`), a combination
  table that rejects contradictions (`likely_benign_sender_mismatch` with any other code but `unsure`), and at most two
  quotes, each kept only when it matches a span of the normalised message text exactly. Output that fails validation is
  dropped whole: "review did not run: the answer could not be used". No free sentence of the model is ever shown.
- **What it may change, through one pure function `colourOf` (section 4):** a raising code (`looks_like_phishing`,
  `asks_for_credentials`, `urgent_payment`, `impersonates_brand`, `instructions_to_ai`) makes a green or grey message
  amber; `likely_benign_sender_mismatch` alone, over minor sender signals only, makes it grey "Reviewed: probably fine"
  (never green); nothing it says changes a floor (a feed-listed link, a file that runs code or is disguised, a DMARC fail
  with an enforcing policy, a lookalike From or link, instructions to an AI found by the checks).
- **Green means the deterministic checks:** a message is green when every check ran and nothing fired; the review is
  not needed for green (it runs only where something fired), and the badge's panel says which checks made it green.
- No budget left or the call failing: "review did not run: <why>" in the not-run list; the colour stays as the checks
  made it. A spent review budget never holds mail (the arrival scan's own fail-closed rule is unchanged).

### 4. Colour, one table for S03, S04 and S09

| Colour | Badge (English / Russian) | When |
|---|---|---|
| Green | "Checked by Okolos" / «Проверено Okolos» | All six checks ran for this message and nothing fired |
| Grey | "Partly checked" / «Проверено частично» | Nothing fired, a check did not run for this message (no trusted auth result, a file too large, review not run) |
| Grey | "Not checked" / «Не проверено» | No record: arrived before this version, the check is off, the record expired; or held only because the scan could not run (`modelError`) |
| Amber | "Sender may be forged" / «Отправитель может быть поддельным» | Only sender signals fired (DMARC fail is red's floor only when the domain publishes `p=reject` or `p=quarantine`; otherwise amber) |
| Amber | "Suspicious message" / «Подозрительное письмо» | Any other minor or major signal; the review raised it; an amber file |
| Amber | "Suspicious message" / «Подозрительное письмо» | Held only because the light model said YES (`findings.model` alone is a model's guess, not a floor) |
| Red | "Dangerous" / «Опасно» | A feed-listed link, a file that runs code or is disguised, instructions to an AI found by Okolos's signals (visible strong, hidden or in a file), DMARC fail with an enforcing policy; held for any of these and not released |
| (same) | plus "Released by you" / «Вы разрешили» | A person released a held message: the colour still follows its signals |

Which mail is checked: received mail in every folder. Mail we sent and drafts are not checked (they carry no receiver's
result and their links are ours); they show no badge and their links open as written.

A file's own chip uses the same colours: red for a program or a disguised file, amber for a web page, an archive, a
macro document or a mixed file, grey for a file not checked, green for a checked one with no signal.

`colourOf(findings, state, feedVersion)` is the one pure function behind the badge, S04 and S09, tested over every
row of this table and every review code. A lowered minor sender signal is grey "Reviewed: probably fine" («Проверено:
похоже, всё в порядке»).

A message with no record is checked when it is opened: the deterministic checks only, no model, once (`POST
/api/safety/check`); until the answer, it is grey and its links ask (S04). A record checked against an older feed than
the server's current one is grey before its body renders (its links stripped by S04), and its link checks are
recomputed on open without the model; the colour comes back only from a successful recomputation, and the body is
rendered again from the new record. A recomputation that fails stays grey.

### 5. What a person sees

- **The badge** at the right of the subject line (S02): the Okolos mark (the shield from Okolos's icon set) and the
  words of the table above; a button with `aria-expanded`, colour never the only signal (an icon and a word each).
- **The panel** opens under the header (not a modal):
  - **What was checked:** one line per check in plain words ("The sender's own server confirmed it sent this (DMARC)",
    "Links: 4 checked, none on the phishing list"), with the facts a person can check (domains shown in punycode with
    the registrable part emphasised, bidi and zero-width characters removed).
  - **Files:** one line per attachment: what its bytes show, whether that matches its name, its chip.
  - **What did not run here, and why.**
  - **The review**, when it ran: its reason codes in words and the quotes as quotes.
  - **First steps**, at most three, for amber and red: "Don't open its links" (S04 already blocks them), "Report spam"
    («Это спам»), "Discard"; for a held message, the existing Release and Keep held.
  - **About Okolos**, one line: "Okolos is PassionCode's browser security. In your mail it checks senders, links and
    files on your own server." («Okolos: защита браузера от PassionCode. В почте он проверяет отправителей, ссылки и
    файлы на вашем сервере.») A link to its page appears behind a flag once the page is public (Q4).
  - A fixed scope note: "No antivirus engine runs on this server; files are checked by what they are, not against
    virus signatures." It does not change the badge (Q12).
  - When it was checked.
- **Downloads:** an amber file asks once ("This file is a web page. Download anyway?"); a red one offers no download
  from the reader, only "Save anyway" inside the panel's file line. The server enforces it too: for amber and red files
  the attachment route answers `application/octet-stream` with `X-Content-Type-Options: nosniff` and a sandbox CSP; a
  red file needs `override=1`, logged (`{event: "attachment_override", colour}`).
- Okolos never draws inside the message text: the panel says so, so a badge drawn by a message's own HTML is not
  trusted.

## Data, routes and tools

- Inbox and thread rows carry `safety: {colour, checkedAt}` for every message with a record (today only held ones);
  the panel reads the full record on open through the existing `POST /api/safety/lookup`.
- `POST /api/safety/check {accountId, messageId, model?: false}`: runs the deterministic checks now (and the review
  only when asked and inside the budget); returns the record. Listed in the safety scope routes
  (`workers/mcp/scope.ts:74, 180-186`); MCP tool `check_message_safety` (level mail). `list_held_messages` returns
  `check` beside its current fields.
- Clean records are kept 90 days as today; after that a message reads "Not checked" and is checked again on open.
- No SQL schema step: `findings` is JSON.

## Vendoring

`core-mail` and `core-download` join the vendored set from `passioncode-ai/okolos` (the checkout here is
`okolos-extension`), and all vendored packages move to one pin, `aa5dc1ddce78d32f60f7bfd802096e7949ccb0e6` (Okolos `main`, 2026-11-12), reviewed in this change; a later pin is its own reviewed pull request. The rule in
`vendor/okolos/README.md` grows by one rewrite: a bare `@okolos/<pkg>` import becomes the relative vendored path. The
hashes go into `manifest.json`; `tests/okolos-vendor.test.ts` checks them.

## Acceptance

- Unit with fixtures under `tests/fixtures/mail/`: a forged `dmarc=pass` line with no receiver line and one below the
  receiver's line (both: did not run or fail, never pass); DMARC fail with `p=reject` (red) and `p=none` (amber); a
  lookalike From; a second From address; Reply-To on another domain; a link whose text names another domain; an
  entity-encoded href; a `.pdf` that is a PE by its bytes (red); a PDF with a program signature in its first KiB
  (mixed); an `.html` attachment (amber); a ZIP (contents not checked); 12 files (10 checked, 2 not, said so); an empty
  file (did not run).
- Unit: the review cannot raise above amber, cannot lower a floor, cannot make green; an injected "severity none" in
  the body leaves a red verdict red; malformed output, a contradicting code pair and a quote not found in the message
  are dropped; a held message's review path is unchanged.
- Unit: a `.docm` and an `.xlsm` (macros listed), a `.docx` without macros, a ZIP whose central directory is cut (macros
  not checked).
- Unit: the colour table as a pure function over findings and state, every row.
- Worker (workerd): arrival writes `findings.check` for Cloudflare and for each remote kind's fixture; a spent review
  budget leaves "review did not run" and does not hold; `check_message_safety` and the route's scope.
- Desktop: a downloaded file carries `com.apple.quarantine`.
- WebKit walk: the badges, the panel, a red file's download.
- SCN-088 refined (the arrival check) and SCN-010 refined (files); no duplicate row.

## Out of scope

An antivirus engine (Q12); sending a file or its hash outside the owner's server.
