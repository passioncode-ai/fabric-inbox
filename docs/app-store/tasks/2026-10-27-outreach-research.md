# B-181 research: outreach campaigns in Fabric Inbox

Research cut: 2026-10-27. Web only, read-only. Every claim carries its source URL. Where a source is a
third party rather than the vendor or the standard, it is marked "(third party)". Where sources
disagree, both are named.

## 0. What matters most for us (read this first)

1. **Cloudflare Email Service is transactional only.** Its FAQ answers "can it be used for marketing
   emails?" with "No. Email Service supports transactional email only."
   ([CF FAQ](https://developers.cloudflare.com/email-service/reference/faq/)). A cold or marketing
   campaign sent from a person's Cloudflare address through Email Service would break that rule.
   V1 campaigns should send only through the person's connected Gmail, Outlook and IMAP/SMTP
   accounts, and keep Cloudflare-domain addresses out of the campaign sender list until Cloudflare
   allows marketing mail (decision for the operator, see section 7).
2. **Mailbox providers say their own pipes are not for bulk.** Gmail: "Don't use Gmail to distribute
   spam or unsolicited commercial mail" ([Gmail Program Policies](https://support.google.com/mail/answer/16734397)).
   Exchange Online: bulk commercial senders "should use third-party providers"
   ([Exchange Online limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits)).
   Low, human-paced volume per mailbox is therefore the product's safety model, not an option.
3. **Every outreach tool converges on the same core:** per-mailbox daily cap, sending window with
   time zone, random gap between sends, stop on reply, pause (not stop) on auto-reply, stop at the
   whole company domain on reply (free-mail domains excluded), global unsubscribe list, bounce
   auto-pause, List-Unsubscribe header, plain text and tracking off as options, webhooks, and now MCP.

## 1. The tools, mechanic by mechanic

### 1.1 Instantly
- **Model:** campaign holds sending accounts (rotated, no cap on count), schedule, sequence steps
  with A/Z variants, leads with custom variables. Up to 50 custom variables per campaign, column
  names capitalised and at most 20 characters ([Instantly blog on dynamic tags](https://instantly.ai/blog/personalize-reminder-emails-with-dynamic-content-tags/)).
  Spintax syntax `{{RANDOM | a | b}}`, variables can nest inside ([Instantly spintax](https://instantly.ai/blog/spintax/)).
  Variants: "Add variant" per step, auto-optimise picks a winner by reply, click or open rate
  ([A/Z testing help](https://help.instantly.ai/en/articles/6661549-a-z-testing-how-to-create-email-variants)).
- **Scheduling:** named schedules with days, window and time zone; modes 24/7, office hours or custom
  ([Campaign Settings](https://help.instantly.ai/en/articles/6222396-campaign-settings)).
  Minimum gap default 9 minutes plus random extra default 5 minutes (9 to 14 minutes); per-account
  "minimum wait time" default 1 minute across campaigns (same page;
  [Account and Campaign Limits](https://help.instantly.ai/en/articles/6248612-account-and-campaign-limits)).
  API fields `email_gap`, `random_wait_max`, `daily_limit`, `campaign_schedule.schedules[]`
  ([API schema](https://developer.instantly.ai/api-reference/schemas/campaign)).
- **Caps and ramp:** campaign daily limit and per-account daily limit; the account limit wins.
  Recommendation 30 campaign emails + 10 warm-up per account per day; "Campaign Slow Ramp" adds
  2 emails per day until the cap ([Account and Campaign Limits](https://help.instantly.ai/en/articles/6248612-account-and-campaign-limits)).
  "Max new leads" caps step-1 sends per day ([Campaign Options](https://help.instantly.ai/en/articles/6222396-campaign-options)).
- **Deliverability options** ([Campaign Options](https://help.instantly.ai/en/articles/6222396-campaign-options)):
  open tracking, link tracking, text-only (strips HTML, disables open tracking), first email
  text-only, provider matching (Gmail to Gmail), "Unsubscribe link header" for one-click, limit
  emails per company domain per day, BounceProtect, risky-email filter.
- **Stop rules:** stop on reply; "Stop for company on reply" stops every lead on that domain and
  marks them Completed, auto-replies do not trigger it; stop on auto-reply exists but the vendor
  advises leaving it off so its "Smart Pause" handles out-of-office (same page).
- **API/webhooks:** REST v2, Bearer key; webhook events `email_sent`, `email_opened`,
  `reply_received`, `auto_reply_received`, `link_clicked`, `email_bounced`, `lead_unsubscribed`,
  `account_error`, `campaign_completed` ([webhook events](https://developer.instantly.ai/guides/webhook-events)).
  No official MCP server found.

### 1.2 Smartlead
- **Stop rules:** API `stop_lead_settings` = REPLY_TO_AN_EMAIL, OPENED_EMAIL, CLICKED_LINK, NEVER
  ([campaigns API](https://api.smartlead.ai/core/campaigns)); the setup guide shows booleans
  `stop_on_reply`, `stop_on_auto_reply`, `stop_on_click` and says always enable stop on reply
  ([campaign setup guide](https://api.smartlead.ai/guides/campaign-setup)). Company-level auto-pause
  on reply exists (same guide; [creating a campaign](https://helpcenter.smartlead.ai/en/articles/34-creating-a-cold-email-campaign)).
- **Scheduling:** `POST /campaigns/{id}/schedule` with time zone, days, hours,
  `min_time_btwn_emails` and `max_new_leads_per_day`; docs disagree on the field spelling and on the
  recommended gap (5 to 12 minutes in the guide, 120+ elsewhere)
  ([campaign setup guide](https://api.smartlead.ai/guides/campaign-setup)). Campaign gap should exceed the
  mailbox gap by at least 2 to 3 minutes; one mailbox's daily limit is shared across campaigns
  ([not sending or sending less](https://helpcenter.smartlead.ai/en/articles/228-my-campaign-is-not-sending-emails-or-sending-less-volume)).
- **Domain-level rate limiting:** a checkbox that slows sends per sending domain, suggested for
  low-volume Outlook mailboxes ([domain-level rate limiting](https://helpcenter.smartlead.ai/en/articles/298-improve-deliverability-with-domain-level-rate-limiting-for-shared-mailboxes)).
- **Bounces:** "High Bounce Rate Auto Protection" pauses the campaign at a set bounce rate (example
  5%) ([article 274](https://helpcenter.smartlead.ai/en/articles/274-what-is-high-bounce-rate-auto-protection-in-smartlead));
  rate = bounces / total leads, checked on every bounce, then a webhook
  ([article 210](https://helpcenter.smartlead.ai/en/articles/210-bounce-autopause-and-webhook)).
- **API/webhooks/MCP:** events `EMAIL_SENT`, `EMAIL_OPEN`, `EMAIL_LINK_CLICK`, `EMAIL_REPLY`,
  `EMAIL_BOUNCE`, `LEAD_UNSUBSCRIBED`, `LEAD_CATEGORY_UPDATED`; retries after 1, 5, 30 minutes; a
  4xx is permanent ([webhook events](https://api.smartlead.ai/api-reference/webhooks/events)). Official
  MCP server at mcp.smartlead.ai over SSE with the API key in the URL
  ([Smartlead MCP Server](https://helpcenter.smartlead.ai/en/articles/300-smartlead-mcp-server)).

### 1.3 lemlist
- **Scheduling:** per-campaign schedule with time zone, days, window and delay between first-step
  sends; follow-up timing is computed by its algorithm, emails spread across the window (example
  100 leads over 9:00 to 17:00) ([sending algorithm](http://help.lemlist.com/en/articles/4452763-understand-lemlist-s-sending-algorithm)).
  Step delays: 2 to 3 days for cold outreach (same article).
- **Limits:** "Maximum number of emails sent by lemlist in 24h" per sending address, counted over a
  rolling 24 hours, shared by all campaigns of that address; start 10 to 15 per day, add 5 per week,
  stop at 25 to 30; warm-up plus campaigns at most 50 per day per mailbox; a domain under a month
  old under 100 per day in total ([sending limits](https://help.lemlist.com/en/articles/4508367-understand-sending-limits-in-lemlist)).
- **Stop rules:** default stop on reply; "Also pause contacts from the same company", matched on
  the Company Name field, within one campaign only
  ([pause on company engagement](http://help.lemlist.com/en/articles/13338246-how-to-pause-a-campaign-when-one-lead-from-a-company-engages);
  [stop on reply or click](https://help.lemlist.com/en/articles/4452787-stop-emailing-leads-who-replied-or-clicked)).
- **Unsubscribe:** body link `{{unsubscribe_url}}`; a click unsubscribes the lead across the whole
  account; manual list accepts addresses and whole domains (`@domain`)
  ([unsubscribe links](https://help.lemlist.com/en/articles/4452779-how-to-add-and-manage-unsubscribe-links)).
  Click tracking needs a custom tracking domain (CNAME) ([link tracking](http://help.lemlist.com/en/articles/4452718-fix-link-clicks-not-being-tracked)).
- **API/webhooks/MCP:** webhooks `emailsSent`, `emailsOpened`, `emailsClicked`, `emailsReplied`,
  `emailsBounced`, unsubscribe as `entityUnsubscribed` / `variableUnsubscribed`
  ([add webhook](https://developer.lemlist.com/api-reference/endpoints/webhooks/add-webhook)).
  Official hosted MCP at app.lemlist.com/mcp, OAuth or API key, tool groups include campaign
  builder (steps, previews, A/B variants, senders) and unsubscribes
  ([MCP setup](https://developer.lemlist.com/mcp/setup)).

### 1.4 Apollo sequences
- **Scheduling:** named schedules applied per sequence; step wait is a minimum calendar delay
  (weekends count), then the next allowed window ([sending schedule](https://knowledge.apollo.io/hc/en-us/articles/4409477927309-Configure-a-Sequence-Sending-Schedule)).
- **Mailbox limits:** daily, hourly and minimum delay per mailbox; current recommendation 50 to 100
  per day, 10 to 20 per hour, 60 to 300 seconds delay; older default was 50/day, 6/hour, 600 s;
  rolling 24 hours; over-limit emails stay scheduled; ramp-up uses the lower of ramp and limit
  ([sending limits](https://knowledge.apollo.io/hc/en-us/articles/4409233349005-Configure-Email-Sending-Limits)).
  Checklist: at least 60 s between sends, ramp about 25 more per day
  ([sender reputation checklist](https://21165194.fs1.hubspotusercontent-na1.net/hubfs/21165194/Apollos%20Strong%20Sender%20Reputation%20Checklist.pdf)).
- **Rulesets** ([rulesets](https://knowledge.apollo.io/hc/en-us/articles/4409396858509-Manage-Sequence-Rulesets)):
  finish on reply and pause on out-of-office are on by default, with automatic resume on the return
  date; unchangeable protections: finish on unsubscribe, fail on bounce or spam rejection, hard
  bounce removes the address; "another reply within the same account": do nothing, mark following
  emails not sent, or delay them.
- **MCP:** official at mcp.apollo.io/mcp, Streamable HTTP, OAuth; find sequences, list mailboxes,
  add or remove contacts ([Apollo MCP](https://docs.apollo.io/docs/apollo-mcp)).

### 1.5 Woodpecker
- **Limits and pace:** default 50 prospects contacted per day per mailbox; interval range default
  about 90 to 140 s between emails (about 30 per hour), configurable
  ([boost sending settings](https://help.woodpecker.co/article/103-settings-boost-sending)).
  Adaptive Sending cuts volume when a mailbox nears its provider limit
  ([safely scale up](https://woodpecker.co/blog/safely-scale-up-cold-email-outreach/)).
  Default follow-up delays 3, 6, 12, 18 days (third party: [leadhaste](https://leadhaste.com/blog/how-to-use-woodpecker-for-cold-email)).
- **Statuses:** ACTIVE, BLACKLISTED, RESPONDED, INVALID, BOUNCED, OPT-OUT, AUTOREPLIED, PAUSED,
  REMOVED, NONRESPONSIVE; BLACKLISTED is global ([prospect status](https://woodpecker.co/help/prospect-status/)).
- **Stop rules:** reply sets RESPONDED and stops follow-ups; same prospect in another campaign gets
  "Paused (Other Campaign)"; optional auto-pause of other prospects on the same domain when one
  replies or bounces, never for free domains like gmail.com
  ([what happens on reply](https://woodpecker.co/help-center/en/articles/5265608-what-happens-when-a-prospect-replies-to-my-email)).
- **Webhooks:** account-level, POST, exponential backoff; `prospect_replied`, `prospect_bounced`,
  `prospect_opt_out`, `prospect_autoreplied`, `prospect_blacklisted` and more
  ([webhooks](https://developers.woodpecker.co/docs/webhooks/)). No MCP server found.

### 1.6 Reply.io
- **Sequence settings:** max new contacts per day (up to 1000), max emails per day, delay between
  emails (recommend at least 120 to 180 s); reply handling "Mark person as finished"; finished after
  N days without reply (default 5); per-day cap on contacts from the same business domain, free
  domains excluded; "Enable List-Unsubscribe header" toggle
  ([sequence settings](https://support.reply.io/en/articles/3053016-sequence-settings);
  [opt-out and unsubscribe header](https://support.reply.io/hc/reply-help-center/articles/how-do-i-set-up-my-opt-out-text-link-and-unsubscribe-header)).
- **Mailbox safety:** random delay min/max; new accounts default 300 to 450 s; account settings win
  over sequence settings; ramp-up on by default, 10 per day plus 3 per day up to 100
  ([how Reply works](https://how.reply.io/); [warm up](https://how.reply.io/workflows/warm-up-new-mailboxes/)).
- **Statuses:** Out of office pauses the sequence and clears itself after N days; Auto-replied is
  separate; neither counts as a reply ([contact statuses](https://support.reply.io/en/articles/978110-contact-statuses)).
  Account-level "pause contact in all sequences on reply" and same-organisation pause, off by
  default ([contact remained active](https://how.reply.io/troubleshooting/contact-remained-active-after-reply/)).
- **API/webhooks/MCP:** v3 webhooks `email_sent`, `email_replied`, `contact_replied`,
  `email_bounced`, `contact_opted_out`, `email_auto_reply`, account connection lost
  ([webhook events schema](https://docs.reply.io/api-reference/schemas/webhook-events)); official MCP
  server ([integrations](https://how.reply.io/capabilities/integrations/)).

### 1.7 Mailshake
- **Limits:** sending calendar spaces sends; on a detected Google quota it pauses and resumes;
  Microsoft and SMTP accounts capped by Mailshake at 1000 per day; ramp Week 1: 20/day, 2: 40,
  3: 55, 4: 75, 5: 100, step back if bounces exceed 5%
  ([spam and quotas](https://docs.mailshake.com/article/37-spam-concerns-and-hitting-quotas);
  [emails per day](https://docs.mailshake.com/article/57-how-many-emails-can-i-send-per-day)).
- **Unsubscribe:** reply-based unsubscribe always on (phrases like "unsubscribe" or "remove me" in
  the first 15 or so words); body or signature link optional
  ([unsubscribes](https://docs.mailshake.com/article/60-how-does-mailshake-manage-unsubscribes)).
  Follow-ups stop on reply, unsubscribe or bounce ([cadence](https://docs.mailshake.com/article/231-copywriting-deliverability)).
- **API:** Push subscriptions via `push.create({targetUrl, event})` in the official SDK
  ([mailshake-node](https://github.com/mailshake/mailshake-node/blob/master/README.md)); CRM sync events
  include Sent, Opened, Clicked, Replied, Bounced, Unsubscribed
  ([CRM events](https://docs.mailshake.com/article/215-what-events-can-sync-to-your-crm)).

### 1.8 GMass (sends through the person's own Gmail)
- **Pace:** optional pause after each email, picked at random from 5 to 10 s, 10 to 60 s, 1 to 5 min
  or 5 to 10 min; works with a max-per-day setting; turned on by itself for new Gmail accounts
  ([throttle](https://www.gmass.co/blog/mail-merge-feature-throttle-your-email-campaign/)).
- **Quota handling:** reads the last 24 h of sends and over-limit bounces, pauses and retries in an
  hour, spreads large campaigns over days ([Gmail limits](https://www.gmass.co/blog/understanding-gmails-email-sending-limits/)).
- **Follow-ups:** stages until reply, open, click, or "reply or click"; days counted from the
  original send; a stage never goes to someone who missed the earlier one
  ([auto follow-up](https://www.gmass.co/blog/auto-follow-up-emails-until-reply/)). Company-wide stop:
  exact domain match, popular consumer domains excluded, account-wide, off by default
  ([anybody at company replies](https://www.gmass.co/blog/auto-followup-stop-email-anybody-at-company-replies/)).
- **Unsubscribe:** account Unsubscribe List checked on every send; optional global list across the
  Workspace org; list-unsubscribe header is an account checkbox; reply and bounce tracking work
  without links ([unsubscribe management](https://www.gmass.co/features/unsubscribe-management);
  [disable all tracking](https://www.gmass.co/workflows/disable-all-tracking)).

### 1.9 YAMM (Yet Another Mail Merge, Gmail + Sheets)
- **Quota:** free 20 recipients per day; paid 400 per day on @gmail.com and 1,500 per day on
  Workspace; counted as recipients over a rolling 24 h; longer lists spread over days
  ([Marketplace listing](https://workspace.google.com/marketplace/app/yet_another_mail_merge_mail_merge_for_gm/52669349336);
  [YAMM on Gmail limits](https://yamm.com/blog/gmail-sending-limits/)).
- **Tracking:** sheet columns for opened, clicked, replied, bounced, unsubscribed; unsubscribe link
  in body; bounced and unsubscribed addresses skipped later
  ([YAMM 2024 guidelines](https://yamm.com/blog/2024-guidelines-for-sending-bulk-emails-to-google-and-yahoo-accounts/)).
  No source found saying YAMM adds one-click headers.
- **Gmail's own mail merge** adds a unique unsubscribe link and skips unsubscribed recipients,
  capped at 1,500 recipients per day (third party: [aiemaily](https://aiemaily.com/blog/gmail-multi-send-mail-merge));
  Google lists 1,500 per day for mail merge ([Workspace limits](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace)).

### 1.10 Patterns across all nine
| Mechanic | Who does it | Notes |
|---|---|---|
| Per-mailbox daily cap, rolling 24 h | Instantly, lemlist, Apollo, Woodpecker, Reply.io, YAMM | Mailbox cap wins over campaign cap (Instantly, Reply.io) |
| Cap on new leads per day (step 1) | Instantly, Smartlead, Reply.io | Leaves room for follow-ups |
| Random gap between sends | all except YAMM | Ranges seen: 60 to 300 s (Apollo), 90 to 140 s (Woodpecker), 300 to 450 s (Reply.io), 9 to 14 min (Instantly) |
| Ramp-up | Instantly (+2/day), Reply.io (10, +3/day), lemlist (+5/week), Apollo, Mailshake | |
| Stop on reply | all | Default on everywhere |
| Auto-reply: pause, not stop | Apollo (resume at return date), Reply.io, Instantly (Smart Pause) | |
| Company/domain stop | Instantly, Smartlead, lemlist (by company name), Apollo, Woodpecker, Reply.io, GMass | Free-mail domains excluded (Woodpecker, Reply.io, GMass) |
| Global unsubscribe list incl. whole domains | lemlist, Woodpecker, GMass, Mailshake | Reply-based unsubscribe: Mailshake, Reply.io |
| Bounce auto-pause by rate | Smartlead (threshold), Mailshake (5% step back) | Apollo fails the contact and removes the address |
| List-Unsubscribe header | Instantly, Reply.io, GMass (toggle) | |
| Plain text / no tracking | Instantly (text-only), GMass (disable all tracking) | Custom tracking domain for clicks: lemlist, Mailshake |
| Webhooks | all except YAMM | Event set is nearly identical |
| Official MCP | Smartlead, lemlist, Apollo, Reply.io | Not found: Instantly, Woodpecker, Mailshake, GMass, YAMM |

## 2. Mailbox provider rules that apply to every send

### 2.1 Gmail sender guidelines ([support.google.com/a/answer/81126](https://support.google.com/a/answer/81126))
- All senders since 2024-02-01: SPF or DKIM, valid forward and reverse DNS, TLS, RFC 5322 format,
  spam rate in Postmaster Tools below 0.3%.
- Bulk senders (5,000+ messages a day to personal Gmail): SPF and DKIM, DMARC (p=none is enough),
  From aligned with SPF or DKIM domain, one-click unsubscribe plus a visible unsubscribe link in the
  body for marketing and subscribed messages.
- Spam rate target below 0.10%, never 0.30% or more. DKIM keys 1024 bits or longer, 2048 advised.
- One-click headers: `List-Unsubscribe: <https://...>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.

### 2.2 Yahoo ([senders.yahooinc.com/best-practices](https://senders.yahooinc.com/best-practices/))
- All senders: SPF or DKIM, spam rate under 0.3%, valid DNS. Bulk senders: SPF and DKIM, DMARC
  p=none that passes, alignment, RFC 8058 one-click (POST "highly recommended", mailto acceptable),
  visible body link, **honor opt-outs within 2 days**. No fixed bulk threshold is published.

### 2.3 Microsoft consumer mail
- Domains sending over 5,000 messages a day to outlook.com, hotmail.com, live.com need SPF, DKIM and
  DMARC p=none with alignment ([Microsoft Tech Community, 2025-04-02](https://techcommunity.microsoft.com/blog/microsoftdefenderforoffice365blog/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730)).
  From 2025-05-05 failing mail is rejected with 550 5.7.515 (third party: [dmarcian](https://dmarcian.com/microsoft-enforces-spf-dkim-dmarc/)).

### 2.4 RFC 8058 one-click ([rfc-editor.org/rfc/rfc8058](https://www.rfc-editor.org/rfc/rfc8058.html))
- Exactly one HTTPS URI in List-Unsubscribe; List-Unsubscribe-Post value exactly
  `List-Unsubscribe=One-Click`; the receiver POSTs that body with no cookies or auth; the endpoint
  must not redirect; a valid DKIM signature must cover both headers; the URI carries an opaque,
  hard-to-forge token identifying recipient and list.
- For us: the unsubscribe endpoint lives on the person's own Worker (public HTTPS), token signed
  per recipient and campaign. Gmail API sends are DKIM-signed by Google for the account's domain;
  whether Google's signature covers custom List-Unsubscribe headers added in a raw message is
  **not confirmed by any source found**; it must be tested before claiming one-click works there.

### 2.5 Auto-reply detection ([RFC 3834](https://datatracker.ietf.org/doc/html/rfc3834))
- Automatic responses SHOULD carry `Auto-Submitted: auto-replied`; any value other than `no` marks
  an automatic message. `Precedence` is non-standard. Microsoft adds `X-Auto-Response-Suppress`;
  vendors fall back to subject heuristics (third party:
  [mails.ai](https://mails.ai/blog/detecting-auto-replies-prevent-agent-email-loops)).

## 3. Sending limits of the accounts we send from

| Account | Daily limit | Other limits | Source |
|---|---|---|---|
| Google Workspace (paid) | 2,000 messages per user, rolling 24 h | mail merge 1,500/day; 3,000 external recipients/day, 2,000 unique external; 500 recipients per message via Gmail API; lockout up to 24 h | [Workspace sending limits](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace) |
| Google Workspace trial | 500 messages, 500 unique external recipients | does not rise during trial | same |
| Personal @gmail.com | 500 emails per day, 500 recipients per message | blocked 1 to 24 h; many bounces also block | [Gmail Help 22839](https://support.google.com/mail/answer/22839) |
| Gmail API (quota, not mail volume) | 80,000,000 units per project per day billing threshold | `messages.send` 100 units; 6,000 units per user per minute (60 sends/min ceiling); `history.list` 2 units | [Gmail API quota](https://developers.google.com/gmail/api/reference/quota) |
| Exchange Online (Microsoft 365) | 10,000 recipients per day per mailbox | 30 messages per minute; 500 recipients per message; tenant external limit (TERRL), trial tenant 5,000/day; "isn't suited to accommodate bulk-mailing" | [Exchange Online limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits) |
| Outlook.com, Microsoft 365 Personal/Family | 5,000 recipients/day, 500 per message, 1,000 "non-relationship" recipients/day | free accounts lower, unpublished | Microsoft Q&A answers, not a docs page ([Q&A](https://learn.microsoft.com/en-us/answers/questions/5844111/maximum-emails-sent)) |
| Cloudflare Email Service | conservative daily quota that ramps automatically, no number published | 50 recipients per email; 5 MiB; 16 KB custom headers; **transactional only** | [CF limits](https://developers.cloudflare.com/email-service/platform/limits/), [CF FAQ](https://developers.cloudflare.com/email-service/reference/faq/) |

Notes on Cloudflare Email Service relevant even outside campaigns:
- Header allowlist accepts `List-Unsubscribe` (HTTPS or mailto only) and `List-Unsubscribe-Post`
  (exactly `List-Unsubscribe=One-Click`) and any `X-` header; a disallowed header rejects the whole
  send with `E_HEADER_NOT_ALLOWED` ([CF headers](https://developers.cloudflare.com/email-service/reference/headers/)).
- Bounce and complaint suppressions are created automatically, scoped to account or sending domain
  (changelog 2026-09-25) ([CF changelog](https://developers.cloudflare.com/changelog/product/email-service/)).
- The Workers `send_email` binding can be restricted to allowed recipients
  (`E_RECIPIENT_NOT_ALLOWED`) and needs an onboarded, verified sender domain
  ([send from Workers](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)).

## 4. Law, in brief (not legal advice)

- **CAN-SPAM (US)** ([FTC guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)):
  no B2B exemption; truthful headers and subject; identify the message as an ad; a valid postal
  address; a clear opt-out that works for at least 30 days after sending; honour opt-outs within
  10 business days; no fee or extra data to opt out; up to $53,088 per violating email.
- **EU ePrivacy Directive Art. 13** (text via [EUR-Lex OJ L 201](https://eur-lex.europa.eu/LexUriServ/LexUriServ.do?uri=OJ%3AL%3A2002%3A201%3A0037%3A0047%3AEN%3APDF)):
  email direct marketing to natural persons needs prior consent, except the existing-customer soft
  opt-in (13(2)); member states choose how to protect legal persons (13(5)); disguising the sender
  or giving no valid opt-out address is prohibited everywhere (13(4)).
- **GDPR:** Recital 47 says direct marketing "may be regarded as carried out for a legitimate
  interest" ([gdpr-info.eu](https://gdpr-info.eu/recitals/no-47/)); the person keeps the absolute right
  to object to direct marketing (Art. 21(3)) and must be informed (Art. 14). Legitimate interest
  covers processing the data, not the ePrivacy question of sending (third party:
  [Overloop](https://overloop.com/blog/b2b-cold-email-germany-gdpr-compliance)).
- **Member states differ:** Germany's UWG §7(2) requires prior express consent for advertising email
  even B2B (third party: [Overloop](https://overloop.com/blog/b2b-cold-email-germany-gdpr-compliance));
  UK PECR needs no consent for corporate subscribers but does for sole traders and ordinary
  partnerships; every message must identify the sender and offer an opt-out
  ([ICO B2B marketing](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/)).
- **CASL (Canada)** ([CRTC implied consent](https://crtc.gc.ca/eng/com500/guide.htm)): express or implied
  consent; implied via conspicuous publication only when the message relates to the recipient's
  business role; sender identification and an unsubscribe mechanism in every message; unsubscribe
  must work for 60 days and take effect within 10 business days (third party:
  [Gowling WLG](https://gowlingwlg.com/en/insights-resources/guides/2023/doing-business-in-canada-casl)).
- **Product consequence:** the app cannot decide legality per recipient, but it can make the lawful
  path the default: sender identity and postal address fields in the footer, an unsubscribe link
  and header on every campaign message, opt-outs effective immediately (strictest window is Yahoo's
  2 days), a per-campaign "lawful basis / consent" note, and a domain or country blocklist.

## 5. How this maps onto Fabric Inbox (constraints, not design)

- Sending loop runs server-side (Durable Object alarm, like the existing Gmail poll), one queue per
  sending mailbox, so caps and gaps are per mailbox and shared across campaigns (the model every tool
  above uses: Instantly, lemlist, Smartlead).
- Reply detection for Gmail can reuse the history-based polling (`history.list` costs 2 units)
  ([Gmail API quota](https://developers.google.com/gmail/api/reference/quota)); match replies by thread id
  and In-Reply-To/References first, then by sender address and domain.
- Over-limit or provider-throttled sends stay queued and retry, never drop (Apollo, GMass behaviour).
- The person's own deliverability is at stake: one mailbox's spam rate above 0.3% hurts all their
  mail on Gmail, so conservative caps are a safety feature, not an upsell.

## 6. Recommended minimal feature set (v1)

**Build first**
1. Campaign = name, sending mailboxes (only the person's connected Gmail/Outlook/SMTP accounts),
   schedule, steps (step 1 + up to 3 follow-ups, each with a delay in days and "same thread" reply),
   recipients imported from CSV/paste with arbitrary fields, `{{field}}` merge with fallback values,
   preview per recipient, and a missing-field check before launch.
2. Sending loop per mailbox: window (days, hours, time zone), per-mailbox daily cap over a rolling
   24 h shared across campaigns, cap on new recipients per day, random gap, ramp-up for mailboxes
   with no history, pause and retry on provider rate errors (Gmail 421 4.7.28, Exchange throttling).
3. Stop rules: stop on reply (default on), pause on auto-reply (RFC 3834 headers plus subject
   heuristic) with resume after N days, stop on bounce (address marked bounced), stop on
   unsubscribe, company-domain stop on reply (default on, free-mail domains excluded).
4. Unsubscribe: per-recipient signed link in the body footer, `List-Unsubscribe` + `List-Unsubscribe-Post`
   headers to an HTTPS endpoint on the person's Worker (POST with no redirect), a mailto fallback,
   reply-text unsubscribe ("unsubscribe", "remove me"), one global suppression list (addresses and
   whole domains) checked before every send, effective immediately.
5. Safety brakes: campaign auto-pause at a bounce-rate threshold, plain text by default, open and
   click tracking off by default, a hard ceiling per provider below its published limit, refusal to
   use Cloudflare Email Service addresses as campaign senders.
6. Report per campaign: sent, delivered (not bounced), replied, auto-replied, bounced, unsubscribed,
   per step and per mailbox; recipient list with status (queued, sent, replied, paused, bounced,
   unsubscribed, finished).
7. Agent tools in the same change (repository rule): create/update campaign, add recipients, preview,
   launch, pause, resume, stop, get report, list recipients by status, add to and read the suppression
   list; plus the screen.

**Defer**
- A/B variants and spintax (every big tool has them, but they need volume to mean anything at our
  caps), open/click tracking and custom tracking domains, provider matching and inbox rotation
  across many mailboxes, warm-up networks (a shared warm-up pool contradicts "own accounts only"),
  AI reply classification beyond the auto-reply/unsubscribe rules, CRM sync, conditional branches,
  per-recipient time-zone sending, webhooks to third parties (MCP covers agents first).

## 7. Safe defaults, each with its support

| Setting | Default | Support |
|---|---|---|
| Daily cap per mailbox (campaign mail) | **30**, shared by all campaigns of that mailbox, rolling 24 h | Instantly recommends 30 + 10 warm-up per account ([limits](https://help.instantly.ai/en/articles/6248612-account-and-campaign-limits)); lemlist plateau 25 to 30 ([sending limits](https://help.lemlist.com/en/articles/4508367-understand-sending-limits-in-lemlist)) |
| Hard ceiling the person can raise to | **50** per mailbox | Woodpecker default 50 ([boost sending](https://help.woodpecker.co/article/103-settings-boost-sending)); Apollo older default 50 ([limits](https://knowledge.apollo.io/hc/en-us/articles/4409233349005-Configure-Email-Sending-Limits)); lemlist total 50 incl. warm-up |
| Ramp-up for a new or quiet mailbox | start **10/day**, **+2/day** to the cap | lemlist start 10 to 15; Reply.io starts at 10 ([warm up](https://how.reply.io/workflows/warm-up-new-mailboxes/)); Instantly slow ramp +2/day |
| Gap between sends from one mailbox | random **5 to 10 min**, never under 60 s | Reply.io new-account default 300 to 450 s ([how Reply works](https://how.reply.io/)); Instantly 9 to 14 min ([settings](https://help.instantly.ai/en/articles/6222396-campaign-settings)); Apollo minimum 60 s ([checklist](https://21165194.fs1.hubspotusercontent-na1.net/hubfs/21165194/Apollos%20Strong%20Sender%20Reputation%20Checklist.pdf)) |
| Sending window | **Mon to Fri, 09:00 to 17:00** in the campaign's time zone | lemlist example window 9 AM to 5 PM ([algorithm](http://help.lemlist.com/en/articles/4452763-understand-lemlist-s-sending-algorithm)); Instantly "office hours" mode ([settings](https://help.instantly.ai/en/articles/6222396-campaign-settings)) |
| Follow-up delay | **3 days** after the previous step | lemlist 2 to 3 days for cold outreach; Woodpecker first follow-up after 3 days (third party: [leadhaste](https://leadhaste.com/blog/how-to-use-woodpecker-for-cold-email)) |
| New recipients per day | at most **half** the daily cap, rest kept for follow-ups | Reply.io example 100 new of 400 per day ([sequence settings](https://support.reply.io/en/articles/3053016-sequence-settings)); Instantly "max new leads" |
| Stop on reply | **on** | on by default in Apollo, lemlist; Smartlead "always enable" ([setup guide](https://api.smartlead.ai/guides/campaign-setup)) |
| Auto-reply | **pause**, resume after 5 business days or the stated return date | Apollo pauses on out-of-office and resumes at return date ([rulesets](https://knowledge.apollo.io/hc/en-us/articles/4409396858509-Manage-Sequence-Rulesets)); Reply.io status clears after N days ([statuses](https://support.reply.io/en/articles/978110-contact-statuses)); the 5-day figure is our choice, no source |
| Company stop on reply | **on**, exact domain, free-mail domains excluded | Woodpecker ([on reply](https://woodpecker.co/help-center/en/articles/5265608-what-happens-when-a-prospect-replies-to-my-email)); GMass ([company replies](https://www.gmass.co/blog/auto-followup-stop-email-anybody-at-company-replies/)) |
| Bounce auto-pause | pause the campaign at **5%** bounces (minimum 20 sent) | Smartlead example threshold 5% ([article 274](https://helpcenter.smartlead.ai/en/articles/274-what-is-high-bounce-rate-auto-protection-in-smartlead)); Mailshake steps back above 5% ([quotas](https://docs.mailshake.com/article/37-spam-concerns-and-hitting-quotas)); the 20-send floor is our choice |
| Unsubscribe effect | **immediate**, at most 2 days | Yahoo 2 days ([Yahoo](https://senders.yahooinc.com/best-practices/)); CAN-SPAM 10 business days ([FTC](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)) |
| One-click unsubscribe | **on** for every campaign message | Gmail and Yahoo bulk rules ([Gmail](https://support.google.com/a/answer/81126)); RFC 8058 |
| Format and tracking | **plain text, no open or click tracking** | Instantly text-only disables open tracking ([options](https://help.instantly.ai/en/articles/6222396-campaign-options)); GMass "disable all tracking" for deliverability ([GMass](https://www.gmass.co/workflows/disable-all-tracking)) |
| Provider ceilings (never exceeded) | Gmail 500, Workspace 2,000 (trial 500), Exchange 30/min | [Gmail](https://support.google.com/mail/answer/22839), [Workspace](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace), [Exchange](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits) |

**Open decisions for the operator**
1. Cloudflare-domain addresses as campaign senders: excluded in v1 because Email Service is
   transactional only ([CF FAQ](https://developers.cloudflare.com/email-service/reference/faq/)). Reopen only if
   Cloudflare changes the rule or the person routes those addresses through another SMTP account.
2. Whether one-click headers survive Gmail API and Microsoft Graph sending (DKIM coverage) must be
   measured on a real message before the UI claims one-click unsubscribe for those accounts.
