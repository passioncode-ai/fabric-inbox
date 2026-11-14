# S03. Every message checked, and the check shown: the Okolos badge (B-222 widened, B-269)

**Asked:** «аттачменты хочу, чтобы были верифицируемы ... агент, у которого нету доступа к тулам, он проводит
верификацию и смотрит, чтобы там не было вирусов, ... фишинга и так далее, если возможно для этого наш Oculus ... мы
помечаем письмо сверху, где-нибудь справа, ... бейджик, баннерчик, что типа письмо заражено, развернуть ... если все
окей, то там будет значок, Oculus extension, типа, все окей, можно развернуть и проверить, и как раз люди будут
знакомиться с Oculus Extension. А если не окей, ... можно будет подумать, какие нужны нам первые действия».

## Today

An arrival safety check exists and runs before any agent with tools reads a message
(`workers/categories/store.ts:608-660`, B-178, B-179, B-180):

- Okolos signals for instructions aimed at an AI in the visible text, the hidden text and the text of up to 3 attached
  documents (`workers/safety/check.ts:43-62`, `workers/safety/files.ts`); a light model's YES or NO.
- Links against the signed Okolos phishing feed and Okolos's lookalike check (`workers/safety/feed.ts:60-89`).
- Files that run code, by name or type (`workers/safety/files.ts:9-17`).
- A suspect message is held and reviewed by a model with no tools (`workers/safety/review.ts:34-59`); a person can
  release or keep it (`workers/safety/state.ts:8`, `POST /api/safety/decide`).
- What a person sees: a `HeldPanel` on held mail only (`app/components/inbox/HeldPanel.tsx`), struck-out feed-listed
  links (`app/components/EmailIframe.tsx:47-52`). A clean message says nothing; a check that did not run says nothing.

Gaps against the ask: no sender checks (SPF, DKIM, DMARC, lookalike From, Reply-To on another domain); attachment type
is judged by name and declared type only, never by content; nothing shows that a message was checked, by what, and what
did not run.

## Target

### What runs (server, on arrival, every account kind the arrival queue reads)

The verdict is Okolos's shape: what fired, plus what could not be looked at, never a score
(`okolos-extension/packages/core-mail/src/verdict.ts`).

| Check | Okolos piece | New or existing |
|---|---|---|
| `senderAuth`: DMARC, SPF, DKIM results and alignment from `Authentication-Results` | `core-mail` `checkSenderAuth` | new (vendored) |
| `senderIdentity`: From domain imitates a known one; a brand in the display name not matching the domain | `core-mail` `checkSenderIdentity` with the vendored `checkLookalike` and the server's own `DOMAINS` | new |
| `replyPath`: Reply-To on another domain | `core-mail` `checkReplyPath` | new |
| `links`: feed-listed host, lookalike host, a link whose visible text names another domain than it goes to | existing feed and lookalike checks; the text-versus-target check is new (S04 uses it) | widened |
| `hidden`: instructions in text a person does not see | existing `inspectMessage` | existing |
| `attachments`: per file, the type its first bytes show against its name and declared type, double extensions, files that run code, archives, instructions in documents | `core-download` `judgeDownload` with a magic-byte reader on the stored file | new for type by content |

The vendored set grows by `core-mail` and `core-download` the way three packages already are (`vendor/okolos/README.md`,
`manifest.json` hashes, `tests/okolos-vendor.test.ts`), pinned to one Okolos commit.

### The model with no tools

- It is the review the server already runs (`reviewHeld`), widened: it is called when any check fired (any severity
  above none) or a document attachment was read, inside the daily safety budget (`safety_budget`).
- Its input is the message as fenced data (the `untrusted-fence` pattern: a random fence per call, a preamble that the
  block is data, forged fence lines neutralised), the deterministic signals and the per-file judgements.
- Its output is `{severity, summary}` folded with Okolos's `applyReview`: it may lower the severity (explain a false
  alarm), never raise it beyond what a check found, and its summary is shown as the reviewer's words, labelled as such.
- It has no tools, no network and no memory; the call is one `generateObject`.
- No budget left, or the call failing: the verdict stands as the checks made it, with "review did not run: <why>" in
  its not-run list. Unchecked is never shown as clean.

### What is stored

The per-message record in the categories store's `safety` table (`workers/categories/schema.ts:50-59`) carries the
assembled verdict in `findings` under a new `verdict` key: `{severity, signals[], notRun[], files[], review}`. A
schema step adds nothing new to the table: `findings` is JSON. Rows written before this change have no `verdict`;
they read as "checked before this version" with "Check now".

### What a person sees

A badge at the right of the subject line (S02), one of four:

| Verdict | Badge | Look |
|---|---|---|
| Nothing fired, every check ran | "Checked by Okolos" («Проверено Okolos») | green shield |
| Nothing fired, a check did not run | "Partly checked" («Проверено частично») | grey shield |
| Minor or major signal | "Looks suspicious" («Похоже на подделку» for sender signals, «Подозрительное» otherwise) | amber |
| Critical, a feed-listed link, a file that runs code, or held | "Dangerous" («Опасно») | red |

Clicking the badge opens a panel under the header (not a modal):

- **What was checked:** one line per check with its outcome in plain words ("The sender's domain confirmed it sent
  this (DMARC)", "Links: 4 checked, none on the phishing list"), and the facts a person can check themselves (the
  domain, the link's real host).
- **Files:** one line per attachment: what it is by its content, whether that matches its name, its verdict.
- **What did not run, and why** (no Authentication-Results from this provider, the file was too large to read, the
  review budget for today is spent).
- **The reviewer's note**, labelled "The reviewing model's note" («Заметка проверяющей модели»), when it ran.
- **First steps**, at most three, for amber and red: "Don't open its links" (S04 already blocks them), "Report as spam"
  (moves it to Spam), "Discard"; for a held message, the existing Release / Keep held.
- A one-line "What is Okolos?" note with what it does and that it ran on this server.

A file with an amber or red verdict asks once before it downloads ("This file says it is a PDF but is a program.
Download anyway?"); a red one by its content (a program dressed as a document) offers no download from the reader,
only "Save to Downloads anyway" under the panel's details.

## Agent tool

`list_held_messages` already returns one message's verdict by `accountId` and `messageId`
(`workers/mcp/tools.ts:378-379`); it gains the assembled verdict (`verdict`) beside the held state, so an agent reads
the same answer as the badge. A new route "check this message now" gets a tool `check_message_safety` (level mail).

## Words

Every new string goes through copywriting and the copy check in both locales; the table above holds the badge words.
The panel's sentences are catalogue keys with arguments (Okolos's `buildReport` returns keys, never sentences), each
translated in `shared/i18n/ru/`.

## Acceptance

- Vendor: `core-mail` and `core-download` hashed in `vendor/okolos/manifest.json`; `tests/okolos-vendor.test.ts`.
- Unit, with fixtures under `tests/fixtures/mail/`: DMARC fail; a lookalike From; Reply-To on another domain; a link
  whose text says one domain and goes to another; a `.pdf` that is a Mach-O or PE by its bytes; a double extension;
  an `.eml` with no Authentication-Results (not run, said so); the review lowering and trying to raise (clamped).
- Worker (workerd): the arrival queue writes `findings.verdict` for Cloudflare and one remote account kind; the
  budget spent leaves "review did not run".
- WebKit walk: the four badges and the open panel on the preview fixture.
- SCN-010 refined and a new SCN row "See what the safety check found" with these steps.

## Out of scope

Antivirus signatures (no engine runs in a Worker; the panel says "No antivirus scan ran" in its not-run list rather
than implying one did); sending a file anywhere outside the owner's server.

## Risks

- False alarms on mail from providers that rewrite headers: the sender checks report what the header says, not a
  guess, and a missing header is "did not run", never a failure.
- Cost: the model is called only when a check fired; the daily budget bounds it.
