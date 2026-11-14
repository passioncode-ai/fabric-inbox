/**
 * S03 (B-269, B-222) and S04 (B-270): what the arrival safety check recorded about a message, and the one pure
 * function every surface reads it through (`colourOf`): the badge, the link guard and a file's chip. The record is
 * Okolos's shape (`vendor/okolos/core-mail/verdict.ts`): what fired and what could not be looked at, never a score.
 *
 * Plain module, no React and no Worker bindings: the Worker writes the record, the app reads it, tests load it as both.
 */

export type Severity = "critical" | "major" | "minor" | "none";
/** The six checks of a message, Okolos's `CHECKS`. The review is not one of them. */
export const CHECKS = ["senderAuth", "senderIdentity", "replyPath", "links", "hidden", "attachments"] as const;
export type CheckName = (typeof CHECKS)[number];

/** A fact a person can check, beside a signal (a domain, a policy). */
export interface CheckFact { label: string; value: string }
/** `code` is a catalogue key (Okolos's `mail*` keys, or this server's `inbox*` ones), never a sentence. */
export interface CheckSignal { check: CheckName; severity: Severity; code: string; facts?: CheckFact[] }
/** A check that did not run in full, and why (a catalogue key). */
export interface CheckNotRun { check: CheckName; why: string }

export type Colour = "green" | "grey" | "amber" | "red";

/** One attachment and what its bytes show. Every attachment gets one, checked or not (S03 §2). */
export interface FileEntry {
  id: string;
  filename: string;
  size: number;
  checked: boolean;
  /** Why it was not checked: `tooLarge`, `capReached`, `tooShort`, `unreadable`. */
  why?: string;
  /** What the bytes are (`sniff.ts` kinds): pe, elf, macho, script, ole, ooxml, zip, rar, 7z, pdf, image, html, svg, text, unknown. */
  kind?: string;
  /** The facts about it, as codes: `program`, `disguised`, `webPage`, `archive`, `macros`, `macrosNotChecked`, `mixed`, `doubleExtension`. */
  codes: string[];
  colour: Colour;
}

/** A link the server checked, in the form a browser would open (`new URL(decoded).href`). */
export interface CheckedLink {
  url: string;
  host: string;
  /** `phishing`: on the Okolos feed; `lookalike`: imitates `resembles`; `textMismatch`: its text names `shown`. */
  why?: "phishing" | "lookalike" | "textMismatch";
  resembles?: string;
  shown?: string;
}

/** The new review's closed set of reason codes (S03 §3). Every one raises; none lowers. */
export const REVIEW_CODES = ["looks_like_phishing", "asks_for_credentials", "urgent_payment", "impersonates_brand", "instructions_to_ai", "unsure"] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];
/** The codes that raise a message to amber (`unsure` names a doubt, not a finding). */
export const RAISING_CODES: readonly ReviewCode[] = ["looks_like_phishing", "asks_for_credentials", "urgent_payment", "impersonates_brand", "instructions_to_ai"];

export interface CheckReview {
  /** The prompt's version (the lock line `prompt:safety-check-review/1`). */
  version: 1;
  ran: boolean;
  /** Why it did not run: `budget`, `domainCap`, `failed`, `unusable`. */
  why?: string;
  codes: ReviewCode[];
  /** At most two, each a span of the message's normalised text. */
  quotes: string[];
  model?: string;
  /** The hash of what it read (KIMI-43): a recheck keeps the review while the content is the same. */
  contentHash: string;
  at: number;
}

/** `findings.check`: written on arrival and by `POST /api/safety/check`, never changing a message's `state`. */
export interface MailCheck {
  version: 1;
  checkedAt: number;
  /** The Okolos feed version the links were checked against; null with no copy of the feed. */
  feedVersion: number | null;
  /** `received`: all six checks; `links`: mail we sent and drafts, links only (S03 §4). */
  scope: "received" | "links";
  signals: CheckSignal[];
  notRun: CheckNotRun[];
  links: CheckedLink[];
  files: FileEntry[];
  review?: CheckReview;
  /** The hash of the content the checks read. */
  contentHash: string;
}

/** The parts of a stored safety record the colour reads. */
export interface SafetyLikeRecord {
  state: string;
  decidedBy?: string;
  findings: {
    visibleStrong?: string[]; hiddenSignals?: string[]; fileSignals?: string[]; model?: boolean; modelError?: string;
    phishing?: { host: string }[]; lookalikes?: { host: string; resembles?: string }[]; riskyFiles?: string[];
    feed?: "missing" | "stale"; unreadFiles?: string[]; check?: MailCheck;
  };
}

export type BadgeLabel = "checked" | "partly" | "notChecked" | "senderForged" | "suspicious" | "dangerous";
export interface SafetyColour {
  colour: Colour;
  label: BadgeLabel;
  /** A held message let through: the colour still follows its signals. */
  released?: "person" | "review";
  /** The links check ran in full against the server's current feed. */
  linksComplete: boolean;
}

/** Sender signals that are red floors (S03 §4). */
const RED_SENDER = new Set(["mailSenderLookalikeDomain", "mailSenderBrandMismatch", "inboxDmarcFailEnforced"]);
/** Sender signals that alone make "Sender may be forged". */
const SENDER_AMBER = new Set(["mailSenderReplyElsewhere", "inboxDmarcFail", "mailSenderSpfFail", "mailSenderDkimFail", "mailSenderNotAligned"]);

const has = (list: unknown[] | undefined) => !!list && list.length > 0;

/** The registrable link signals that are floors. */
export const linkIsRed = (l: CheckedLink) => l.why === "phishing" || l.why === "lookalike";

/**
 * The colour of a message, from its record and the server's current feed version (S03 §4, one table for S03, S04 and
 * S09). Nothing the review says lowers it: the review's codes only raise green or grey to amber.
 */
export function colourOf(record: SafetyLikeRecord | null | undefined, currentFeedVersion: number | null): SafetyColour {
  if (!record?.findings) return { colour: "grey", label: "notChecked", linksComplete: false };
  const f = record.findings;
  const check = f.check;
  const released = record.state === "released"
    ? (record.decidedBy ?? "").startsWith("person:") ? "person" as const : "review" as const : undefined;
  const withRelease = (c: Omit<SafetyColour, "released">): SafetyColour => released ? { ...c, released } : c;
  const linksComplete = !!check && !check.notRun.some((n) => n.check === "links") && !f.feed
    && check.feedVersion !== null && (currentFeedVersion === null || check.feedVersion >= currentFeedVersion);

  // Red: the floors.
  const red = has(f.phishing) || has(f.lookalikes) || has(f.riskyFiles) || has(f.visibleStrong) || has(f.hiddenSignals) || has(f.fileSignals)
    || !!check?.signals.some((s) => RED_SENDER.has(s.code))
    || !!check?.links.some(linkIsRed)
    || !!check?.files.some((x) => x.colour === "red");
  if (red) return withRelease({ colour: "red", label: "dangerous", linksComplete });

  const raised = !!check?.review?.ran && check.review.codes.some((c) => RAISING_CODES.includes(c));
  const otherAmber = !!f.model || raised
    || !!check?.signals.some((s) => !SENDER_AMBER.has(s.code))
    || !!check?.files.some((x) => x.colour === "amber");
  if (otherAmber) return withRelease({ colour: "amber", label: "suspicious", linksComplete });
  if (check?.signals.some((s) => SENDER_AMBER.has(s.code))) return withRelease({ colour: "amber", label: "senderForged", linksComplete });

  // Grey: unchecked, or not checked in full.
  if (!check) return withRelease({ colour: "grey", label: "notChecked", linksComplete: false });
  if (f.modelError && (record.state === "held" || record.state === "kept")) return withRelease({ colour: "grey", label: "notChecked", linksComplete });
  if (check.notRun.length || !linksComplete || check.scope !== "received") return withRelease({ colour: "grey", label: "partly", linksComplete });
  return withRelease({ colour: "green", label: "checked", linksComplete });
}

/** Whether a message's links lose their address and ask before they open (S04). */
export function guardsLinks(c: SafetyColour): boolean {
  return c.colour === "red" || c.colour === "amber" || !c.linksComplete;
}

/** A link as the reader holds it: the index the frame sends, what it would open and whether the server checked it. */
export interface ReaderLink {
  index: number;
  /** The canonical URL, or null when it does not parse. */
  url: string | null;
  /** The href as written (for the notice when it does not parse). */
  raw: string;
  /** The visible text of the link. */
  text: string;
  /** The server's entry for this canonical URL, when it checked it. */
  checked?: CheckedLink;
  /** The href was written in an odd form (a backslash, no slashes, a tab or a line end inside). */
  odd: boolean;
}

export type LinkVerdict =
  | { action: "open"; url: string }
  | { action: "ask"; url: string; why: "notChecked" | "suspicious" | "textMismatch" | "odd" }
  | { action: "block"; url: string | null; why: "dangerous" | "phishing" | "lookalike" | "unparsable" | "scheme" };

const ALLOWED = new Set(["http:", "https:", "mailto:"]);

/**
 * S04: what activating one link does, decided again at every activation. Red messages, feed-listed and lookalike
 * links never open; only http, https and mailto ever open; an amber message, a link not fully checked, an odd href or
 * a link whose text names another domain asks first.
 */
export function linkDecision(colour: SafetyColour, link: ReaderLink): LinkVerdict {
  if (!link.url) return { action: "block", url: null, why: "unparsable" };
  let scheme = "";
  try { scheme = new URL(link.url).protocol; } catch { return { action: "block", url: null, why: "unparsable" }; }
  if (!ALLOWED.has(scheme)) return { action: "block", url: link.url, why: "scheme" };
  if (link.checked?.why === "phishing") return { action: "block", url: link.url, why: "phishing" };
  if (link.checked?.why === "lookalike") return { action: "block", url: link.url, why: "lookalike" };
  if (colour.colour === "red") return { action: "block", url: link.url, why: "dangerous" };
  if (scheme === "mailto:") return { action: "open", url: link.url };
  if (link.odd) return { action: "ask", url: link.url, why: "odd" };
  if (link.checked?.why === "textMismatch") return { action: "ask", url: link.url, why: "textMismatch" };
  if (colour.colour === "amber") return { action: "ask", url: link.url, why: "suspicious" };
  if (!colour.linksComplete || !link.checked) return { action: "ask", url: link.url, why: "notChecked" };
  return { action: "open", url: link.url };
}

/** Entities a link's href may carry in HTML that a regular expression read sees undecoded. */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/", period: ".", tab: "\t", newline: "\n" };
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * The form a browser opens for an href (S04: "what the browser would open is what was checked"): entities decoded,
 * a protocol-relative one taken as https, then `new URL(...).href`. Null when it does not parse. `odd` marks an href
 * written so that what it shows and what it opens may differ (a backslash, no `//`, a control character inside).
 */
export function canonicalLink(href: string): { url: string | null; odd: boolean } {
  const decoded = decodeEntities(href).trim();
  const odd = /[\t\n\r\\]/.test(decoded) || /^[a-z][a-z0-9+.-]*:(?!\/\/)/i.test(decoded) && !/^mailto:/i.test(decoded)
    || /[\u0000-\u001f\u007f]/.test(decoded);
  const absolute = decoded.startsWith("//") ? "https:" + decoded : decoded;
  try {
    const url = new URL(absolute);
    return { url: url.href, odd };
  } catch {
    return { url: null, odd: true };
  }
}

/** Zero-width and bidirectional controls, removed before a host or a quote is shown (SEC-10). */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿­]/g;
export const visibleText = (text: string) => text.replace(INVISIBLE, "");

/** A host as ASCII (punycode), the way the badge's panel and the link notice show it. */
export function asciiHost(host: string): string {
  const clean = visibleText(host).trim().toLowerCase();
  try { return new URL(`http://${clean}`).hostname; } catch { return clean; }
}

/**
 * S03 §3 (round 5, R5-3; KIMI-42): why a reply agent drafts its answer instead of sending it, whatever its policy: a
 * red sender floor (a lookalike From, a brand named on another domain, DMARC fail under an enforcing policy), or a
 * review code that raised the message. Null when nothing stops a send.
 */
export function draftOnlyReason(record: SafetyLikeRecord | null | undefined): "sender" | "review" | null {
  const check = record?.findings?.check;
  if (!check) return null;
  if (check.signals.some((s) => RED_SENDER.has(s.code))) return "sender";
  if (check.review?.ran && check.review.codes.some((c) => RAISING_CODES.includes(c))) return "review";
  return null;
}
