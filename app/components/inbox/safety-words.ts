/**
 * S03 (B-269): the words of the Okolos badge and its panel. The record holds codes (Okolos's `mail*` keys and this
 * server's `inbox*` ones); the words are the surface's, written here in English inside `t()` and in Russian in
 * `shared/i18n/ru/inbox.ts`. A code with no line here is shown as nothing, never as its key.
 */
import type { T } from "../../../shared/i18n";
import { asciiHost, visibleText, type BadgeLabel, type CheckName, type CheckSignal, type FileEntry, type MailCheck, type ReviewCode } from "../../../shared/mail/safety";

export function badgeWords(label: BadgeLabel, t: T): string {
  switch (label) {
    case "checked": return t("Checked by Okolos");
    case "partly": return t("Partly checked");
    case "notChecked": return t("Not checked");
    case "senderForged": return t("Sender may be forged");
    case "suspicious": return t("Suspicious message");
    case "dangerous": return t("Dangerous");
  }
}

/** A fact as shown: a domain in ASCII (punycode), any text with zero-width and bidi characters removed (SEC-10). */
const HOSTS = new Set(["mailFactAddress", "mailFactResembles", "mailFactReplyDomain", "mailFactFromDomain", "inboxFactShown"]);
const fact = (s: CheckSignal, label: string) => {
  const value = s.facts?.find((f) => f.label === label)?.value ?? "";
  return HOSTS.has(label) ? asciiHost(value) : visibleText(value);
};

/** One fired signal in plain words. */
export function signalWords(s: CheckSignal, t: T): string {
  switch (s.code) {
    case "inboxDmarcFailEnforced": return t("The sender's domain says it did not send this, and asks to reject such mail (DMARC).");
    case "inboxDmarcFail": return t("The sender's domain did not confirm it sent this (DMARC).");
    case "mailSenderSpfFail": return t("The server that sent it is not one the sender's domain names (SPF).");
    case "mailSenderDkimFail": return t("The message's signature did not match (DKIM).");
    case "mailSenderLookalikeDomain": return t("The sender's address {address} imitates {resembles}.", { address: fact(s, "mailFactAddress"), resembles: fact(s, "mailFactResembles") });
    case "mailSenderBrandMismatch": return t("The sender's name says {name}, but the address is on {address}.", { name: fact(s, "mailFactDisplayName"), address: fact(s, "mailFactAddress") });
    case "mailSenderReplyElsewhere": return t("Replies go to {domain}, not to the sender's domain.", { domain: fact(s, "mailFactReplyDomain") });
    case "inboxLinkPhishing": return t("{host} is on the phishing list.", { host: fact(s, "mailFactAddress") });
    case "inboxLinkLookalike": return t("{host} imitates {resembles}.", { host: fact(s, "mailFactAddress"), resembles: fact(s, "mailFactResembles") });
    case "inboxLinkTextMismatch": return t("A link's text says {shown}, but it goes to {host}.", { shown: fact(s, "inboxFactShown"), host: fact(s, "mailFactAddress") });
    case "inboxAiOrdersVisible": return t("The text gives orders to an AI.");
    case "inboxAiOrdersHidden": return t("Hidden text addresses an AI.");
    case "inboxAiOrdersFile": return t("An attached file gives orders to an AI.");
    case "inboxModelFlagged": return t("A light model found text aimed at an AI.");
    case "inboxFileProgram": return t("{file} runs code.", { file: fact(s, "inboxFactFile") });
    case "inboxFileDisguised": return t("{file} is a program under another file's name.", { file: fact(s, "inboxFactFile") });
    case "inboxFileRisky": return t("{file} needs care before it is opened.", { file: fact(s, "inboxFactFile") });
    default: return "";
  }
}

/** What did not run, and why. */
export function notRunWords(why: string, t: T): string {
  switch (why) {
    case "inboxSkipNotReceiver": return t("Sender authentication: this provider's result cannot be told apart from one the sender wrote.");
    case "mailSkipNoAuthResult": return t("Sender authentication: the receiving server left no result.");
    case "mailSkipNoSender": return t("The sender's address could not be read.");
    case "inboxFeedMissing": return t("Links: this server has no copy of the phishing list.");
    case "inboxFeedStale": return t("Links: the phishing list was not updated for a day.");
    case "inboxLinkCap": return t("Links: only the first 100 were checked.");
    case "inboxScanFailed": return t("Hidden text: the light model could not run.");
    case "inboxDocumentNotRead": return t("Hidden text: a document's text was not read.");
    case "inboxDocumentBudget": return t("Hidden text: documents were not read, as the review's limit for today was reached.");
    case "inboxFileNotChecked": return t("Files: not every file was checked.");
    case "inboxNotReceived": return t("Mail you sent and drafts get the links check only.");
    default: return "";
  }
}

/** One attachment: what its bytes show. A matching type is never called safe. */
export function fileWords(f: FileEntry, t: T): string {
  if (!f.checked) {
    const why = f.why === "tooLarge" ? t("too large") : f.why === "capReached" ? t("more than 10 files") : f.why === "tooShort" ? t("too short to tell")
      : t("could not be read");
    return f.codes.includes("program") ? t("runs code by its name; its bytes were not checked ({why})", { why }) : t("not checked ({why})", { why });
  }
  if (f.codes.includes("disguised")) return t("a program under another file's name");
  if (f.codes.includes("program")) return t("runs code");
  if (f.codes.includes("mixed")) return t("a PDF that also carries a program");
  if (f.codes.includes("macros")) return t("an Office document with macros");
  if (f.codes.includes("macrosNotChecked")) return t("an Office document; its macros were not checked");
  if (f.codes.includes("archive")) return t("an archive; its contents were not checked");
  if (f.codes.includes("webPage")) return t("a web page");
  switch (f.kind) {
    case "pdf": return t("a PDF, as its name says");
    case "ooxml": case "zip": return t("an Office document, no macros");
    case "image": return t("a picture");
    case "text": return t("text");
    default: return t("a file of a type not recognised");
  }
}

/**
 * K-9: whether a check's "nothing found" line is shown: only when the check ran in full; the links line also needs
 * the record checked against the server's current feed, so it never sits beside a line saying the links check did
 * not run.
 */
export function showsOkLine(name: CheckName, check: MailCheck, linksComplete: boolean): boolean {
  if (check.notRun.some((n) => n.check === name)) return false;
  return name !== "links" || linksComplete;
}

/** K-8: an "asked once" download is remembered per account, message and attachment. */
export const downloadAskKey = (accountId: string, messageId: string, attachmentId: string) => JSON.stringify([accountId, messageId, attachmentId]);

/** The question an amber file, or a file the check did not read, asks once before it downloads. */
export function downloadQuestion(f: FileEntry, t: T): string {
  if (f.codes.includes("webPage")) return t("This file is a web page. Download anyway?");
  if (f.codes.includes("archive")) return t("This file is an archive whose contents were not checked. Download anyway?");
  if (f.codes.includes("macros")) return t("This file is an Office document with macros. Download anyway?");
  if (!f.checked) return t("This file was not checked. Download anyway?");
  return t("This file needs care before it is opened. Download anyway?");
}

export function reviewWords(code: ReviewCode, t: T): string {
  switch (code) {
    case "looks_like_phishing": return t("Looks like phishing");
    case "asks_for_credentials": return t("Asks for a password or a code");
    case "urgent_payment": return t("Presses for a quick payment");
    case "impersonates_brand": return t("Presents itself as a company it does not seem to come from");
    case "instructions_to_ai": return t("Gives orders to an AI");
    case "unsure": return t("Something looks wrong");
  }
}

export function reviewNotRunWords(why: string | undefined, t: T): string {
  return why === "budget" ? t("The review did not run: the day's review budget was spent.")
    : why === "domainCap" ? t("The review did not run: this sender's domain reached its daily limit.")
    : why === "unusable" ? t("The review did not run: its answer could not be used.")
    : t("The review did not run: the model could not answer.");
}
