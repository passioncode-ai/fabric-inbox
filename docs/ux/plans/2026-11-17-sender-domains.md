# S03c. Look up the sender's domains: who registered them, whether they take mail, what their site does (B-288)

**Asked** (operator, 2026-11-17, with a screenshot of an enquiry whose From was our own address and whose Reply-To was
on a stranger's domain): «надо еще уметь ходить на домен и проверить домен отправителя и найти инфу если есть
подозрение что может быть фишинг или вирус».

## Today (`main` `e0ca9cb8`)

The Okolos panel (S03, `app/components/inbox/SafetyBadge.tsx`) says what the six arrival checks found
(`workers/safety/verdict.ts` `buildCheck`). For the sender it reads only the message: the receiver's DMARC, SPF and
DKIM result, a lookalike or brand-named From, and a Reply-To on another domain (`workers/safety/sender.ts`). It knows
nothing about the domains themselves: when the domain was registered, by whom, whether it takes mail or publishes a
mail policy, or what its site does. The screenshot's case shows the gap: the panel says replies go to
`brand-invest.example` and stops there, though a person deciding whether this is a scam wants to know that domain's age
and what answers on it.

## Target

### 1. The lookup (server, on request)

`workers/safety/domains.ts` `lookupDomains` looks up the registrable domain of every From and Reply-To address of
one message (at most 4 domains, each once, its roles kept: `from`, `replyTo`). For each domain, three reads, each
with an 8-second deadline, none with the person's or the server's credentials:

| Read | How | What is kept |
|---|---|---|
| Registration (RDAP) | `GET https://rdap.org/domain/<domain>` (the public RDAP redirector to the registry's own server, RFC 9082), named with a User-Agent (it answers 403 without one); when it does not answer, the registry's own https server from IANA's bootstrap list (`data.iana.org/rdap/dns.json`, RFC 9224) | the registration, expiry and last-changed dates, the registrar's name, the status list; `notFound` on 404; `failed` otherwise |
| DNS | Cloudflare's DNS over HTTPS (`cloudflare-dns.com/dns-query`, JSON): `A`, `MX`, `TXT` of the domain and `TXT` of `_dmarc.<domain>` | whether the name resolves (NXDOMAIN), the mail hosts, whether an SPF record is published, the DMARC policy (`p=`) |
| The site | `GET https://<domain>/`, redirects followed by hand (at most 5), at most 64 KiB of the body read, no cookies, no script run | the status, every hop's host, the final address, whether it leaves the domain, the page title, whether it asks for a password, whether it hands over a file |

Rules that keep the lookup safe:

- **Only the domain's root is visited, never a link from the message**: a link may carry a token that tells the sender
  which reader opened it; the root names no one. The visit comes from the server, never from the person's computer.
- **Never the server's own domains** (`DOMAINS`) and never a name that is not a public registrable domain (an IP
  address, `localhost`, a single label, a reserved suffix such as `.local`, `.internal`, `.test`, `.invalid`; `.example` never resolves, so it needs no rule): those
  are listed as not looked up, with why.
- **Every hop's host is checked against the Okolos phishing feed and the lookalike check** before the next request; a
  listed or lookalike hop stops the visit.
- The page title is stripped of zero-width and bidirectional characters and cut to 120 characters, and is shown as a
  quote, never as the panel's own words.

### 2. What it can say, and what it changes

Each domain gets signals in the same shape as the six checks (`severity`, `code`, `facts`), codes in the `inbox*`
catalogue:

| Code | Severity | When |
|---|---|---|
| `inboxDomainSitePhishing` | critical | a hop of the site is on the Okolos feed |
| `inboxDomainLookalike` | critical | the domain, or a hop of its site, imitates a watched name (Okolos `checkLookalike`; for a From domain the identity check already said so, so only a Reply-To domain and the site's hops are new) |
| `inboxDomainNew` | major | registered less than 30 days before the lookup |
| `inboxDomainUnregistered` | major | the registry has no such domain (RDAP 404) and the name does not resolve |
| `inboxDomainOnHold` | major | the registry status holds it (`client hold`, `server hold`, `redemption period`, `pending delete`): registries put domains on hold for abuse |
| `inboxDomainSiteBrand` | major | the page title names a watched brand (Okolos's watchlist and `DOMAINS`, its `brandIn` word rule) and neither the domain nor the page's last hop is that brand's; the operator's case (a title naming an investment brand on a stranger's domain) fires once the brand is on the watchlist, which Okolos owns |
| `inboxDomainSiteFile` | major | the root hands over a file (`Content-Disposition: attachment`, or a program, archive or disk image type) |
| `inboxDomainSitePassword` | minor | the root page asks for a password |
| `inboxDomainSiteElsewhere` | minor | the site sends you to another registrable domain |

The colour (`colourOf`, one table for S03, S04 and S09) reads the lookup the way it reads the review: **only
upward**. A critical domain signal is red (`Dangerous`); a major one makes a green, grey or "Sender may be forged"
message `Suspicious message`; a minor one is shown and changes nothing. A lookup that did not run, or ran in part,
never lowers a colour and never makes a message grey: the six checks decide completeness, the lookup only adds.

### 3. Where it is kept, and who may run it

- Stored as `findings.domains` (`DomainLookup`, version 1) beside `findings.check`, written with `json_set` so the
  message's state, review and check stay as they are (the same rule as `POST /api/safety/check`, R6-1); a recheck of
  the six checks keeps it.
- `POST /api/safety/domains {accountId, messageId, refresh?}`: runs the lookup and answers the record and the feed
  version. A lookup younger than 24 hours is answered from the record unless `refresh` is true. At most 100 lookups a
  day per server (each lookup is up to about 40 requests); over it the answer says so (429) and nothing is written. A
  message with no record gets its six checks first. Member gate: allowed to a member, as the check is.
- MCP tool `look_up_sender_domains` (level mail) over the same route.

### 4. What a person sees

In the panel, after "What was checked", a section **The sender's domains**:

- Before a lookup: one line saying what it does («Looks up who registered the sender's domains, whether they take mail
  and what their site does. The site is visited from your server, at its main page only.») and a button **Look up the
  domains**. For an amber or red message the same button is also in First steps.
- After: one block per domain: the domain in ASCII with its role («brand-invest.example, replies go here»), then plain
  lines: registered when and by whom, how old; takes mail or not; SPF and DMARC published or not; what its site
  answered (status, title as a quote, where it sent you). A line that fired carries the warning mark, as the six
  checks do. What could not be looked up says why. «Looked up {time}» and **Look up again**.
- While it runs: «Looking up…» on the button; a failure says so in the panel and the button stays.

## Out of scope

- Reputation services that need an account or a key (VirusTotal, URLhaus, Spamhaus DBL): a later row, once a key is
  held for this server.
- Running the lookup on arrival for every message: it visits sites the sender controls and spends requests; it runs
  when a person or an agent asks.
- A search engine query about the domain: no search provider is wired into the server.
