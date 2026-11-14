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

const bare = (id: string | undefined) => (id ?? "").trim().replace(/^<|>$/g, "").toLowerCase();

/**
 * For each row of a thread (oldest first), the index of the earlier row it answers: by In-Reply-To, then the last
 * References entry; a draft by the internal id in its In-Reply-To. -1 when it answers nothing (the first message, a
 * message with no reply headers), -2 when it answers a message that is not in this thread.
 */
export function answeredRows(rows: ReplyFacts[]): number[] {
  return rows.map((row, i) => {
    const wanted = bare(row.inReplyTo) || bare(row.references?.trim().split(/\s+/).at(-1));
    if (!wanted) return -1;
    for (let j = i - 1; j >= 0; j--) {
      const other = rows[j]!;
      if (row.draft ? bare(other.internalId) === wanted || bare(other.rfcMessageId) === wanted : bare(other.rfcMessageId) === wanted) return j;
    }
    return -2;
  });
}

/** A reply is set in one level when it does not answer the message right above it (two replies to one message). */
export const isNested = (answered: number, index: number) => answered >= 0 && answered !== index - 1;
