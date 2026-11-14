# S04. Links in a suspicious message ask before they open (B-270)

**Asked:** «если вдруг мы обнаруживаем какую-то уязвимость, мы, во-первых, не даем кликать и открывать ссылки, мы при
клике показываем уведомления».

## Today

Every link opens in a new window with no opener (`app/components/EmailIframe.tsx:54-55`); only hosts on the Okolos
phishing feed lose their `href` and are struck out (`:47-52`). There is no click interception; a lookalike link opens
on a click.

## Target

- The message frame reports every link click to the reader (the frame already runs one script for its height,
  `EmailIframe.tsx:131-147`; the click goes the same way, `postMessage` with the link's target and visible text) and
  never opens it itself.
- The reader decides by the message's verdict (S03) and the link's own signals:

| Case | On a click |
|---|---|
| The message is red (S03), or the link is on the phishing feed | A notice: where the link really goes, why it is blocked; buttons "Stay here" only. The host can be copied. |
| The message is amber, or the link is a lookalike, or its text names another domain than it goes to | A notice: "This link goes to <real host>", why it is suspicious; "Stay here" (default) and "Open anyway" |
| Anything else | Opens as today, no notice |

- "Open anyway" is remembered for that link in that message only, until the window closes.
- A held message (B-178) is red for this purpose until a person releases it.
- In the desktop app the link opens in the person's browser as today (B-227 right click unchanged).

## Words

| English | Russian |
|---|---|
| This link goes to {host} | Эта ссылка ведёт на {host} |
| The safety check found this message dangerous, so its links do not open. | Проверка сочла это письмо опасным, поэтому его ссылки не открываются. |
| The text of the link says {shown}, but it goes to {host}. | В тексте ссылки {shown}, а ведёт она на {host}. |
| Stay here | Остаться |
| Open anyway | Всё равно открыть |

## Acceptance

- Unit: the decision table as a pure function (`linkDecision(verdict, link)`) with each row.
- Unit: the frame script posts `{href, text}` and prevents the default; a link with `javascript:` or `data:` never opens.
- WebKit walk: a red message's link shows the notice and opens nothing; an amber one opens after "Open anyway".
- SCN-010's REL-05 line and the new S03 scenario name this behaviour.

## Out of scope

Rewriting links in stored mail; links in the composer.
