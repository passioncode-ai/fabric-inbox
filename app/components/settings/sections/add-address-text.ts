/**
 * Every word the Add address dialog and its steps show (SCN-021, SCN-061…065), in one place, in the
 * interface's language: `addAddressText(t)` with the translator of `useT()` (the Russian is in
 * shared/i18n/ru/settings.ts). Sentences that carry a value are functions. The registry rows are in
 * docs/brand/strings.md ("Add address (0.12)"). Plain module: tests load it.
 *
 * What the server says (a domain's state, a name's check, a step's detail) arrives in its own words
 * from workers/lib/address-ops.ts and shared/address-name.ts, which are the strings' other home; the
 * dialog shows them through `t.text()`.
 */
import { englishT, type T } from "../../../../shared/i18n";

function build(t: T) {
  return {
    title: t("Add an address"),
    titleAdding: (email: string) => t("Adding {email}", { email }),
    titleAddingSeveral: (domain: string) => t("Adding addresses on {domain}", { domain }),
    /** "No domain receives mail here yet. {link} first." with the link's words in `chooseOnDomains`. */
    noDomain: <N>(link: N) => t.rich("No domain receives mail here yet. {link} first.", { link }),
    chooseOnDomains: t("Choose one on Domains"),
    modeGroup: t("How many"),
    modeOne: t("One address"),
    modeSeveral: t("Several"),

    addressLabel: t("Address"),
    // The part before @ is Latin letters in every language: the example stays as it is.
    addressPlaceholder: "support",
    domainLabel: t("Domain"),
    chooseDomain: t("Choose a domain"),
    domainsList: t("Domains"),
    noDomainMatches: (query: string) => t("No domain matches “{query}”.", { query }),
    domainReading: (domain: string) => t("Reading {domain} in Cloudflare…", { domain }),
    domainSays: (domain: string, label: string) => t("{domain}: {state}.", { domain, state: label.toLowerCase() }),
    catchAllKeeps: (mailbox: string) => t("Its catch-all, {mailbox}, keeps mail for addresses that do not exist.", { mailbox }),
    openToFix: (domain: string) => t("Open {domain} to fix it", { domain }),
    receiveFirst: (domain: string) => t("{domain} does not receive mail here yet. Create first receives its mail here.", { domain }),
    openExisting: (email: string) => t("Open {email}", { email }),
    recentMissing: (domain: string) => t("Mail arrived recently for addresses on {domain} that do not exist:", { domain }),

    namesLabel: t("Names before @"),
    namesPlaceholder: "support\nsales\nhello",
    namesHint: t("One per line, or separated by commas or spaces; up to 50."),
    namesList: t("Each address"),
    nameFree: t("Free"),
    namesCount: (can: number, all: number) => t("{can} of {all} can be created.", { can, all }),

    displayName: t("Display name"),
    displayNamePlaceholder: t("Support"),
    displayNamePlaceholderSeveral: t("Each address's own (Support, Sales…)"),
    displayNameHint: t("The name your mail and an agent's answers are sent with."),
    whoAnswers: t("Who answers"),
    policyDraft: t("Drafts every answer for you"),
    policyAnyAnswer: t("any grounded answer"),
    policyAuto: (intents: string, limit: number) => t("Sends {intents} · up to {limit} a day per address", { intents, limit }),
    answerOff: t("Off — I read it myself"),
    answerOffHint: t("New mail stays for you; an agent can be chosen later."),
    signatureToggle: (who: string) => t("Add a signature to mail sent from {who}", { who }),
    signatureTheseAddresses: t("these addresses"),
    signature: t("Signature"),
    signaturePlaceholder: t("Alex Morgan\nSupport, Acme"),
    signaturePreview: t("Signature preview"),
    preview: t("Preview"),
    previewFrom: (name: string, email: string) => t("From: {name} <{email}>", { name, email }),
    previewGreeting: t("Hello,"),
    previewEmpty: t("Type a signature to see it here."),

    copyLabel: t("Forward a copy to"),
    noCopy: t("No copy"),
    copyNoToken: t("Copies are forwarded by Cloudflare: connect it on Domains to choose one."),
    copyLoading: t("Loading forwarding destinations…"),
    copyFailed: (why: string) => t("Forwarding destinations could not load: {why}", { why: t.text(why) }),
    copyConfirmedOnly: t("The mail itself always stays here; only confirmed destinations are listed."),
    /** "No confirmed forwarding destination … yet. {link}." with the link's words in `addDestination`. */
    copyNone: <N>(link: N) => t.rich("No confirmed forwarding destination in this domain's Cloudflare account yet. {link}.", { link }),
    addDestination: t("Add a forwarding destination"),

    ruleSummary: (state: "made" | "off" | "cannot") =>
      state === "made" ? t("Cloudflare rule: made with the address")
        : state === "off" ? t("Cloudflare rule: not made")
          : t("Cloudflare rule: cannot be made here"),
    ruleToggle: t("Make the Cloudflare rule that sends its mail here"),
    ruleCan: t("A Cloudflare rule that sends the address's mail here is made with it."),
    ruleCannot: t("No rule can be made: this server has no Cloudflare token that sees this domain."),
    /** Follows the rule's line after a space. */
    ruleWithout: t("Without a rule, mail reaches the address only if the domain's catch-all already sends it here."),
    testToggle: t("Send a test message once it is created, and watch it arrive"),

    cancel: t("Cancel"),
    create: (email: string) => t("Create {email}", { email }),
    createOne: t("Create address"),
    createSeveral: (n: number) => (n ? t.plural(n, { one: "Create {n} address", other: "Create {n} addresses" }) : t("Create addresses")),

    // The address field
    nameHint: t("Letters a–z, digits, dots, dashes, underscores or plus; a letter or digit at each end."),
    checking: t("Checking…"),
    checkFailed: t("It could not be checked right now; the server checks it again when you create it."),
    isFree: (email: string) => t("{email} is free.", { email }),

    // The domain states
    stateReceiving: t("Receiving here"),
    stateCanReceive: t("Can receive here"),
    stateNeedsFix: t("Needs fixing"),
    stateNotVisible: t("Token cannot see it"),
    stateUnknown: t("Routing unknown"),
    stateUnavailable: t("Not available"),

    // The steps
    receiving: (domain: string) => t("Receiving {domain}", { domain }),
    creating: t("Creating…"),
    stepsFor: (email: string) => t("What was done for {email}", { email }),
    replaceContinue: t("Replace and continue"),
    createdCount: (created: number, all: number, domain: string) =>
      t.plural(all, { one: "{created} of {n} address created on {domain}.", other: "{created} of {n} addresses created on {domain}." }, { created, domain }),
    createdToast: (created: number, all: number, domain: string) => t("{created} of {all} addresses were created on {domain}.", { created, all, domain }),
    tryAgain: t("Change and try again"),
    addAnother: t("Add another"),
    doneOpen: (email: string) => t("Done — open {email}", { email }),
    close: t("Close"),
    sendTest: t("Send a test message"),
    sendAgain: t("Send again"),
    checkRouting: t("Check routing"),
    working: t("Working…"),
    notCreated: t("It could not be created."),
    /** A failure's own words, then that nothing was made. */
    nothingCreated: (error: string) => t("{error} Nothing was created.", { error: t.text(error) }),
    creatingRest: t("Creating the rest…"),
    // When the server's answer did not arrive, what exists is read again (never "Nothing was created").
    lostExists: (email: string) => t("{email} exists now (read again: the server's answer did not arrive).", { email }),
    lostMissing: (email: string, why: string) =>
      t("{email} does not exist. {why} If it does not appear in the address list in a moment, create it again.", { email, why: t.text(why) }),
    lostUnknown: (why: string) => t("{why} What was created could not be read: the address list shows which addresses exist.", { why: t.text(why) }),
    ruleUnread: t("Its rule could not be read. Fix it checks the rule and makes it if it is missing."),

    mark: {
      done: t("Done"), already: t("Already so"), skipped: t("Skipped"), failed: t("Not done"), not_receiving: t("Not receiving yet"), waiting: t("Waiting"),
      running: t("Working…"), not_asked: t("Not asked"),
    },
    details: t("Details"),
    chip: (step: string, mark: string) => t("{step}: {mark}", { step: t.text(step), mark: mark.toLowerCase() }),
    titleAdded: (email: string) => t("Added {email}", { email }),
    titleAddedSeveral: (domain: string) => t("Added on {domain}", { domain }),
    stepAddress: t("Create the address"),
    stepRule: t("Send its mail here"),
    stepTest: t("Send a test message"),
    stepReceive: (domain: string) => t("Receive mail for {domain} here", { domain }),
    receiveRunning: t("Turning on Email Routing and bringing in its addresses…"),
    receiveMx: (domain: string, mx: string) =>
      t("Another provider handles mail for {domain} today (MX {mx}). Receiving here replaces those records, so mail stops reaching that provider.", { domain, mx }),
    receiveFailed: (label: string, detail: string) =>
      t("{label}: {detail} Nothing was created; creating again continues from there.", { label: t.text(label), detail: t.text(detail) }),
    receiveError: (error: string) => t("{error} Nothing was created.", { error: t.text(error) }),
    receiveDone: (domain: string, now: boolean) => (now ? t("{domain} receives mail here now.", { domain }) : t("{domain} receives mail here.", { domain })),
    testOff: t("Send one now to see mail arrive."),
    testSending: t("Sending it from the address to itself…"),
    testCouldNot: t("It could not be sent."),
    testSent: t("Sent; waiting for it to arrive."),
    testArrived: (time: string, folder: string | null) => (folder
      ? t("Arrived at {time} in {folder}: mail sent to this address reaches it here.", { time, folder: folderWord(t, folder) })
      : t("Arrived at {time}: mail sent to this address reaches it here.", { time })),
    testWaiting: (detail: string) => t("{detail} Checked every 5 seconds.", { detail: t.text(detail) }),

    sentenceNotCreated: (email: string, detail: string) => (detail.trim()
      ? t("{email} was not created. {detail}", { email, detail: t.text(detail.trimEnd()) })
      : t("{email} was not created.", { email })),
    sentencePartly: (email: string, step: string, fix: string | null) => {
      // English runs the step's name into the sentence in lower case; Russian quotes it as it is.
      const name = t.locale === "en" ? step.toLowerCase() : t.text(step);
      return fix
        ? t("{email} was created; {step} did not happen. {fix} fixes it.", { email, step: name, fix: t.text(fix) })
        : t("{email} was created; {step} did not happen.", { email, step: name });
    },
    sentenceNotReceiving: (email: string, fix: string | null) => (fix
      ? t("{email} was created; its mail does not arrive here yet. {fix} fixes it.", { email, fix: t.text(fix) })
      : t("{email} was created; its mail does not arrive here yet.", { email })),
    sentenceWaiting: (email: string) => t("{email} was created. Waiting for the test message…", { email }),
    sentenceReady: (email: string) => t("{email} is ready: the test message arrived.", { email }),
    sentenceCreated: (email: string) => t("{email} was created.", { email }),

    // The entry points (AddressesSection, DomainsSection)
    addOnDomain: (domain: string) => t("Add an address on {domain}", { domain }),
    addFirst: t("Add the first address"),
    addFirstOnDomain: (domain: string) => t("Add the first address on {domain}", { domain }),
    domainEmpty: (domain: string, catchAll: string | null) => (catchAll
      ? t("No address on {domain} yet: mail to it is kept in {catchAll}.", { domain, catchAll })
      : t("No address on {domain} yet: mail to it is refused, and the sender is told.", { domain })),
    listEmptyNoDomains: t("No address yet. An address lives on one of your domains: connect Cloudflare on Domains so they can be chosen."),
    listEmptyOn: (domains: string[]) => (domains.length > 3
      ? t("No address yet on {domains} and {n} more.", { domains: domains.slice(0, 3).join(", "), n: domains.length - 3 })
      : t("No address yet on {domains}.", { domains: domains.join(", ") })),
    listEmptyNoneServed: t("No domain receives mail here yet. Adding an address on one of your domains receives its mail here first."),
    addDisabled: t("Connect Cloudflare, or receive a domain's mail here first (Domains)"),

    // The address's panel (AddressesSection)
    /** "Connect Cloudflare to make and check its rule: {link}." with the link's words in `panelConnectLink`. */
    panelConnect: <N>(link: N) => t.rich("Connect Cloudflare to make and check its rule: {link}.", { link }),
    panelConnectLink: t("Connect Cloudflare"),
    /** The sentence around a link to the domain. */
    panelElsewhere: <N>(domain: N) =>
      t.rich("A rule sending it elsewhere is never overwritten from here: change it in Cloudflare, or use Bring them here on {domain}, which keeps a copy.", { domain }),
    panelFix: t("Fix it"),
    panelFixTitle: t("Makes or switches on the Cloudflare rule that sends its mail here"),
    /** The missing mail is the domain's, not the address's rule: the fix is the domain's Receive mail here (B14-01). */
    panelReceiveTitle: (domain: string) => t("Turns on Email Routing for {domain} and brings its addresses here", { domain }),
    panelReceiveHint: <N>(link: N) => t.rich("If another provider handles its mail today, {link} asks you to confirm first.", { link }),
    panelReceiveConfirm: (domain: string) => t("Receiving {domain} here needs your confirmation on its page.", { domain }),
    panelSendTest: t("Send a test message"),
    panelTestSending: t("Sending a test…"),
    panelTestRefused: (subject: string) => t("The provider refused the test message “{subject}”.", { subject }),
    panelTestSent: (subject: string) => t("Test message “{subject}” sent; its arrival is watched below.", { subject }),
    panelLastTest: t("The last test message"),
    panelTestOf: (when: string) => t("Test of {when}.", { when }),
  } as const;
}

/** A folder the test message landed in, as the sentence names it (English keeps the folder's id). */
function folderWord(t: T, folder: string): string {
  switch (folder) {
    case "spam": return t("[folder] spam");
    case "archive": return t("[folder] archive");
    case "trash": return t("[folder] trash");
    case "sent": return t("[folder] sent");
    case "discarded": return t("[folder] discarded");
    default: return folder;
  }
}

export type AddAddressText = ReturnType<typeof build>;

const built = new Map<T, AddAddressText>();

/** The words in the language of `t` (one table per language, built once). */
export function addAddressText(t: T): AddAddressText {
  let text = built.get(t);
  if (!text) { text = build(t); built.set(t, text); }
  return text;
}

/** English, for tests and code that has no translator. */
export const ADD_ADDRESS_TEXT = addAddressText(englishT);
