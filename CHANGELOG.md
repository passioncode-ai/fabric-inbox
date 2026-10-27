# Changelog

One section per version, newest first. The server, the Mac app and the skill plugin carry one
version (`tests/versions.test.ts`), and a release's notes are its section here: the disk-image
builder refuses a version without one (`desktop/dist-mac.mjs`, `changelogSection`). How a release
is cut and published: [docs/release.md](docs/release.md).

## 0.67.0 (2026-10-27)

- **A mailbox's category labels and spam checks go with it to another server.** When an agent copies a mailbox, it can
  now also copy which categories each message is in, and its spam and safety checks, so the other server does not ask
  the model about them again. A label is kept only when the other server has the same category with the same wording;
  otherwise that server sorts the mail itself.

## 0.66.0 (2026-10-27)

- **A mailbox's rules, agent and knowledge go with it to another server.** When an agent copies a mailbox to another
  server, it can now also copy the mailbox's rules (an enabled rule stays enabled), the agent that answers it and the
  knowledge that agent reads. Copying again adds nothing new, and a collection already on the other server is left
  alone. The agent starts answering there only when the address's mail moves, which comes next.

## 0.65.0 (2026-10-27)

- **Agents can copy a mailbox to another server.** An agent with administrator access to two servers, such as your own
  and your organization's, can now copy an address's mail, attachments, folders and settings from one to the other and
  check that every message arrived. The original server keeps everything and still receives the mail; moving the
  address itself comes next.

## 0.64.0 (2026-10-27)

- **The app holds your own server and your organizations' servers.** The Account menu lists every server you added,
  with the one shown ticked; choosing another shows it at once, still signed in. Add Another Server… adds one, and
  Forget Server takes one off the list and clears what this Mac kept of it. An organization's server is marked as one.

## 0.63.0 (2026-10-27)

- **A server knows which organization it belongs to.** Setting up a server from the command line now takes the
  organization's context, and the server shows it to the app and to agents. A server stays in the context it was made
  for: an update that names another is refused. Servers set up before this are your own, as before.

## 0.62.0 (2026-10-27)

- **An organization's server can keep its mail in the EU.** Setting up a server from the command line now takes the
  storage jurisdiction Cloudflare offers (EU, FedRAMP or US). The storage is made there, and every later update, from
  a Mac or by the server itself, keeps it there. Existing storage is found wherever it is kept and is never replaced.

## 0.61.0 (2026-10-27)

- **A shared server keeps a record of who changed what.** Settings → People now lists recent changes: who added,
  changed or removed a person and what they gave them, agent keys revoked with a person, and every message a member
  sent (from which mailbox, to whom and its subject, never its text). Agents read the same record with `list_audit`.

## 0.60.0 (2026-10-27)

- **Reply agents' logs count what needs a look.** The server's logs now say, for every reply agent run, how it ended,
  its category, whether the knowledge base had a confident answer and whether a tool's result was withheld by the
  safety check, and for every answer sent which kinds of state it tells the person (an account's state, a refund
  done, a hand-off to the team, a fix). Never the words of the mail or the person's address.

## 0.59.0 (2026-10-27)

- **A new server opens when its address is ready.** A web address or sign-in page Cloudflare made a moment ago can
  take a few minutes to appear on the internet. After Create my server, the app now waits for it (up to three
  minutes) and says so, instead of reporting that it could not reach a server that was fine.
- **Connecting a hub refuses an ambiguous port.** When more than one app listens on the port a hub named, Fabric
  Inbox no longer asks or sends anything, since either app could read the key, and tells you to quit the other one.

## 0.58.0 (2026-10-27)

- **Creating a Cloudflare token takes fewer steps.** Open Cloudflare API Tokens now opens the token form already
  named "Fabric Inbox", with some of the permissions it needs filled in. Check the list in the app and add the
  missing ones.
- **Connecting a hub after your sign-in lapsed no longer asks first.** Fabric Inbox checks your sign-in before it
  asks you to allow the connection. If it has lapsed, it opens the mail window to sign in and tells the hub why.

## 0.57.0 (2026-10-27)

- **Reply agents trust the knowledge base's own verdict.** When the knowledge base marks which of its results can be
  given as an answer, the agent now uses that mark and no threshold of its own: a result marked as an answer counts,
  a weak candidate never does. A release's date is the day it reached the store.

## 0.56.0 (2026-10-27)

- **Gmail mail is not lost when the server was away too long.** If Gmail no longer keeps the changes since the
  server's last look, the server reads the account again. Mail that arrived in your inbox meanwhile, within three
  days, now still reaches its rules, categories and agent, once.
- **Two addresses that forward to each other stop quickly.** A forward rule no longer runs on a message whose
  subject already starts with three forwards, so two rules sending mail back and forth stop there, not at their
  daily limit.

## 0.55.0 (2026-10-27)

- **Not spam on a Gmail, Outlook or IMAP account works like on your own domain.** A message you take out of Spam
  within three days of its arrival now reaches its rules, categories, safety check and reply agent, once. Before, it
  only came back to the inbox. No discard rule takes it on the way, and mail that already reached them is not sent
  to them again.
- **Settings → Domains with no domain yet says what to do.** When Cloudflare is connected but lists no domain, the
  list now says why that can be (a hidden account, a token limited to some domains, or no domain yet). It links
  Cloudflare's own Add a domain page and lets you check again.
- **Updating your server no longer asks for your email.** The server keeps the sign-in it has, so the form skips the
  email it would not use. It asks again only if that server has no sign-in of its own.

## 0.54.0 (2026-10-27)

- **Reply status settings list your accounts with an agent.** In Settings → Addresses, a Gmail, Outlook or IMAP
  account that has a reply agent now has its own line under its domain. You choose there whether the inbox shows
  where its conversations stand, as for an address.

## 0.53.0 (2026-10-27)

- **Reply agents check and grade answers more fairly.** The answer check now reads the facts an answer rests on
  before the long instructions, so a right answer is no longer rejected as made up. The daily quality grade leaves out
  hand-off messages and safe replies, which are fixed texts rather than answers.
- **Questions to the knowledge are the sender's own words.** The question an agent asks the knowledge leaves out the
  quoted history of the conversation, so it asks what the sender wrote now.

## 0.52.0 (2026-10-27)

- **The server tells Fabric which actions an agent can take for you, and who decides each one.** Every action you
  can take in the app is listed with the agent tool that takes it, and marked as yours to approve or as a step
  only you can take, like signing in.

## 0.51.0 (2026-10-27)

- **Your agent can manage people and agent keys, with your approval.** It can add, change or remove a person on a
  shared server, and issue or revoke a key for another agent. Each one waits for your approval in Settings → Agent
  access, whatever that key's own setting, and nothing changes before you approve it.

## 0.50.0 (2026-10-27)

- **Files in your Gmail, Outlook and IMAP mail are checked on arrival too.** As for mail to your own addresses, a
  file that runs code holds the message, and the text of an attached PDF or document is checked for orders to an AI.
  Pictures shown in the message are left alone.

## 0.49.0 (2026-10-27)

- **The spam check sees where replies would go, and what is attached.** A message that asks for replies at another
  address than its sender's, such as a company writing from its own domain while answers go to free mail, is a
  common sign of a scam. So is an invoice that is really a script or a web page. The check now sees both.

## 0.48.1 (2026-10-27)

- **Updating your server waits out a dropped connection.** When Cloudflare drops the connection during the upload,
  the app tries again after 5 seconds and then after 30, and if it still fails, it says what the connection
  reported.
- **A missing permission is named again after a failed step.** A failed step no longer loses which permission the
  token lacks.

## 0.48.0 (2026-10-27)

- **Links to look-alike sites hold a message.** A link to a site that imitates a well-known name, or your own
  domain, holds the message from your agents: a letter swapped for one that looks the same, a typo, or the name put
  in front of another domain. The message says which site it imitates, and its links do not open. A review that
  finds the message safe lets it through.

## 0.47.0 (2026-10-27)

- **People can unsubscribe from a campaign with one click.** Once a campaign starts, your server makes its own
  unsubscribe page, and every message links to it, so mail apps can show their own Unsubscribe button. The page
  asks before it does anything; a mail app's one click unsubscribes at once. Replying "unsubscribe" still works.

## 0.46.1 (2026-10-27)

- **Creating or updating your server tries once more when the connection drops.** Uploading the server to
  Cloudflare now tries again by itself after a network error, instead of stopping and asking you to continue.

## 0.46.0 (2026-10-27)

- **Campaigns in Settings.** See what each of your agent's campaigns did: messages per step, who replied, who asked
  to stop, what bounced, when the next message goes and why a campaign paused itself. Start, resume, pause or stop
  one from there.
- **The stop list.** Add the addresses or whole domains no campaign may write to, with a reason, and remove them.

## 0.45.0 (2026-10-27)

- **Your agent can start the campaign, and the server sends it.** From your own account, one message at a time,
  inside your hours, 5 to 10 minutes apart: 10 on the account's first day, then 5 more each day up to the cap.
  Follow-ups go after their days in the same conversation.
- **It stops for whoever answers.** A reply stops that person and, by default, the rest of their company. A reply
  with "unsubscribe" puts them on the do-not-write list. An automatic reply moves their next message three days on.
- **Every message says how to stop them** and carries the List-Unsubscribe header. A campaign pauses by itself
  when 5% of its messages bounce or the account needs signing in again, and the report says how it went.

## 0.44.0 (2026-10-27)

- **Your agent can prepare an outreach campaign.** It picks the connected Gmail, Outlook or IMAP account to send
  from, writes a first message and up to three follow-ups, and adds the people with their names and companies.
  It is human-paced by default: 30 messages a day, on weekdays from 9 to 5, 5 to 10 minutes apart.
- **Check it before anything leaves.** The preview shows each message as one person gets it and names the
  people a field is missing for. The dry run says when each message would go. Nothing is sent yet: sending
  comes in the next release.
- **A do-not-write list.** An address or a whole domain on it is never written to by any campaign, and the
  people it covers leave every campaign at once.

## 0.43.0 (2026-10-26)

- **Mail that links to a known phishing site is held from your agents.** The server keeps a copy of Okolos's
  signed phishing list and checks every link in arriving mail against it. Such a message is held, the site is
  named, and its links do not open from the message.
- **Attached files are checked too.** A file that runs code, such as a program, a script or an Office file with
  macros, holds the message. The text of an attached PDF or document is checked for orders to an AI, like hidden
  text in the message.

## 0.42.0 (2026-10-26)

The third round of fixes from the bug hunt: notifications and the first steps.

- **New-mail notifications miss nothing and repeat nothing.** Gmail, IMAP and Outlook mail that syncs after
  a newer message is announced, the same email in two inboxes is announced once, and nothing is shown after
  you turn notifications off.
- **A member's All inboxes leaves out the accounts an administrator hid,** as the administrator's does.
- **Creating your server finishes on a slow connection.**
- **Mail to a plus address, like you+orders@, lands in your mailbox.**
- **Replies from the app keep their conversation** in the recipient's mail.
- **A forwarding copy that never settled no longer blocks renaming an address** after a day.
- **Agents can act on accounts on a server with only Outlook set up.**
- **The empty inbox names every way to start:** Gmail, Outlook, other mail, or a domain of your own.
- **Errors when creating an address show in Russian** in the Russian app.

## 0.41.0 (2026-10-26)

The second round of fixes from the bug hunt: agents, rules, first setup and access.

- **Updating a server that opens on your own domain keeps it there.** It no longer moved the app to a
  workers.dev address that nothing protected.
- **After your coding agent sets up the server, the app opens Domains,** where the first mail starts.
  The agent's setup says which Cloudflare setting is missing, rebuilds an outdated server, and names the
  key it replaces so you can revoke it.
- **Outlook setup links open the Outlook setup.**
- **Taking a recent message out of Spam treats it as new mail:** its rules, categories and reply agent take it.
- **A message that is only a link or a picture is checked for spam.**
- **Mail passed to a person shows as waiting for a reply,** not as needing none.
- **A message is not answered twice** when two arrive in one Gmail, IMAP or Outlook conversation.
- **A rule you dismiss while it waits for the safety check stays dismissed,** and a rule gives up at once on
  a message you kept held.
- **A forward rule never forwards a message back to its own address.**
- **An agent that answers an account without drafts cannot be switched to drafting.**
- **Mail of a Gmail, IMAP or Outlook account that could not reach its rules is shown and can be retried.**
- **More than 40 categories with descriptions classify again.**
- **Removing a person, or making them a member, revokes the agent keys they made.**
- **Only the server's own agents mark their mail as automatic.**

## 0.40.0 (2026-10-26)

Fixes from a hunt for bugs across mail, agents, rules, categories, spam, access and setup.

- **A member reaches only their own mailboxes, however the address is written.** An address with
  encoded characters could open a server's settings to a member. It is now judged as the server reads it.
- **Keys limited to some mailboxes see only those.** Such a key no longer reads every mailbox's agent
  events, and a key narrowed to one account can no longer disconnect it or change its reply agent.
- **Members see and decide held mail in their own mailboxes.**
- **Every message waits for the safety check before its reply agent answers,** a known sender's too.
  When the check cannot run, nothing waits for it.
- **A held message you release later is answered.** Before, a message released after 15 minutes was
  never answered, and answering a message again treated tools that act as unsafe.
- **Mail that pretends to come from someone you know is checked.** When the sender's own domain says the
  message is not from it, writing to that sender before, or allowing them, no longer lets it skip the
  spam check.
- **Spam lists take international domains,** and a sender name that shows your domain is caught wherever
  it shows it.
- **Replies in long conversations send from Gmail, IMAP and Outlook.** A conversation of about 14
  messages made the reply fail.
- **Mail Gmail puts in Spam or Trash reaches no rule, agent or category.**
- **On Gmail, IMAP and Outlook, the reply agent recognizes senders with a name** ("Shop
  <no-reply@shop.example>"): no-reply senders, your own addresses and people you hand to a person.
- **Renaming an address no longer leaves its waiting mail stuck,** and its held mail stays held.

## 0.39.1 (2026-10-26)

- **Newsletters built for Outlook are no longer taken for hidden text.** The safety check now skips
  Outlook's layout comments; on 100 of the owner's recent messages they were the one hidden match in a
  newsletter (B-178).

## 0.39.0 (2026-10-26)

- **Mail that tries to steer your agents is held from them.** Every arriving message is now checked for
  orders aimed at an AI, in its visible text and in text hidden from you, by fixed signals from Okolos and
  a light model. A suspect message is reviewed by a second model that has no tools; unless it finds the
  message safe, the message stays held: rules wait, the reply agent leaves it to you, and agents get a
  notice instead of its text and attachments and cannot forward it. You see why and the hidden text on
  the message, and release it or keep it held; an agent can only ask, and the release waits for your
  approval (B-178).

## 0.38.0 (2026-10-26)

- **A coding agent hands the person the exact place for the steps only they can take.** Asked to connect
  a Gmail, Outlook, IMAP or Cloudflare account, to enter a new app password or to save the Gmail or
  Outlook setup, the agent now gets the link to that step and says what the person does there; a
  password, a token or a consent never passes through the agent (B-154).

## 0.37.1 (2026-10-26)

- **A coding agent can tell a message that did not leave from one that may have.** When a send fails,
  the answer now says whether nothing left (fix the cause and send again) or the outcome is unknown
  (check Sent before anything else and never send it again under a new key), so a customer no longer
  risks getting the same reply twice (B-155).

## 0.37.0 (2026-10-26)

- **See where the conversations of a Gmail, IMAP or Outlook account with a reply agent stand.** Like a
  project address's, each conversation now shows whether the agent replied, you replied, the agent is
  waiting for information, left it alone on purpose, or nobody has answered, and Abandoned marks one
  nobody has taken for two days. The Needs a reply and Abandoned filters include these accounts, and
  outside agents hear about an abandoned one from the agent.abandoned event (B-171).

## 0.36.4 (2026-10-26)

- **A coding agent can set up a server with Node 26.** The setup script now talks to Cloudflare over a
  plain connection per request. Before, Node 26 lost the uploads of a deploy and stopped with a network
  error (B-175).

## 0.36.3 (2026-10-26)

- **A second server can run in a Cloudflare account that already has one.** An organization without an
  account of its own can now get its own server beside a person's: the setup script takes its own
  Worker and storage names, and that server routes its addresses and updates itself under its own name,
  never touching the first server or its mail. Each server version now records the commit it was built
  from, so a deploy receipt links what runs to the code (B-169).

## 0.36.2 (2026-10-26)

- **Reply agents answer in about 20 seconds instead of running out of time.** The reply model now writes
  without its long reasoning by default. Replayed on 21 real support messages, it no longer ran out of
  its 90 seconds (11 times before), and half the answers were ready within 22 seconds instead of 99.
  REPLY_REASONING=default brings the old behaviour back (B-174).

## 0.36.1 (2026-10-26)

- **The reply writer's reasoning can be bounded.** A server setting, REPLY_REASONING, sets how hard the
  reply model thinks before it answers, and the preview_agent_answer tool can try another level on one
  message without changing anything. Until now the writer had no limit and sometimes ran out of its
  90 seconds, so the backup model wrote the answer instead (B-174).

## 0.36.0 (2026-10-26)

- **Reply agents answer Gmail, IMAP and Outlook accounts.** Open an account in Settings → Accounts and
  choose who answers it. The server does the work, so the Mac can stay closed. Replies leave from the
  account itself, in the same conversation. An agent that drafts keeps its drafts in the account, and it
  cannot be chosen for an account without drafts. Agents make the same choice with the new
  set_account_agent tool (B-171).

## 0.35.0 (2026-10-26)

- **Sign-in codes, account notices and customers' messages stay out of Spam.** The spam check now says
  what a message is before it decides: a code, a sign-in link, an account, billing or verification notice
  from the service it is about, or a customer writing to your support address, stays in the inbox even
  when you never wrote to the sender. Phishing, scams, cold outreach and bulk marketing still go to Spam.
  The check also sees which domain the receiving server confirmed sent the message, so a code from the
  service's own domain is told apart from a fake notice that only uses its name, and a stranger that signs
  itself with your own domain goes to Spam. Measured on 422 real messages: good mail sent to Spam fell
  from 24.5% to 2.3%, and spam caught rose from 72.6% to 87.9% (B-172).
- **See why a message went to Spam.** The new check_spam agent tool runs the check again on one message
  and shows the rules' verdict, the confirmed domain and what the model decided, without moving anything
  (B-172).
- **Agents can page through the whole inbox.** Past the second page of 100 messages, the next page used
  to be refused; it now loads (B-173).
- **Groundwork for reply agents on Gmail, IMAP and Outlook accounts.** The server can now run a reply
  agent on a connected account; choosing one comes in a later version (B-171).

## 0.34.0 (2026-10-25)

- **The reply status tells mail the agent left alone on purpose from mail nobody took.** A message the
  agent decided needs no answer (an empty message, a newsletter, an auto-reply, mail from one of your own
  addresses, a copy answered from another address) is now marked No reply needed instead of No reply, so
  Needs a reply lists only what waits for someone. A message the safety check held back still waits
  (B-170).
- **Abandoned conversations are marked, filtered and reported.** A conversation still waiting for someone
  two days after its last message came in is marked Abandoned, and the Abandoned filter lists them with
  their number; the agent's "we are looking into it" reply does not count as an answer. Agents learn of
  each one once through the new agent.abandoned event, sent to new event webhooks by default (B-170).

## 0.33.5 (2026-10-24)

- **Stopping the agent console on Windows no longer opens a second Fabric Inbox.** The console's
  terminal now runs on its own console host, and every Windows and Linux build is checked by stopping a
  running session as well as starting one (B-102).
- **Updates on Windows are kept on this computer only.** A downloaded update waits in the local
  application data folder instead of the roaming profile, which a work account may copy to every
  computer, and the old copy is removed. An app folder you cannot write to is now noticed, so the app
  says it cannot update itself there instead of failing later (B-108).
- **Linux desktops such as Sway and i3 can start the app.** On a desktop the browser engine does not
  recognize, the app now asks for the system keyring itself, so a running GNOME Keyring keeps the
  sign-in safe instead of the app refusing to start (B-111).

## 0.33.4 (2026-10-24)

- **Updates are tried for real before a release counts as done.** After each release is published, the
  previous Linux release is started, updates itself to the new one, and must start again as the new
  version (B-105).

## 0.33.3 (2026-10-24)

- **The agent console is checked in every Windows and Linux build.** Before a build is accepted, the
  installed app runs a harmless command in the console's terminal, so a build whose console cannot
  start no longer passes (B-105).

## 0.33.2 (2026-10-24)

- **Stricter launch checks for Windows and Linux.** Each build is now accepted only after its first
  window has drawn, not as soon as it starts up, so a build that starts but cannot show a window no
  longer passes (B-105).

## 0.33.1 (2026-10-24)

- **Judge comparison covers every model.** A model that cannot answer with reasoning switched off is
  asked again with the least reasoning instead of failing, and its results say it reasoned (B-152).

## 0.33.0 (2026-10-24)

- **Compare judge models.** A new agent tool, `judge_bench`, has several models grade the same sent
  answers of one address with the daily quality judge's rubric, beside a stronger reference model, so
  a team can choose its judge on its own mail. It works a slice at a time and reports what it cost;
  its results carry marks, costs and times, never the mail's words (B-152).

## 0.32.5 (2026-10-24)

- **Copy works in the Mac app.** The Copy buttons in Agent access, the Gmail setup and the agent
  panel copy again in the desktop app, and say so when copying fails (B-15).
- **Old account links open the inbox.** An old address of one Gmail, IMAP or Outlook account now opens
  that account in the unified inbox, unless this computer still keeps a draft written there (B-15).
- **Tidier storage.** A draft discarded by the chat assistant, or replaced through the older drafts
  route, takes its files with it, and a body saved halfway is cleaned up (B-15).
- **Easier with the keyboard and a screen reader** in the older mailbox view: the Agent and MCP tabs
  and the Move to folder menu say what they are, and Escape closes the menu (B-15).
- **No mail lands in a deleted address.** A message arriving while its address is being deleted is no
  longer kept in the emptied mailbox; it goes where mail to an unknown address goes (B-29).
- **Fixes found in review.** A key limited to a domain works when a hub narrows it to that domain
  (B-36); turning on Ask me to approve voids codes the agent was given just before (B-38); a rule run
  cut off mid-way no longer keeps the server busy (B-07); applying a setup skips a mailbox it cannot
  save instead of stopping (B-29).

## 0.32.4 (2026-10-24)

- **A message Gmail refused says so.** When Gmail refuses a message you send or save as a draft (the
  Gmail API switched off, a missing permission, too many messages, a sign-in that ended), Fabric Inbox
  now knows it was not sent: the same message can be sent again, and the account still says what to
  fix. Before, it was marked uncertain, as if it might have gone (B-15).

## 0.32.3 (2026-10-24)

- **A rule says plainly when an account refused.** When an account refuses a rule's action before
  doing anything (a sending limit, a message that is gone, a rejected address), the run is marked
  failed with the reason, instead of uncertain. An archive or mark-read of a message removed
  meanwhile no longer reports success (B-15).
- **Mail without a sender joins no conversation by subject.** A message with no From address is
  never put into someone else's thread because its subject matches (B-15).
- **A deleted address stays deleted.** An agent assignment or an applied setup saved at the moment
  an address is deleted no longer brings it back (B-29).

## 0.32.2 (2026-10-23)

- **Retry keeps your unsaved work.** Retry connection (⌘R) now reloads the mail window instead of
  replacing it, and a page with unsaved work asks Leave this page? first. Closing a window with
  unsaved work asks the same question instead of doing nothing. A window that could not reach your
  server is closed rather than kept hidden in the background (B-11).

## 0.32.1 (2026-10-23)

- **Big messages arrive faster and safely.** The files of an incoming message are now saved several
  at a time, and a message is kept with at most 100 of them, so one made of hundreds of tiny parts
  cannot stop its own delivery (B-34).
- **Connected accounts keep their records small.** Gmail, IMAP and Outlook accounts forget, after 90
  days, which old messages they already handed to your rules and agents (B-34).

## 0.32.0 (2026-10-23)

- **Approve what an agent cannot undo.** A key can now ask you first: tick Ask me to approve what it
  cannot undo when you make it, or turn it on later from the key's menu in Settings → Agent access.
  Deleting mail for good, removing an address and similar actions then wait under Waiting for your
  approval, with Approve and Refuse, for up to a day. Nothing changes until you approve, and an agent
  cannot approve for you. Keys without it work as before (B-38).

## 0.31.0 (2026-10-23)

- **Give an agent a whole domain.** In Settings → Agent access, a Read or Mail key can now reach
  every address at a domain, including addresses you make there later, instead of a fixed list of
  mailboxes. It reaches nothing on other domains and nothing your whole workspace shares. Admin keys
  still reach everything: to keep an agent to one domain, give it a Mail key with that domain (B-36).

## 0.30.4 (2026-10-23)

- **A rule's daily limit counts what it does.** The limit now counts the messages a rule acts on,
  once every condition, the AI condition included, matched; before, every message that only passed
  the sender and subject check used one up, so a rule with an AI condition could stop for the day
  without acting once. An AI condition is checked at most 200 times a day per rule (B-05).
- **A sending limit for Gmail, IMAP and Outlook accounts.** Each account sends at most 50 messages an
  hour and 250 a day through your server, whoever sends: you, a rule or an agent. That stays below
  Gmail's and Outlook's own daily caps, so a runaway rule or agent is stopped here before the provider
  suspends the account. A message past it is not sent, stays editable, and can be sent again later (B-06).
- **Rules keep up with a long history.** The server now reads only the runs still waiting when it
  works through a rule's queue, not every run it keeps, and a run nobody approved within 14 days
  shows why it was cancelled (B-07).
- **Mail to unknown addresses is counted exactly.** Deliveries arriving at the same moment all count,
  and a domain keeps at most 500 unknown addresses, the one unseen longest giving way after 30 days,
  so mail sent to random addresses cannot fill your storage (B-10).
- **The incoming mail journal stays small.** Once a day each address forgets the receipts of mail
  its rules, agents and categories took more than 90 days ago (B-34).

## 0.30.3 (2026-10-23)

- **Sign in with your organization's account.** When your server signs people in through Google
  Workspace, Okta, Microsoft Entra or another identity provider, the app now opens that sign-in in its
  own window and keeps you signed in, instead of sending you to the browser, where the sign-in never
  reached the app (B-02).

## 0.30.2 (2026-10-23)

- **Linux: a clear warning without the sandbox.** Where the AppImage has to run without Chromium's
  sandbox (Ubuntu 24.04 by default), the app now says so when it starts and shows how to keep the
  sandbox with the .deb package; you can still continue, and ask not to be told again (B-99).

## 0.30.1 (2026-10-23)

- **Members tidy their own mail.** A member of a shared server can empty Spam and bring back discarded
  mail in their own mailboxes; the discard rules the whole server shares stay with the administrators
  (B-149).

## 0.30.0 (2026-10-23)

- **Share a server with other people.** Settings has a new section, People: add someone by the email
  they sign in with, as an administrator who manages everything or as a member who reads and answers
  only the mailboxes you give them. A member sees just those mailboxes, with no settings, categories,
  rules or other people's mail. Someone who can sign in but is not on the list is told to ask the
  administrator. While nobody is listed, the server works exactly as before (B-149).

## 0.29.4 (2026-10-23)

- **A clear refusal for Fabric without a key.** The server's health, events and usage pages now answer
  a request without an agent key with "not allowed" instead of sending it to the sign-in page, so
  Fabric Dashboards can tell a refusal from a moved page; everything else still asks a person to sign
  in. The server sets this up itself the first time an agent key reads them (B-150).

## 0.29.3 (2026-10-23)

- **The server's Fabric pages refuse other sites.** Its health, events and usage pages answer only
  requests from the server itself or from a host on your computer; a page of another site that tries to
  read them is refused, even while you are signed in.

## 0.29.2 (2026-10-23)

- **An organization can run its own server.** An organization deploys the server into its own
  Cloudflare account and lets in its group of administrators instead of one address
  (`onboard.mjs server --access-group`); setup has a section for it (B-87).
- **Fabric shows how the agents' model calls are paid for.** The server says whether they use an
  OpenRouter key or Cloudflare's own Workers AI, and a server an organization offers to others names
  where they reach it, who controls it and the most sensitive data it may receive (B-87).
- **A clearer health note.** Without an OpenRouter key the agents still answer, on Workers AI, but
  nothing checks an answer before it is sent; the server now says that instead of saying they cannot
  answer.

## 0.29.1 (2026-10-22)

- **An older server can be shown in Fabric Dashboards too.** Its next update, from the app or by
  Create my server, lets agent keys reach it in one header, the way a new server is made; its other
  sign-in settings stay as they are (B-148).

## 0.29.0 (2026-10-22)

- **What the reply agents spent, in dollars.** Every model call an agent makes now keeps its token
  counts and the charge OpenRouter reports, and the server's usage report sums them per day and model,
  so Fabric Dashboards shows the spend instead of an unknown. A call without a reported charge is still
  shown as unknown, never as free (B-147).

## 0.28.1 (2026-10-22)

- **Registering the server in Fabric Dashboards works with Cloudflare.** Cloudflare Access takes a
  key in one header only as `Authorization`, so a new server's sign-in and the registration use that
  header (B-87).

## 0.28.0 (2026-10-22)

- **Your server shows in Fabric Dashboards.** The server answers as a Fabric service: its version and
  build, what does not work, the reply agents' events and the model calls they made, to a person or an
  agent key only. Register it on your computer with `scripts/register-fabric-service.mjs` and a Read
  key; a new server's Access application takes that key in one header (B-87).

## 0.27.1 (2026-10-22)

- **A server deployed by hand also updates itself.** A server without `CLOUDFLARE_ACCOUNT_ID` (one
  deployed with wrangler) now finds its Cloudflare account from its token, as its other Cloudflare
  calls do, instead of saying it cannot update itself (B-44).

## 0.27.0 (2026-10-22)

- **Your server is updated without a new Cloudflare token.** After the app updates itself, it sends
  the server it carries to your server once you are signed in, and the server installs it with the
  token it already holds; your mail and settings are kept. It happens by itself when Install Updates
  Automatically is on, otherwise the app menu offers Update Server. Agents can read the server's
  version with `get_server` (B-44).

## 0.26.0 (2026-10-22)

- **A forwarding destination can be removed, and a waiting one can get its link again.** Settings →
  Forwarding destinations has Send the link again for an address still waiting, and Remove, which
  is offered once no address copies there; the server also refuses it while a Cloudflare rule of the
  account forwards there, and says which. Agents get `remove_forward_destination` and
  `add_forward_destination { resend: true }` (PB-08).
- **A reply agent can leave chosen senders or topics to a person, with no reply at all.** The
  agent's policy takes `silentHandoff` (addresses, @domains, topics); such mail is passed to a person
  before any model call and raises `agent.handoff`.

## 0.25.1 (2026-10-22)

- **Your inbox no longer shows an account as unavailable for a moment after a server update.** When
  the server restarts a mailbox in the middle of reading it, the read is tried once more instead of
  failing.
- **The update log tells an interrupted install from a failed one.** When the app is opened again
  before the update had time to install, the log says so; the update installs at the next quit.

## 0.25.0 (2026-10-22)

- **Notifications of new mail, when you want them.** Turn on Notify About New Mail in the app menu
  and the Mac app tells you about each new message, even with its window closed, and opens it when
  you click. It is off until you turn it on, and it never announces mail that was already there.

## 0.24.0 (2026-10-21)

- **Agent events can reach your helpdesk in seconds.** A webhook gets each hand-off, each message
  that needs a look and each message waiting for a person as it happens, signed so the receiver can
  check it came from your server (`add_event_hook`). It retries for about a day when the receiver is
  down, and never sends an event twice under a new id.
- **Correct price answers are no longer held back.** The check before an answer is sent now accepts
  a sum worked out from your prices (a yearly price per month, a discount applied once) and still
  refuses a wrong one. Measured before and after on price questions: no correct answer refused, no
  wrong one let through.
- **The address list shows a rename in progress** on both addresses, with Finish or cancel the
  rename in the address's menu.
- **Setup says how often you sign in again**: the code Cloudflare emails you is needed once every
  30 days.
- **An older copy of the app no longer drops spam settings** a newer one added.

## 0.23.0 (2026-10-21)

- **A message the agent could not handle is no longer left in silence.** When the model, the safety
  check or reading the agent fails before anything was sent, the agent tries again an hour later
  (then like a message it was not sure of), and after 4 hours one `agent.waiting` event says the
  message still waits. A message the safety check held back gets that event too.
- **When the retries end, the sender hears where to turn.** A message still unanswered 30 days after
  it came gets one fixed reply naming another way to get help: the address's own reply when its policy
  sets one (Settings → Agents, Reply when it stops trying; `closingReply` for agents), else a short
  apology followed by its hand-off reply. A drafting address sends nothing. A second `agent.waiting`
  event says the agent stopped trying.
- **Retries follow the knowledge.** A message held because the knowledge had no answer is not given to
  the model again while the knowledge is at the same revision, and is answered again within seconds
  once a newer revision is seen, instead of at the next 12-hour try.
- **One gap report per message.** A question is reported to the knowledge only when the knowledge had
  no answer, not when a tool was down or the checker rejected the reply, and a retry of the same
  message does not report it again.
- **Hand-off topics read only what the sender wrote now**, not the quoted earlier mail, so a reply that
  quotes a refund conversation is not handed to a person for that.
- **An automation rule whose AI condition fails is tried again** (three attempts, a minute and five
  minutes apart) and the failure is logged, instead of failing silently.

## 0.22.0 (2026-10-21)

- **A conversation reads as one page.** Its messages stand one under another, the oldest at the top
  and the newest at the bottom, each shown whole in its own cell. A reply says whether the agent sent
  it or a person did, and a message that came in says what the agent did with it. Opening the
  conversation lands on the message you opened.
- **See which conversations still need a reply.** Each conversation on your addresses can carry its
  status: No reply, New after the agent, Agent error, Agent lacks data, Agent's draft waits, Agent
  replied, You replied. Needs a reply keeps only the ones waiting for someone, with their numbers.
  Turn it on in Settings → Addresses for every address, a domain or one address; it is off until
  you do. Agents read the same statuses with `list_agent_threads`.
- **A forwarded message keeps its buttons and links.** Forwarding an HTML message sends it as it
  was, below what you write, instead of turning it into text. The composer shows the original that
  goes with it.
- **Right-click a link in a message** in the Mac app to open it in your browser or copy it; a mail
  address offers Write to This Address and Copy Address.

## 0.21.2 (2026-10-21)

- **A rename loses nothing while it runs.** From the moment a rename starts, new mail for the old
  address lands in the new one, and the old mailbox takes no changes until the move ends. It is
  emptied only after every message was found at the new address. Before, a message that arrived
  while a large mailbox was being copied could be lost with the old one, and messages already at
  the new address could be removed by the copy. A rename that has not reached the new address's
  routing can be cancelled (Cancel the rename, or `cancel_rename`), and reopening the dialog shows
  one that was started. An address being renamed cannot be removed, paused or made the catch-all.
- **Agent keys and hidden addresses follow a rename.** A key limited to the old address now works
  on the new one, and a hidden address stays hidden.
- **The daily quality report counts late replies.** A day is reported a day after it ends, so a
  reply sent after midnight to an evening message counts as a reply. A day is never reported twice
  for an address, a draft a person answers later counts as answered by a person, and two failed
  model calls count as two.
- **An update the disk lost twice waits instead of downloading every five minutes**, and Check for
  Updates answers even with automatic updates off.
- **Usage counts on Windows and Linux name their system**, and the usage question waits until a
  hub's connect dialog is answered.
- **The address list says when it could not read which addresses are paused** (`pausedUnknown`),
  instead of showing every address as taking mail.
- **`npm run deploy` refuses a checkout with uncommitted changes**, so a deployed version is always
  the code of the commit it is tagged with.

## 0.21.1 (2026-10-20)

- **An update the system cleared away is downloaded again.** macOS empties its caches when the
  disk runs short, and that is where a downloaded update waits. The app now notices, fetches the
  update again and installs it at the next quit, instead of failing there every time.
- **Rename or move an address keeping its mail.** Settings → Addresses → ⋯ → Rename or move moves
  every message, attachment, draft, folder, setting and who answers to the new address, on the same
  domain or another; the old address keeps delivering to it for 30 days. Agents use `rename_address`.

## 0.21.0 (2026-10-19)

- **Usage counts wait for your answer.** The Mac app sends nothing, not even that it was installed,
  until you answer once: it asks the first time a window comes forward (Continue with the switch on
  or off, or Not now), and the menu's Share Usage Counts answers too.
- **A hub can check narrowing, and a deploy has a receipt.** The server announces what its
  `X-Fabric-Accounts` narrowing does (`fabric-inbox/account-narrowing`, revision 1) when an agent
  connects. Each `npm run deploy` tags the Worker version with its commit, and `npm run
  deploy:receipt` links the version Cloudflare serves to that commit and the build's digest.
- **Pause an address without deleting it.** Settings → Addresses → ⋯ → Pause keeps its mail,
  settings and agent, stops new mail (it goes to the domain's catch-all, or is refused, as the dialog
  says before you pause), and Resume brings it back. Agents use `pause_address` and `resume_address`.
- **A daily quality report per agent address.** After each UTC day the agent events carry one
  `support.quality_daily` per address: how much mail came and got a reply, first-reply times, repeats,
  errors and model calls, what the agent answered and what went to a person, and who still waits.
  What cannot be measured is marked, never shown as 0. The sender, subject and texts of an agent run
  are removed 30 days after it began; its counts stay.
- **An independent judge grades the answers.** Once a day up to 30 answers per address from the day
  before are graded on six checks (language, answers the question, safe, routes to a person only when
  needed, gives a step, no repeats) and whether they helped, by a model of another vendor than the
  ones that wrote and checked them. The counts join the daily quality report; the notes stay on the run.
- **Nobody waits without a word.** A message an agent holds because it is not sure gets one reply a
  day after it came, saying the answer follows in the same conversation (Settings → Agents, or a
  default); the real answer still goes out once the knowledge has it. A message held, or a draft
  nobody sent, still unanswered after 4 hours raises one `agent.waiting` event for the monitor.
- **One address can be brought here on its own.** In Settings → Domains, each address whose
  Cloudflare rule still sends its mail elsewhere has Bring here: it gets its mailbox, keeps sending a
  copy where its mail went before, and only its rule moves. Agents do the same with
  `bring_address_here`.

## 0.20.0 (2026-10-19)

- **A message restored from Trash comes back to its categories.** Described categories keep their
  verdict while it is in Trash, so it returns without being sorted again.
- **Agents work with a Gmail account's own labels.** `list_folders` lists them, `search_mailbox`
  finds the mail under one (`label`), `label_messages` puts labels on a message or takes them off, and
  `read_message` names a message's labels. IMAP and Outlook accounts keep their folders.
- **The inbox reads several Gmail, IMAP and Outlook accounts at once.** Their mail and counts come in
  one request each instead of two per account, so the list opens faster with many accounts.

## 0.19.0 (2026-10-18)

- **Fabric Inbox opens at login.** An installed copy turns Open at Login on at its first launch; the
  menu item (and the system's own settings) turn it off, and an update keeps your choice. If macOS holds
  it for your approval, a notification says where to allow it.
- **Closing the window keeps the app running.** On Windows and Linux a tray icon opens it again; it ends
  only with Quit.
- **Updates arrive sooner.** The app checks every five minutes and says «Restart to finish updating»
  once an update is ready.
- **Anonymous usage counts go to PassionCode's own analytics server.**
- **Move to Trash can be undone.** In the inbox, moving the open message to Trash says so with Undo
  (also ⌘Z / Ctrl+Z).
- **List previews no longer show a message's styling code:** the text of mail that starts with a
  long style sheet now reads as its text.
- **More of the app speaks Russian:** the notifications area and the agent templates (Support, Sales,
  Billing) fill in the interface's language.
- **On a phone:** an open message takes the whole screen, and Settings shows the section you are in.
- **A saved draft that cannot be read is kept.** On an account's page it is set aside on this device
  instead of being deleted by the next save, and the notice says so.
- **Mail a relay could not deliver here is shown to you** in Settings → Domains, like mail arriving
  directly, instead of only in the server's log.
- **A rule is turned on only after its preview.** The server now holds the app's rule: a new or
  changed rule is enabled after a dry-run of that rule (agents too, through `save_rule`); renaming or
  pausing needs none.
- **Reply agents answer mail in other languages more carefully.** A knowledge tool asked before the
  agent answers gets the question in English when the mail is neither English nor Russian, so it no
  longer matches the wrong fact by a shared word.
- **Guards for agents that send on their own.** In auto mode an agent can leave to you replies,
  forwards and follow-ups to its earlier answer, topics you list, and any answer its tools did not
  give confidently; every answer it sends keeps what it rested on.
- **Agents that answer on their own, without drafts.** An agent in auto mode can hand listed requests to a
  person with a fixed reply, label every message with a category, and, instead of a draft, hold an
  answer it is not sure of: the question goes to its knowledge and the message is tried again every 12
  hours for a week, then daily up to 30 days. A reply saying an earlier answer did not help is reported to the knowledge.
- **With an OpenRouter key, answers are written by an open model and checked by another vendor's model**
  before they are sent; without one, the server's own Workers AI writes them as before.
- **A sales lane answers from its own knowledge.** A hand-off category can have its own fixed reply (for
  example premium requests point to the sales contact), and an agent can treat its knowledge as enough
  when its tools have no answer, if the checker approves the reply.
- **Agents read a knowledge tool's results in order:** the first result is the answer, the rest are
  related topics.
- **Replies carry no em dash.** Every reply an agent sends or drafts writes a comma where a dash stood
  between words, the fixed hand-off texts and the signature included.
- **How much of an address's mail its agent saw:** `agent_mail_volume` counts, per agent address and
  day, the messages received, those an agent ran on and those it did not (numbers only).
- **A held message answered again reports its new question** to the knowledge base instead of being
  refused as a repeat.
- **Agents know what they are.** Each agent's instructions now say, truthfully, that it is an AI
  assistant, what it can read and how its answers leave.
- **Preview an agent's answer** to a message you write, without sending anything (`preview_agent_answer`).
- **For agents:** a send whose outcome is unknown keeps its place in the day's allowance;
  `list_agent_activity` pages by `cursor` and never skips entries of the same moment; `list_rules`
  keeps every run still waiting for approval, however old.

## 0.18.0 — 2026-10-14

- **Each row says how long its conversation is.** A message that is part of a longer conversation
  shows the number of its messages; mail in Trash, Spam and Discarded is not counted. Agents get the
  same number from `list_messages` (`threadCount`).
- **Read any message of a conversation in place.** *Show* opens a message's text right in the
  conversation and marks it read. *Mark conversation read* marks every unread message of it at once,
  in a Cloudflare mailbox and in Gmail, IMAP and Outlook accounts; `update_messages` with `thread` now
  does the same for agents.
- **A long Gmail, IMAP or Outlook conversation shows all its messages.** Before, a large account could
  leave older ones out of the conversation.
- **An archived message no longer comes back for a moment.** A list update that arrived just after
  you archived, discarded or read a message could show it as before until the next update.
- **A list preview reads as the message does:** no space appears before punctuation that follows a
  bold word or a link.
- **A redelivered message never sends its forwarding copy twice.** If a copy may have left before the
  delivery was cut off, it is not sent again, and the delivery issues say so.
- **Clearing old Spam and Discarded mail leaves no files behind**, however much has piled up; if
  storage refuses, the messages wait for the next try.
- **A reply agent that was interrupted does not repeat what it did.** When its answer is started
  again, it calls only the tools their server marks as read-only; any other tool is not called a
  second time, and the answer stays a draft.
- **An address whose migrated agent you deleted no longer holds up its copies** of a message that
  another address's agent could answer.
- **Category screening keeps less.** Decisions that a message is not in a category, and spam checks,
  are kept for 30 days; the counts in Settings stay as they were.

## 0.17.0 — 2026-10-14

- **See the whole conversation.** Above the message you open, its conversation is listed oldest
  first — what you received, the replies you sent and your drafts, for every kind of account. Open
  any of them to read it, reply to it or forward it; a reply you send joins the list.
- **See what your agents did, in the mail.** A message an agent answered, drafted or left alone is
  marked in the list, and opening it shows why, from what and with which tools — and what it sent, or
  a button to open its draft.
- **Agents' answers in the sidebar**, one click from the inbox, and an agent's draft is marked as
  such in Drafts.
- **Answer again.** A message a reply agent drafted, left alone or could not answer can be given back to
  it — *Answer again* under *What the agent did*, or the agent tool `answer_again` — and the agent answers
  once more by its policy; a new draft sits beside the earlier one. An answer already sent is never repeated.
- **Questions your agents could not answer, in one list.** Settings → Agents → *Questions without an
  answer* shows each question (paraphrased, without personal details) and whether it reached your
  knowledge base; a failed report is tried once more.
- **Other agents can follow what your reply agents do.** A new agent tool, `list_agent_events`, is a
  feed read by cursor: one event per answer — sent, drafted, left alone, a question without an answer
  (paraphrased) or one that needs a look — with no sender, subject or message text.
- **Every agent event says what the message is about.** A reply agent now records a short topic and a
  one-sentence summary of what the sender wants for every message, with e-mail addresses, links,
  usernames and phone numbers removed, and the agent-events feed carries both.
- **Open a message from a link.** `/?open=<account>|<message>` opens that message in the inbox, with
  what its agent did; every agent event carries such a link, so a dashboard can open the ticket here.
- **A reply agent can send with no daily limit.** Leave *Sends per address per day* empty (over MCP,
  `dailySendLimit: null`); a number still caps it, and a new agent still starts at 20.
- **A reply agent's knowledge lookup reads the message line by line.** The question sent ahead to a
  knowledge tool keeps the message's line breaks and plain `<addresses>`, so a quoted earlier reply is
  recognised and skipped.
- **Moving a message to Trash says so**, and restoring it too; the last action's message no longer
  stays on screen.
- **The agent panel keeps your keys.** After you send a question, typing never moves the mail
  selection, and a suggestion about the open message no longer shows its long id or spills out of
  the panel. A question that got no answer shows Retry again when you reopen the panel.
- **Closing an empty message leaves no empty draft.**
- **An agent's fixed tool arguments are never dropped silently.** Text that is not a JSON object now
  stops the agent from being saved until it is fixed or cleared; before, the tool was saved without
  them, so the agent could ask more than intended.
- **The Drafts count includes drafts on your server.** Drafts an agent wrote or another device saved
  are counted as soon as the inbox opens, not only after the Drafts list was opened once.

## 0.16.3 — 2026-10-13

- **Restart Now asks about a running agent console.** Restarting from the update dialog now asks
  first and revokes the console's key, as the menu already did.
- **Windows in other languages: hub connection links work.** The app found the hub only when Windows
  spoke English.
- **Linux: the AppImage keeps Chromium's sandbox where the system allows it**, and the `.deb` names
  every library it needs (glibc 2.34 or later for the agent console).
- **Windows: every file of the app is signed**, the agent console's helpers included; before, the
  ones inside the app's resources were not.
- **Agents can trust which tools change things.** Every tool that removes or overwrites something now
  says so to agent clients (`destructiveHint`); before, only the tools that ask for confirmation did.
  An unknown account is reported as a sentence, not a bare code.
- **Your server stops sooner after each job.** A finished model or Cloudflare call no longer keeps
  the server busy until its time limit.

## 0.16.2 — 2026-10-12

- **Pictures inside Gmail, IMAP and Outlook mail show.** A logo, a signature or a pasted screenshot
  that a message embeds appeared as a broken image unless the mail came to a Cloudflare address.
  Now it shows in place for every account, and it is no longer offered again as a download. SVG
  pictures stay downloads.
- **Agents see which files are pictures in the body.** `read_message` names each file's
  `contentId` and whether it is inline.

## 0.16.1 — 2026-10-12

- **A draft keeps its files in the mailbox view.** Saving or sending a draft from a mailbox's own
  window kept its attachments only in the main inbox; now they stay and are sent there too, and a
  forward carries the original message's files.
- **An agent never answers from a guess of its knowledge base.** When the knowledge tool you granted
  finds nothing it is confident about, what it returns is shown to the agent as unverified
  candidates, the answer waits for you as a draft, and the question (reworded, with no personal
  data) is reported back to the knowledge base once, so it can be filled.

## 0.16.0 — 2026-10-12

A bug-fix release: a review of the whole product and of the live server found 36 problems; 30 are
fixed here, and the rest are on the board.

- **Your agent console never leaves its key behind.** Quitting, restarting for an update or switching
  servers while the agent console runs now waits for its key to be revoked.
- **Agent replies say they are automatic.** They carry `Auto-Submitted: auto-replied`, so other
  auto-responders do not answer them.
- **A draft is sent once**, even when it is sent from two windows at the same moment.
- **Plain-text mail reads as written**: its lines and the addresses in it are kept.
- **Embedded pictures show in the inbox** (for mail on your Cloudflare addresses) and are no longer
  listed again as attachments.
- **Nothing is skipped after a burst of new mail**, and undoing one failed action no longer undoes
  your other changes.
- **Changing the sender keeps what you typed**, and a double-click on Reply opens one draft.
- **Reply agents are harder to steer**: the safety check reads exactly what the agent reads, all of
  it, and a busy address no longer holds up answers for your other addresses.
- **A tool you grant can be a knowledge base that declares its answers' format**, and each tool's
  credential is only ever sent to its own server.
- Windows: a hub listening on IPv6 is found when it connects. Windows and Linux: opening the app
  again always brings a window back.

## 0.15.2 — 2026-10-11

- **Automatic updates work again.** From 0.12.0 on, the Mac app downloaded each new release but could
  not finish checking it, so it never installed one. 0.15.2 fixes this. A copy older than 0.15.2
  cannot update itself: download 0.15.2 once and install it over the old one; later releases
  install themselves again.
- **A remote tool can be your agent's knowledge base.** A tool you grant an agent now shows it its
  real arguments, can have arguments fixed (for example the knowledge domain), can be asked about
  every message before the agent answers, and can be limited to results marked public, so a reply
  never quotes something private; anything else waits for you as a draft.

## 0.15.1 — 2026-10-11

- **The agent console starts.** In 0.15.0 the console beside your mail could not start your
  coding agent on any platform: the files it runs from were packed where it cannot reach them.
  0.15.1 fixes the build, and a build whose console could not start is no longer released.
- **A stored list is never replaced because it could not be read.** If the server could not read
  its agent keys, spam or discard rules, hidden addresses or relays at the moment you changed one,
  the change could have replaced the whole list with an empty one. Now the change is refused and
  nothing is lost.

## 0.15.0 — 2026-10-11

- **An agent console beside your mail.** Your own coding agent (Claude Code or Codex) runs in a
  panel on the right of the mail window, already connected to this Fabric Inbox: ask it to do
  anything the app does. Open it with the console button in the inbox toolbar, **View → Agent
  Console** or ⌃⌘T (Ctrl+Shift+T on Windows and Linux); open it again to hide the panel while the
  session keeps running. Each session gets its own key, at the level you choose, and the key is
  revoked when the session ends. Quitting the app while a session runs asks first. Not in the Mac App
  Store version.
- **Your coding agent can set Fabric Inbox up for you.** It creates the server in your Cloudflare
  account, then connects itself once you allow it in the app. You paste the token, sign in and
  choose Allow; you copy no address and no secret. The app's welcome offers **Use the server your
  agent set up**. **Settings → Agent access** first shows the sentence to give your agent; making a
  key by hand is the second option. How an agent does it: `docs/agents/onboard.md`.
- **Mail the server could not take is shown.** If a message could be neither accepted nor
  refused, the domain's settings list whom it was for, when and why. Its sender may have had a
  bounce, so you know whom to ask. **Clear** removes the list.

## 0.14.1 — 2026-10-10

- **Windows installers are signed.** The installer, the uninstaller and the app's own programs and
  libraries carry a timestamped Authenticode signature from PassionCode.ai's signing profile
  (signer Siarhei Sheleh), so Windows no longer warns about an unknown publisher. A signed copy
  installs an update only when that update is signed the same way.
- **Each Windows installer is installed and opened on its own architecture before a release is
  published**, ARM64 included.

## 0.14.0 — 2026-10-10

- **Fabric Inbox for Windows and Linux.** The same app, for x64 and ARM64. Windows has an installer
  for your account only, with no administrator rights; it adds `fabric-inbox://` links and removes
  them when you uninstall. Linux has an AppImage and a `.deb` for Debian and Ubuntu, which adds a
  `fabric-inbox` command. Windows and Linux menus are File, Edit, Account, View, Window and Help, and
  a hub's Allow/Deny prompt flashes the taskbar entry.
- **Windows installers are not Authenticode-signed yet.** SmartScreen warns once on first run.
  Verify the installer with the signed `SHA256SUMS`, as the app does for every update.
- **Updates on Windows and Linux.** The Windows app checks, downloads and verifies a new version,
  then installs it when you quit, or at once with **Help → Restart to Install Update**. The AppImage
  replaces itself with the verified new file. A copy installed from the `.deb` does not update
  itself: install the next `.deb`, or use the AppImage.
- **Your sign-in stays encrypted on Linux.** The app keeps it in the Secret Service (GNOME Keyring
  or KWallet). Without one it does not start, rather than store your sign-in as plain text. On a
  desktop other than GNOME or KDE, start it with `--password-store=gnome-libsecret`.
- **Rules and agents reach their tools.** A rule or agent action that calls a tool on another
  server (MCP) never left the server: each call failed before it was sent, and the run said only
  that its outcome was unknown. Calls now reach the tool, a redirect is still refused, and a failed
  action leaves its reason in the server's log.
- **Search finds long phrases.** A search longer than about 48 characters found nothing; it now
  matches, and so does the address test that looks for its own message.
- **A refused send says why.** When the provider refuses a message, the outbox and the address test
  show the provider's reason instead of a code, with addresses and keys masked.
- **Usage counts from a pre-release build are counted as test builds**, apart from releases.

## 0.13.0 — 2026-10-08

- **Forwarding copies work again.** Since 0.8.2 no Cloudflare address had sent its copy to a
  forwarding destination, and mail to an unknown address could fail instead of being refused: the
  step that retries a delivery dropped the message's own forward and refuse actions. Both are kept
  now, and a test sends a message shaped like Cloudflare's own through the whole path.
- **Senders have names.** Cloudflare mail shows "Maya Chen <maya@…>" instead of a bare address; the
  name is kept on arrival, and older mail reads it from its stored header. Search finds Cyrillic in
  any case ("привет" finds "Привет").
- **The reader says more, and only what applies.** Cc is shown; Reply all appears when it reaches
  someone besides the sender and fills To and Cc from everyone on the message; the "external images
  are blocked" line appears only on mail that has remote content.
- **Ask AI from the inbox.** The AI panel opens from the inbox header — a column on wide windows, a
  sheet on narrow ones. A failed answer says so with Retry; the messages an answer read are links
  that open them.
- **Rules you can enable from the app.** Enable waits for a dry-run of the current values; the
  dry-run offers the account's newest mail by sender and subject instead of a message id, and says
  in a sentence what the rule would do. Rule cards show the version and attempts; a run whose result
  is unknown has Check status (agents: `check_rule_run`). Cloud-tool arguments may use
  `{{email.preview}}`, the first 300 characters as plain text.
- **New addresses show up at once.** An address made in the last 7 days is listed in the sidebar
  even with no mail yet (agents: `list_accounts` returns `createdAt`).
- **Connecting a hub brings the app forward.** The Allow/Deny prompt comes to the front with a Dock
  bounce, and closes by itself when the hub stops waiting or after 2 minutes.
- **Smaller fixes.** Unsaved signature edits ask before leaving; an agent's tool is checked when the
  agent is saved; the IMAP form asks before discarding what you typed; the Outlook secret warning
  opens the secret setup; a failed refresh keeps the list with Retry; Esc cancels inbox
  confirmations; downloads name the file and show progress.

## 0.12.0 — 2026-10-07

- **Fabric Inbox in Russian.** The app opens in Russian when the Mac's first language is Russian,
  and **Settings → App → Language** chooses System, English or Русский on this device. Everything a
  person reads is translated — the mail list, the reader and composer, Settings, the setup and
  connect pages, the Mac app's menus and dialogs, and the server's messages where they are shown —
  with real Russian plurals and dates. Agent tools and logs stay English. A check fails the build
  on any English sentence without a Russian entry.
- **Connecting a hub names the app that will get the key.** The `fabric-inbox://connect` dialog
  shows the process listening for the key, not only the name the link gives itself; it refuses
  when nothing listens or another process took the port, and an Admin key needs your own tick.
- **Refresh sits on the left, with how fresh the mail is.** Beside it: "Updated 3 min ago" (the
  server's last successful read of the Gmail, IMAP and Outlook accounts in view), "Live" for
  Cloudflare addresses, "Updating…" while it runs, and the account that failed with its fix. A click
  shows every account's state. ⌘⇧N refreshes (⌘R stays Retry connection).
- **Delete or Backspace archives and marks read; ⌘⌫ (Ctrl+Backspace) discards.** Both work on
  several selected messages, open the next one and offer Undo (also ⌘Z). Arrows and j/k move;
  ? lists the shortcuts. Keys never fire while typing or with a dialog open.
- **Discarded: deleted, but recoverable.** A discarded message goes to its account's Discarded
  folder (a Cloudflare folder, a Gmail label, an IMAP folder, an Outlook folder), out of the inbox,
  counts and categories, and is removed after 30 days. Each discard records why and teaches a rule
  (the mailing list, else the sender), so mail like it goes straight to Discarded on arrival — never
  mail from someone you wrote to, replies in your conversations, your own domains or senders on the
  Always allow list. "Not discarded" brings a message back and can drop the rule. Settings →
  Discard rules lists them. Agents: `discard_messages`, `restore_discarded`, `list_discard_rules`,
  `remove_discard_rule`, `update_discard_allow_list`.
- **Adding an address is one worked-out dialog.** A live check as you type (allowed characters,
  role names, already here, already routed elsewhere in Cloudflare, the catch-all), a domain picker
  with each domain's state, a display name and signature, who answers, a forwarding copy, then the
  steps in place: receive the domain if needed, create the address, make the Cloudflare rule (or say
  why not with its fix), and a test message watched until it arrives. "Add several" creates many at
  once. A rule Cloudflare refuses no longer costs the address: it shows "Not receiving yet" with
  Fix it. Agents: `check_address`, `create_addresses`, `check_test_message`; `create_address`
  takes a signature.
- **Usage counts no longer wait for the Keychain.** They are sent with Node's `fetch` in the main
  process instead of Chromium's network stack, which waits for the cookie key; a pending Keychain
  prompt held every count back on the owner's Mac (0.11.0).
- **A development run is "Fabric Inbox Development"** to macOS, with its own Keychain item for its
  cookie key, so it can never leave the installed app an item it has to ask for.
- **Automatic updates behave as in every PassionCode.ai product (LC-16).** The first check runs
  90 s after start, then every 6 h while the app runs, window or not; a failed check is retried
  once within the hour. The switch is the file `auto-update` in the profile (absent = on, `off` =
  off); the 0.10.1–0.11.0 `updates.json` choice is carried over.
- **An update is verified by the app before anything can replace it.** The release's
  `SHA256SUMS` must carry the organization's pinned GPG signature and list the feed itself; the
  zip must have the signed digest and size; the app inside must be signed by a Developer ID of team
  `KJ35UYYL22` and carry the announced version. Only then is Squirrel.Mac handed the verified zip.
  Before, Squirrel.Mac checked only the signing team, and the docs wrongly said it checked the
  digest.
- **An update is never a downgrade or a reinstall**: only a strictly newer release is offered, and
  the release build sets `ElectronSquirrelPreventDowngrades`.
- **A release can be held for a step a person takes** (`migration` in its feed): it is downloaded
  and verified, not installed, and Check for Updates… names its runbook.
- **The app keeps a log**, `~/Library/Logs/Fabric Inbox/fabric-inbox.log` (codes only, about 2 MB
  at most), with the shared update events.
- **An update never loops or waits forever.** A version macOS refuses, or that Squirrel.Mac does not
  take within 15 minutes, is not downloaded again for a day; a held release is downloaded once; a
  copy this Mac account cannot replace says so and downloads nothing. Turning automatic updates off
  stops a check that is running from handing anything over (an update already downloaded still
  installs at quit). A failed Restart to Install Update can be chosen again.
- **The release refuses a bad update before publishing it.** A new `update-precheck` job runs the
  app's own checks on the built feed and zip, and `publish` waits for it; the signed set is checked
  again after publishing.
- **Creating a server never puts a prerelease over its release**, and `npm run deploy` records the
  server's version as the app's own deploy does.
- **A `DevToolsActivePort` left by a debugging run is removed** from the profile at the next start.
- **Corrected:** the first published release that updates itself is 0.11.0; 0.10.1 was never
  published.

## 0.11.0 — 2026-10-06

- **Settings is one screen, and nothing jumps.** Addresses, Domains, Accounts, Forwarding
  destinations, Agents, Knowledge, Categories, Spam rules, Agent access and App live under
  **Settings** (⌘, in the Mac app), each as a searchable list with the chosen item's panel beside
  it. Choosing a row no longer scrolls the page or folds another domain (the old screen navigated
  and reset the scroll to the top); results show where you acted; destructive actions sit in one
  menu with one confirmation; a narrow window shows the panel with Back. Old addresses redirect.
- **Mail refresh works.** Gmail brings new mail during a first import, imports recent inbox mail
  first, syncs as soon as an account connects, and no longer drops out of the inbox when its cache
  passes about 10,000 messages (a date index and stored counts replace full scans; the cache is
  migrated in place). **Refresh** reads Gmail now and says per account what happened; the inbox
  keeps updating after Load older, refreshes when the window comes back or the Mac wakes, applies
  archive, delete and read at once, and offers a reload after a server update. One bad message no
  longer stops an account, a manual sync no longer delays the others, and only a revoked grant
  asks for a reconnect.
- **Agents can do everything the interface does.** New tools send, edit and delete drafts
  (`send_draft`, `list_drafts`, `read_draft`, `delete_draft`), send files, Cc, Bcc and a subject on
  replies and forwards, keep the signature and quote in HTML, read raw headers, list agent keys
  (without secrets) and providers, and refresh mail. Saving a rule or a project changes only what
  is given. A test now fails when a route accepts a field its tool does not.
- **Drafts live on the server.** The main window saves drafts to the account's server drafts
  (Cloudflare and Gmail), so an agent's draft appears in Drafts for a person to review and send,
  and a person's draft is safe if the Mac is lost; conflicting edits ask which version to keep.
  Drafts that were only on this Mac are moved to the server on first start.
- **Gmail setup in the app.** A seven-step guide with links and copy buttons; the server checks
  the Google client, creates its own credential key and saves its settings itself. Connecting ends
  on a page that says what happened, and an account that stops working says why (for example the
  7-day expiry of a Google app left in Testing) with the one action that fixes it.
- **Outlook and Microsoft 365.** Connect through Microsoft Graph (OAuth with PKCE) after the owner
  registers an app in Microsoft Entra, guided in Settings → Accounts → Outlook with every value to
  copy; the server keeps the client secret and warns 30 days before it expires. Mail is read with
  delta queries per folder (Inbox first), sent with files, Cc and Bcc, and drafts are editable; an
  organization that needs its administrator gets the approval link to forward.
- **More mail accounts: iCloud Mail, Yahoo, AOL, Fastmail, Zoho, Yandex, Mail.ru, GMX, Gmail with
  an app password, or any IMAP server.** Added in Settings → Accounts with an app password, checked
  before it is stored, kept encrypted on your server, and read and sent by the server, so they work
  with the Mac closed. Credentials use a versioned envelope with a rotatable key
  (`MAIL_CREDENTIAL_KEY`); a server that has none makes its own from Settings (**Make the key**).
- **The local dev server runs again with IMAP support** (`npm run dev`): imapflow's unused default
  logger no longer stops the Worker in workerd.
- **Usage counts carry `iid` and `environment`.** Every event repeats the shared installation id as
  `props.iid` and says `props.environment`: `production` for a release build, `sandbox` for a debug
  key or a pre-release version, the two values a growth agent counts (operator decision 2026-10-05).
- **The Mac App Store package is readable by every user.** App Store Connect refused the first
  store upload (0.10.1, ITMS-90255: files only root can read): the embedded provisioning profile
  kept the 0600 of its private temporary file. The bundle is made readable after signing, and the
  build now stops before Apple does if any file or folder is not.

## 0.10.1 — 2026-10-05

The Mac app now keeps itself up to date, and removing or reinstalling it loses nothing.

- **Automatic updates, on by default.** A released copy in Applications checks the latest GitHub
  release at launch (and when you come back to it, at most every six hours), downloads the new
  signed version in the background and installs it when you quit, or at once with **Fabric Inbox →
  Restart to Install Update**. Squirrel.Mac checks the download's sha256 and size and that it is
  signed by the same team. **Install Updates Automatically** turns it off; **Check for Updates…**
  checks at once and says what happened. Each release now also publishes `Fabric-Inbox-<version>-mac.zip`
  and `update-mac.json`. Builds from source and the Mac App Store copy never check. 0.10.0 and
  earlier have no updater: update them once by hand.
- **The server's address survives an uninstaller.** It is also kept in
  `~/Library/Application Support/PassionCode/backups/fabric-inbox.json` and read back when the app's
  own folder is gone, so a reinstall opens your server instead of the welcome screen. Your
  accounts, addresses, agents, keys and mail were always on your server; what lives where is in
  [docs/desktop-data-and-updates.md](docs/desktop-data-and-updates.md).
- **A start with no server known keeps every sign-in.** The profile sweep no longer removes server
  partitions (sign-in and unsent drafts) when no server address is saved: that partition may be
  the server you are about to enter again.
- **Usage counts show updates** (`app_updated`, with the version it came from).

## 0.10.0 — 2026-10-05

Agents that work with mail get the right recipients and the exact bytes; a message is answered
once; the Mac app is hardened and counts its use anonymously. Every fix has a test that fails
without it.

- **A reply goes where the sender asked.** `reply` answers the Reply-To address on both providers,
  and `read_message` shows it. A Gmail reply-all keeps everyone on Cc and leaves your own address
  out (Gmail messages cached before 0.10 are read again from Gmail once to learn their Cc).
- **Attachments reach an agent byte for byte.** `get_attachment` and `forward` no longer re-encode
  text and JSON attachments (an invalid `.json` came back as `"null"`).
- **Moving archived Gmail mail to the inbox puts it in the inbox** (a new route adds the Inbox
  label; before, the tool reported success and the message stayed archived).
- **Gmail search applies each field on its own** — from, to (Cc included), subject, dates, unread,
  starred, attachments, folder — and refuses a filter it cannot apply instead of ignoring it.
- **Agents are told the truth about failures.** A batch where nothing was done is an error and is
  journalled as failed; a failed send keeps the outbox id and status so `get_send_status` can follow
  it; `update_messages` refuses to mark a whole conversation unread instead of marking it read; a
  conversation listed by `threadId` spans every folder, your replies included; a mailbox-limited
  key is no longer promised spam reporting it does not have.
- **One answer per message (B-22).** A message sent to several agent addresses of one workspace
  (To and Cc, or two in To) is answered once, from the first agent address in To; the other copies
  are recorded as skipped with the address that answered. The claim is atomic in the workspace's
  agent registry and expires after seven days.
- **Anonymous usage counts** (#27, [docs/ANALYTICS.md](docs/ANALYTICS.md)). The released disk image
  counts installs, days of use and how many Gmail accounts, Cloudflare mailboxes, agents and agent
  keys your server has, with the installation id every PassionCode app on the Mac shares — never an
  address, a name, a domain or anything from your mail. **Fabric Inbox → Share Anonymous Usage
  Counts** turns it off for every PassionCode app at once. Builds from source and the Mac App
  Store package send nothing.
- **A mistyped server address costs nothing.** Changing the server clears the old server's
  storage only after the new one answers; before, a wrong address deleted the old server's unsent
  drafts and sign-in, and switching back within one run broke its storage.
- **Local release folders keep what matters.** A development store build never removes the
  uploaded distribution package; a removed store folder leaves its receipt; a failed removal no
  longer fails a finished build.
- **The Mac app is hardened** (lifecycle contract LC-13, LC-07, PR #12). Session cookies are
  encrypted at rest under a login-Keychain key, "Fabric Inbox Safe Storage"; the app cannot be run
  as a plain Node process or opened with an inspector; it loads only from its own integrity-checked
  archive; and it no longer carries Electron's camera, microphone and Bluetooth purpose strings.
  Every build reads the fuses and purpose strings back from the built app and fails otherwise.
  Profiles written by 0.9.0 and earlier keep working; going back to such a version means signing in
  again.
- **Old servers leave nothing behind** (LC-12). Changing the server clears the previous server's
  cookies, storage and cache, so returning to it means signing in again; each launch removes what
  servers no longer configured left in the profile.
- **Automation polls less** (LC-08): every 30 s instead of 5 s, and only while the window is
  visible and focused; returning to the window refreshes at once.
- **A development run uses its own profile** (`Fabric Inbox Development`), never the installed
  app's (LC-14). A local build keeps only the current and the previous release in `release/`, and
  `npm run clean` removes build caches (LC-15).

## 0.9.0 — 2026-10-03

- **Agent keys can be limited to mailboxes** (AP-11). A Read or Mail key may name its accounts and
  then reaches those mailboxes only: it sees only tools that stay inside a mailbox, every route it
  calls is checked against its accounts, the feed is narrowed in the request and in the answer, and
  a category filter is refused. Agent access gains a Mailboxes choice and shows each key's scope.
- **A hub narrows its key per call with `X-Fabric-Accounts`**: the call reaches only the named
  mailboxes; the header intersects with the key's own limit and never widens it.
- **A hub on this Mac connects by your consent, with nothing copied.** A `fabric-inbox://connect`
  link opens a native Allow/Deny prompt; Allow makes the key with your own signed-in session and
  hands it once to the hub's loopback address, and revokes it if the hub did not take it (SCN-047).
- **Releases are signed in GitHub Actions only.** A `vX.Y.Z` tag starts `.github/workflows/release.yml`;
  after a member of `release-approvers` approves (whoever pushed the tag may; an agent never
  does), it builds the disk image
  with the organization's CI Developer ID, notarizes and staples the app and then the image made
  from it, attests every file, signs `SHA256SUMS` and publishes the release. A rehearsal on a
  `-rc` tag does all of that and publishes nothing. A build signed on a laptop is a debug build.
- **The Mac App Store package is built by the same workflow**, signed with the CI-only store
  identities and the Fabric Inbox profile, and uploaded to App Store Connect when the release
  publishes. The upload stops with a clear message while the App Store Connect app record does not
  exist; creating it is a person's step ([docs/release.md](docs/release.md#mac-app-store)).
- `desktop/dist-mac.mjs` gains `--stage app|image|finish` for the workflow;
  `scripts/app-store-connect.mjs` derives the store build number from the tag, checks the app
  record and uploads. The release no longer carries a separate `.sha256`: the signed `SHA256SUMS`
  covers the image.

## 0.8.2 — 2026-10-01

A second pass: the live server's own error log, the 0.8.1 changes read again, and the core mail
paths. Every fix has a test that fails without it.

- **Mail is not lost to a Durable Object reset.** A message that arrived a minute after a deploy
  failed with "storage operation exceeded timeout" and was never delivered again (seen in the live
  log, 2026-09-28). A delivery now retries once after such a reset; it is still stored only once.
- **A forgery is spam even from a sender you allowed.** Mail that fails its domain's DMARC (reject or
  quarantine), or claims one of your domains without passing its checks, no longer passes because
  the domain is on Never spam. Never spam still wins over everything else. When the spam check
  itself cannot run, the message is screened by the model instead of being treated as clean.
- **A long attachment name no longer makes a message impossible to receive** (names are cut to 200
  bytes, keeping the extension).
- **A long message reads whole in its conversation**, as it already did on its own.
- **The same email is not shown twice** when its copy in another inbox falls on the next page.
- **Gmail mail with only an HTML part** is sorted into categories by its text, not its subject alone.
- **"You have written to this sender"** now means the whole address (it matched a part of another).
- **Replying to mail with no Message-ID** no longer puts an internal id into the reply's headers.
- **Relays:** the sign-in a relay was moved off is revoked an hour later without waiting for another
  connect; an upgrade cut off half-way is tried again; the hourly limit on upgrades is per account;
  the relay status shows the current relay; a refusal while another sign-in change runs answers 409.

## 0.8.1 — 2026-10-01

A review of 0.8.0's several-accounts work, every finding fixed with a test
([brief](docs/app-store/tasks/2026-09-30-cloudflare-accounts.md#review-2026-10-01)).

- **No guessing which account is the server's.** When it cannot be told (no `CLOUDFLARE_ACCOUNT_ID`
  and a token that sees several accounts), the screen says so and nothing is connected or released;
  before, every domain looked like another account's and **Stop receiving here** could drop mail.
- **Only active domains count.** A pending copy of a domain in another account can no longer take
  its mail, its relay deliveries or where it sends from.
- **An account whose token stopped working** stays listed with the reason; **Remove…** works, and
  **Connect another account** with a new token replaces the old one.
- **Relays:** installed and removed one at a time (with agent keys, which share the sign-in policy);
  a relay's own settings say which sign-in it runs with, so a lost or unconfirmed step is put right
  by running it again; a reinstall keeps the old sign-in working while it drains; a failure never
  removes a relay that works; relays upgrade themselves to the server's version; a refused sign-in
  no longer follows Access's login redirect.
- **Sending from another account:** works with one token that reaches several accounts; a domain
  that moved is sent from where it is now; an inline image without a Content-ID goes as an
  attachment; mail suppressed for every recipient is a failure, not "sent".
- **Clearer refusals:** an error names which token it is about, and Email Sending's own refusals are
  no longer reported as a missing permission.
- Smaller: connecting several accounts at once reports each one; `list_domains` keeps a domain's own
  account when it also lists destinations; empty and error states on the accounts list; focus after
  Remove.

## 0.8.0 — 2026-09-30

- **Several Cloudflare accounts.** Domains & addresses lists every Cloudflare account the server has
  a token for, with whether it has mail, how many domains and how many receive here. The server's
  account and every account with mail are shown; **Show**, **Hide** and **Default** change that.
  **Connect another account** takes a token made in that account (the window lists the permissions it
  needs); the server keeps it as its own secret and never shows it again. **Remove…** takes
  it away again.
- **Receive mail for a domain in another account.** Cloudflare sends a domain's mail only to a
  Worker in the same account, so **Receive mail here** on such a domain first installs a small relay
  there (`fabric-inbox-relay`), which hands every message to your server unchanged. Copies,
  unknown addresses and duplicates behave as for any other domain. Replies from those addresses are
  sent through that account's Email Sending.
- **Fix: Receive mail here on a domain whose Email Routing was off.** Cloudflare refused it with
  "Invalid Input: must be a subdomains of …"; the request no longer names the domain.
- **Agent protocol:** `list_cloudflare_accounts`, `show_cloudflare_account` and
  `remove_cloudflare_account` (two steps). `list_domains` and `add_forward_destination` take an
  `account`. Connecting a token stays in the app: a token is a secret and never passes through an
  agent.
- **New licence.** Fabric Inbox's own code is now open source under the GNU AGPL-3.0, with a
  commercial licence available from PassionCode.ai (`AGPL-3.0-only OR
  LicenseRef-PassionCode-Commercial`; Fabric ADR-0092). Versions up to and including 0.7.1 stay
  under Apache-2.0. The code imported from Cloudflare's Agentic Inbox template keeps its
  Apache-2.0 licence and notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
  [LICENSES/](LICENSES/). Contributions are accepted under [CLA.md](CLA.md). No behaviour changed.

## 0.7.1 — 2026-09-30

The first release published on GitHub, with a signed, notarized disk image and its checksum.

- **One version across the release.** The `v0.7.0` tag names `c37dee0`, whose Mac app still
  carried 0.6.2; the fix (`d84ee43`) came after the tag, and release tags are never moved. 0.7.1 is
  the first version whose tag, Mac app, server and skill agree.
- **Release builds prove what they claim.** With `--notary-profile` the build fails unless Apple
  accepted both the app and the disk image, both are stapled, and Gatekeeper names the source
  `Notarized Developer ID` for each (`spctl -a -vv`). The receipt records the notarization
  submission, and `Fabric-Inbox-<version>.dmg.sha256` beside the image is what
  `shasum -a 256 -c` reads. A build that stops without writing its receipt exits 1.
- **Install and connect from the release.** The README says how an organisation member downloads
  the image from this private repository (`gh release download`), and what the MCP address is when
  the installed app runs: the server's own `/mcp`, since the app itself serves nothing locally.
- **The installed app's agent protocol is checked from the installed copy.**
  `scripts/check-installed-app.mjs` runs the server an installed app carries, locally behind an
  Access stand-in, and calls `initialize`, `tools/list` and `list_accounts` on its `/mcp`.
- The server, the app's behaviour and the agent protocol are unchanged since 0.7.0.

## 0.7.0 — 2026-09-29

The agent protocol: every function of the app over MCP at `/mcp`, agent keys as Cloudflare Access
service tokens (read / mail / admin), two steps for irreversible actions, a journal, the Agent
access screen, and the skill `working-with-fabric-inbox`
([brief](docs/app-store/tasks/2026-09-29-agent-protocol.md)). Built and installed on the owner's
Mac from `d84ee43`; not published as a GitHub release.

## 0.6.3 — 2026-09-29

Numbered schema steps for the agent registry, knowledge and categories objects (B-32).

## 0.6.2 — 2026-09-29

A stranger's message waits for its spam check before its agent answers (B-30).

## 0.6.1 — 2026-09-29

The sidebar filter (With mail / All, hidden addresses); the reliability and update audits; the
spam retention clock counts from the move into Spam
([brief](docs/app-store/tasks/2026-09-29-reliability-and-updates.md)).

## 0.6.0 — 2026-09-29

A spam filter and one path to create and remove a mailbox
([brief](docs/app-store/tasks/2026-09-29-spam-and-mailboxes.md)).

## 0.5.0 — 2026-09-29

Categories ([brief](docs/app-store/tasks/2026-09-29-categories.md)).

## 0.4.0 — 2026-09-29

Knowledge collections an agent searches, only the ones granted to it
([brief](docs/app-store/tasks/2026-09-29-knowledge.md)).

## 0.3.0 — 2026-09-28

Domains & addresses, the Mac app creating the server in your own Cloudflare account, and no
owner data in the public build ([plan](docs/app-store/tasks/2026-09-28-cloudflare-complete.md)).
