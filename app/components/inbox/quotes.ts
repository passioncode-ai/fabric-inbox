import { bareMessageId, replyTarget } from "../../../shared/mail/reply-target";

/**
 * S05 (B-221): the quoted history a reply carries below its own lines, folded so a thread reads as one conversation,
 * and which earlier message each reply answers. What is not recognised as a quote stays shown: nothing is cut from a
 * message that has no quote.
 */

/** The selectors of a quoted history in HTML mail: Apple Mail and Thunderbird, Gmail, Outlook (web and desktop). */
export const QUOTE_SELECTORS = [
  'blockquote[type="cite"]',
  "div.gmail_quote",
  "div#divRplyFwdMsg",
  "div#OLK_SRC_BODY_SECTION",
  "div.moz-cite-prefix",
] as const;

/** A line that introduces a quote: "On <date>, <name> wrote:" in English, «<date>, <name> пишет:» in Russian. */
const ATTRIBUTION = /^\s*(On\s.{4,200}\swrote:|.{4,200},?\s(пишет|написал|написала)\s?:)\s*$/i;

export interface TextSplit {
  /** The message's own lines. */
  main: string;
  /** The quoted history, from its attribution line on; null when none was found. */
  quote: string | null;
}

/**
 * A text body split into its own lines and the quoted history below them: the lines from an attribution line, or a
 * trailing block of lines that start with ">" (blank lines inside it count). A message that is only a quote keeps it
 * shown: folding everything would show nothing.
 */
export function splitQuotedText(text: string): TextSplit {
  const lines = text.split(/\r?\n/);
  let at = lines.findIndex((line, i) => ATTRIBUTION.test(line) && lines.slice(i + 1).some((l) => l.trim().startsWith(">") || l.trim() !== ""));
  if (at < 0) {
    let start = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!.trim();
      if (l.startsWith(">")) start = i;
      else if (l !== "") break;
    }
    if (start < lines.length && lines.slice(start).some((l) => l.trim().startsWith(">"))) at = start;
  }
  if (at < 0) return { main: text, quote: null };
  const main = lines.slice(0, at).join("\n").replace(/\s+$/, "");
  if (!main.trim()) return { main: text, quote: null };
  return { main, quote: lines.slice(at).join("\n") };
}

/** The labels a folded quote shows, in the reader's language. */
export interface QuoteLabels {
  show: string;
  hide: string;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const FOLD_STYLE = "details.fi-quote{margin:12px 0}details.fi-quote>summary{cursor:pointer;color:#6b6575;font-size:12px;list-style:none}"
  + "details.fi-quote>summary::-webkit-details-marker{display:none}details.fi-quote[open] .fi-quote-show,details.fi-quote:not([open]) .fi-quote-hide{display:none}";

const summaryHtml = (labels: QuoteLabels) =>
  `<summary><span class="fi-quote-show">${escapeHtml(labels.show)}</span><span class="fi-quote-hide">${escapeHtml(labels.hide)}</span></summary>`;

/**
 * An HTML body with its quoted history folded into `<details>`, opening in place without a script (the message frame
 * runs none of the sender's). The first quote element is folded only when the message has text of its own before it;
 * its attribution line (Gmail's `gmail_attr` sits inside the quote, Apple Mail's just before it) goes with it. Without a
 * DOM parser (a test, the server) the body is returned unchanged.
 */
export function foldQuotedHtml(html: string, labels: QuoteLabels): string {
  if (!html || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const quote = doc.body.querySelector(QUOTE_SELECTORS.join(","));
  if (!quote || quote.closest("details.fi-quote")) return html;
  const own = textBefore(doc.body, quote);
  if (!own.trim()) return html;
  const details = doc.createElement("details");
  details.className = "fi-quote";
  details.innerHTML = summaryHtml(labels);
  // An attribution line just before the quote ("On … wrote:") folds with it.
  const before = quote.previousElementSibling;
  const parent = quote.parentNode!;
  parent.insertBefore(details, quote);
  if (before && ATTRIBUTION.test(before.textContent ?? "")) details.insertBefore(before, details.querySelector("summary")!.nextSibling);
  details.appendChild(quote);
  const style = doc.createElement("style");
  style.textContent = FOLD_STYLE;
  doc.body.insertBefore(style, doc.body.firstChild);
  return doc.body.innerHTML;
}

/** The text of the body that comes before `node` in document order. */
function textBefore(root: HTMLElement, node: Element): string {
  const range = root.ownerDocument.createRange();
  range.setStart(root, 0);
  range.setEndBefore(node);
  return range.toString();
}

/** One message of a thread, as far as replies are concerned. */
export interface ReplyFacts {
  /** The message's own Message-ID, angle brackets kept or not. */
  rfcMessageId?: string;
  /** The internal id of the row (an agent's draft names the message it answers by this). */
  internalId: string;
  inReplyTo?: string;
  references?: string;
  /** A draft names what it answers by internal id, every other row by Message-ID. */
  draft?: boolean;
}

/**
 * For each row of a thread (oldest first), the index of the earlier row it answers, by the one reply rule the server
 * uses too (`replyTarget`: In-Reply-To, else the last References entry that names an earlier row); a draft names what
 * it answers by the internal id in its In-Reply-To. -1 when it answers nothing (the first message, a message with no
 * reply headers), -2 when it answers a message that is not in this thread.
 */
export function answeredRows(rows: ReplyFacts[]): number[] {
  return rows.map((row, i) => {
    const earlier = new Map<string, number>();
    for (let j = 0; j < i; j++) {
      const other = rows[j]!;
      const rfc = bareMessageId(other.rfcMessageId);
      if (rfc) earlier.set(rfc, j);
      if (row.draft) { const internal = bareMessageId(other.internalId); if (internal) earlier.set(internal, j); }
    }
    const { target, named } = replyTarget({ inReplyTo: row.inReplyTo, references: row.references }, (id) => earlier.has(id));
    if (target !== null) return earlier.get(target)!;
    return named ? -2 : -1;
  });
}

/** A reply is set in one level when it does not answer the message right above it (two replies to one message). */
export const isNested = (answered: number, index: number) => answered >= 0 && answered !== index - 1;

/** A rule's run on a message of the thread, as `GET /api/automation/:account/runs` lists it. */
export interface RunLike {
  emailId: string;
  status: string;
  updatedAt: string;
  rule: { name?: string; action?: { type?: string; to?: string; tool?: string } };
}
/** The safety check's record of a message of the thread, as `POST /api/safety/lookup` answers it. */
export interface SafetyLike {
  state: string;
  decidedBy?: string;
  decidedAt?: number;
  checkedAt?: number;
}
export type EventCode = "rule_waiting" | "rule_failed" | "rule_forwarded" | "rule_archived" | "rule_marked_read" | "rule_drafted"
  | "rule_called_tool" | "safety_held" | "safety_kept" | "safety_released_by_review" | "safety_released";
/** A thin row between the cells: something a rule or the safety check did to a message of the thread. */
export interface ThreadEvent {
  at: number;
  messageId: string;
  kind: "rule" | "safety";
  /** What happened; the reader words it (`ConversationList`'s `eventText`). */
  code: EventCode;
  values: Record<string, string>;
}

/**
 * S05 (B-221): the rule and safety events of a thread's messages, oldest first, read from the routes the app already has
 * (the rule history and the safety lookup), so agents read the same facts through `list_rules` and `list_held_messages`.
 * A run that is still deciding (pending, running) and a clear safety record are not events.
 */
export function threadEvents(messageIds: readonly string[], runs: readonly RunLike[], safety: Readonly<Record<string, SafetyLike>>): ThreadEvent[] {
  const ids = new Set(messageIds);
  const out: ThreadEvent[] = [];
  for (const run of runs) {
    if (!ids.has(run.emailId)) continue;
    const name = run.rule?.name || "";
    const at = Date.parse(run.updatedAt) || 0;
    const a = run.rule?.action ?? {};
    const push = (code: EventCode, values: Record<string, string> = {}) => out.push({ at, messageId: run.emailId, kind: "rule", code, values: { name, ...values } });
    if (run.status === "waiting_approval") push("rule_waiting");
    else if (run.status === "failed") push("rule_failed");
    else if (run.status === "succeeded") {
      if (a.type === "forward") push("rule_forwarded", { to: a.to ?? "" });
      else if (a.type === "archive") push("rule_archived");
      else if (a.type === "mark_read") push("rule_marked_read");
      else if (a.type === "draft") push("rule_drafted");
      else if (a.type === "mcp") push("rule_called_tool", { tool: a.tool ?? "" });
    }
  }
  for (const id of messageIds) {
    const s = safety[id];
    if (!s || s.state === "clear") continue;
    const at = s.decidedAt || s.checkedAt || 0;
    const code: EventCode = s.state === "held" ? "safety_held" : s.state === "kept" ? "safety_kept"
      : s.decidedBy === "review" ? "safety_released_by_review" : "safety_released";
    out.push({ at, messageId: id, kind: "safety", code, values: {} });
  }
  return out.sort((x, y) => x.at - y.at);
}
