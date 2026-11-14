# S04. Links in a suspicious message ask before they open (B-270)

**Asked:** «если вдруг мы обнаруживаем какую-то уязвимость, мы, во-первых, не даем кликать и открывать ссылки, мы при
клике показываем уведомления».

Revised after review round 1 (SEC-3, SEC-4, SEC-5, SEC-10, KIMI-4, KIMI-5, UX-5, UX-6, IR-5, CB-1).

## Today

Every link opens in a new window with no opener (`app/components/EmailIframe.tsx:54-55`); while a message is held,
links to feed-listed and lookalike hosts lose their `href` (`:47-52`, `workers/routes/inbox.ts:372-373`). The frame
keeps `allow-popups` (`:217`); its one script runs only with `autoSize` (`:133`), and some views render without it
(`SingleMessageView.tsx:45`, `ThreadMessage.tsx:162`). The desktop right-click menu opens a link directly
(`desktop/main.cjs:703-708`).

## Target

**The guard lives in the sanitizer, not in a click handler.** Links ask when the link check cannot vouch for them: the
message is red; or amber; or the links check did not run fully (no record yet, the record checked against an older feed
than the server's current `feedVersion`, the feed missing or stale, the link cap hit); or a link-related signal fired. A message that is grey only because another check did not run
(sender authentication on IMAP, a file too large) keeps working links when its links check ran clean. Sent mail and
drafts are not guarded (S03). In those cases every `a` and `area` loses its `href` while it is sanitized (the hook that already strips feed-listed links);
it keeps a `data-okolos-link` index into a list the reader holds. A link with no `href` cannot be opened by a middle
click, a modifier click, Enter, a drag, or the desktop menu: there is nothing to open.

- **What the browser would open is what was checked:** the sanitizer resolves every surviving `href` with `new URL()`
  (a message has no base URL, so a relative or malformed one fails) and keeps it only when that exact resolved URL is in
  the record's per-link list; any other href (`https:\\host`, `https:host`, a URL split by a tab or a newline, an
  entity-encoded one the server's pattern missed) loses its `href` and asks first, whatever the message's colour.
- The frame's script runs for every message (made so by S08 in W2) and reports an activated link only as
  its index (`postMessage({type: "link", index})`) on `click`, `auxclick` and Enter.
- The reader resolves the index in its own list (never a URL from the frame), accepts only `http`, `https` and
  `mailto` after `new URL()`, requires user activation, and decides:

| Message or link | What happens |
|---|---|
| Red message, or a feed-listed link | A notice: where the link goes, why; "Don't open" and "Copy address" |
| Amber message, links not fully checked, a lookalike link, or a link whose text names another domain | A notice: "This link goes to <host>", why; "Don't open" (focused) and "Open anyway" |
| Links check ran clean and the message is green or grey for another reason | Links keep their `href` and open as today |

- **The notice** is an inline alert above the message frame (`role="alert"`), focus moves to it, Escape is "Don't
  open", focus returns to the frame after. "Open anyway" is remembered for that link of that message until the window
  closes, and opens through the same path as a green link.
- Hosts in the notice are shown in punycode with the registrable domain emphasised; bidi and zero-width characters
  removed.
- Every view that shows a message body goes through `EmailIframe` with the colour: the unified reader, its thread
  cells, the forward preview in the composer, and the older mailbox route's `SingleMessageView` and `ThreadMessage`
  (which pass the row's colour, grey when they have none).
- The desktop menu needs no change: a link without `href` gives it no link to open; "Copy address" lives in the notice.

## Words

| English | Russian |
|---|---|
| This link goes to {host} | Эта ссылка ведёт на {host} |
| The safety check found this message dangerous, so its links do not open. | Проверка нашла это письмо опасным, поэтому его ссылки не открываются. |
| This message was not fully checked, so its links ask first. | Это письмо проверено не полностью, поэтому ссылки открываются только после вопроса. |
| The text of the link says {shown}, but it goes to {host}. | В тексте ссылки {shown}, а ведёт она на {host}. |
| This message looks suspicious, so its links ask first. | Письмо выглядит подозрительно, поэтому ссылки открываются только после вопроса. |
| This site is on the phishing list. | Этот сайт есть в списке фишинговых. |
| This address imitates {resembles}. | Этот адрес подделывается под {resembles}. |
| Don't open | Не открывать |
| Open anyway | Всё равно открыть |
| Copy address | Скопировать адрес |

## Acceptance

- Unit: `linkDecision(record, link)` over every row (an IMAP message with clean links opens directly; a stale feed asks; sent mail is not guarded), and the scheme allowlist (`javascript:`, `data:`, `file:` and
  an unparsable URL never open).
- Unit: on a green message, `https:\\evil.example`, `https:evil.example` and a URL with a tab inside lose their `href`
  and ask; a link in the record keeps it.
- Unit: the sanitizer for amber, red and grey removes every `href` (`a`, `area`, SVG `a`) and keeps the index; green
  keeps them.
- Unit: a forged `postMessage` with a URL instead of an index opens nothing.
- WebKit walk: a red message's link (click, middle click, Enter) shows the notice and opens nothing; an amber one
  opens after "Open anyway"; a green one opens directly.
- SCN-010's REL-05 line and SCN-088 name this behaviour.
