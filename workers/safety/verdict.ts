import type { CheckedLink, CheckNotRun, CheckSignal, FileEntry, MailCheck } from "../../shared/mail/safety";
import type { SafetyFindings } from "./check";
import { addresses, replyPath, senderAuth, senderIdentity, type Header, type Outcome } from "./sender";

/**
 * S03 §1 (B-269): `findings.check`, assembled from the checks that ran. A check that is not reported did not run
 * (Okolos's rule: silence is not a pass); a check that ran in part names why in `notRun`.
 */
export interface CheckInput {
  /** `cloudflare`, `gmail`, `outlook`, `imap`. */
  provider: string;
  headers: Header[];
  /** The From and Reply-To values as stored ("Name <a@b>", comma-separated). */
  from: string;
  replyTo?: string | null;
  ownDomains: readonly string[];
  /** The existing arrival findings (hidden text, the light model, documents). */
  findings: SafetyFindings;
  links: CheckedLink[];
  linksCapped: boolean;
  feed: { version: number | null; state: "fresh" | "stale" | "missing" };
  files: FileEntry[];
  scope: "received" | "links";
  contentHash: string;
  now?: number;
}

function fold(check: CheckSignal["check"], outcome: Outcome, signals: CheckSignal[], notRun: CheckNotRun[]) {
  if (outcome.ran) signals.push(...outcome.signals);
  else notRun.push({ check, why: outcome.why });
}

export function buildCheck(input: CheckInput): MailCheck {
  const signals: CheckSignal[] = [];
  const notRun: CheckNotRun[] = [];
  const f = input.findings;

  if (input.scope === "received") {
    const from = addresses(input.from);
    fold("senderAuth", senderAuth(input.headers, input.provider), signals, notRun);
    fold("senderIdentity", senderIdentity(from, input.ownDomains), signals, notRun);
    fold("replyPath", replyPath(from, addresses(input.replyTo)), signals, notRun);
  } else {
    for (const check of ["senderAuth", "senderIdentity", "replyPath", "hidden", "attachments"] as const) notRun.push({ check, why: "inboxNotReceived" });
  }

  // Links: the feed, the lookalike check, and a text naming another domain.
  for (const l of input.links) {
    if (l.why === "phishing") signals.push({ check: "links", severity: "critical", code: "inboxLinkPhishing", facts: [{ label: "mailFactAddress", value: l.host }] });
    else if (l.why === "lookalike") signals.push({ check: "links", severity: "critical", code: "inboxLinkLookalike", facts: [{ label: "mailFactAddress", value: l.host }, { label: "mailFactResembles", value: l.resembles ?? "" }] });
    else if (l.why === "textMismatch") signals.push({ check: "links", severity: "major", code: "inboxLinkTextMismatch", facts: [{ label: "mailFactAddress", value: l.host }, { label: "inboxFactShown", value: l.shown ?? "" }] });
  }
  if (input.feed.state !== "fresh") notRun.push({ check: "links", why: input.feed.state === "missing" ? "inboxFeedMissing" : "inboxFeedStale" });
  if (input.linksCapped) notRun.push({ check: "links", why: "inboxLinkCap" });

  if (input.scope === "received") {
    // Hidden text, the light model and the text of documents.
    if (f.visibleStrong.length) signals.push({ check: "hidden", severity: "critical", code: "inboxAiOrdersVisible" });
    if (f.hiddenSignals.length) signals.push({ check: "hidden", severity: "critical", code: "inboxAiOrdersHidden" });
    if (f.fileSignals?.length) signals.push({ check: "hidden", severity: "critical", code: "inboxAiOrdersFile" });
    if (f.model) signals.push({ check: "hidden", severity: "major", code: "inboxModelFlagged" });
    if (f.modelError) notRun.push({ check: "hidden", why: "inboxScanFailed" });
    if (f.unreadFiles?.length) notRun.push({ check: "hidden", why: "inboxDocumentNotRead" });

    // Files: one entry each.
    for (const x of input.files) {
      if (x.colour === "red") signals.push({ check: "attachments", severity: "critical", code: x.codes.includes("disguised") ? "inboxFileDisguised" : "inboxFileProgram", facts: [{ label: "inboxFactFile", value: x.filename }] });
      else if (x.colour === "amber") signals.push({ check: "attachments", severity: "major", code: "inboxFileRisky", facts: [{ label: "inboxFactFile", value: x.filename }] });
    }
    if (input.files.some((x) => !x.checked || x.colour === "grey") || f.unreadFiles?.length) notRun.push({ check: "attachments", why: "inboxFileNotChecked" });
  }

  return {
    version: 1, checkedAt: input.now ?? Date.now(), feedVersion: input.feed.version, scope: input.scope,
    signals, notRun, links: input.links, files: input.files, contentHash: input.contentHash,
  };
}

/** Whether the new review is owed: a deterministic check fired (any severity) or a document's text was read. */
export const reviewOwed = (check: MailCheck, documentsRead: boolean) => check.signals.length > 0 || documentsRead;

/** The header lines the checks read, in order, capped (S03 §1). */
export const CHECK_HEADERS = new Set(["authentication-results", "received", "from", "reply-to", "list-id", "delivered-to"]);
export function checkHeaders(headers: Header[] | undefined | null): Header[] {
  return (headers ?? []).filter((h) => CHECK_HEADERS.has(String(h.key).toLowerCase()))
    .slice(0, 40).map((h) => ({ key: String(h.key).toLowerCase(), value: String(h.value).slice(0, 2000) }));
}
