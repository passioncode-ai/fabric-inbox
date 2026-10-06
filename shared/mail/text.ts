/** Plain-text helpers for mail bodies, shared by the agent protocol, the server and the app. No imports. */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** HTML to readable text: block ends become line breaks, links keep their address. */
export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const inner = label.replace(/<[^>]+>/g, "").trim();
      return inner && inner !== href ? `${inner} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e: string) => {
      const key = e.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(Number(key.slice(1)));
      return m;
    })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Text as HTML with its line breaks, the way the app's compose sends it. */
export function textToHtml(text: string): string {
  return text ? `<div style="white-space:pre-wrap">${escape(text).replace(/\n/g, "<br>")}</div>` : "";
}

/** Cuts a body to `max` characters and says so. */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

/** The block a forward carries: who wrote it, when, to whom, and what. */
export function forwardedBlock(original: { from: string; to: string; date: string; subject: string; text: string }): string {
  return [
    "---------- Forwarded message ----------",
    `From: ${original.from}`,
    `Date: ${original.date}`,
    `Subject: ${original.subject}`,
    `To: ${original.to}`,
    "",
    original.text,
  ].join("\n");
}

/** A plain-text quote of the message being answered. */
export function quotedBlock(original: { from: string; date: string; text: string }): string {
  return `On ${original.date}, ${original.from} wrote:\n${original.text.split("\n").map((l) => `> ${l}`).join("\n")}`;
}

/** The address's signature as an HTML block, set apart from the text above it. */
export function signatureHtml(signature: string): string {
  return `<div class="fabric-signature" style="white-space:pre-wrap;margin-top:16px">${escape(signature.trim()).replace(/\n/g, "<br>")}</div>`;
}

/** The quote of the message being answered, as HTML: its header line, then its text in a blockquote. */
export function quotedHtml(original: { from: string; date: string; text: string }): string {
  return `<div class="fabric-quote" style="margin-top:16px"><div>On ${escape(original.date)}, ${escape(original.from)} wrote:</div>`
    + `<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex;white-space:pre-wrap">${escape(original.text).replace(/\n/g, "<br>")}</blockquote></div>`;
}

/** The forwarded message, as HTML. */
export function forwardedHtml(original: { from: string; to: string; date: string; subject: string; text: string }): string {
  return `<div class="fabric-forward" style="margin-top:16px;white-space:pre-wrap">${escape(forwardedBlock(original)).replace(/\n/g, "<br>")}</div>`;
}

/**
 * Blocks added after a message's own HTML (its signature, the quoted original): inside its `<body>`
 * when it has one, so a full HTML document stays one document; after it otherwise.
 */
export function appendHtml(html: string, ...blocks: string[]): string {
  const extra = blocks.filter(Boolean).join("");
  if (!extra) return html;
  const close = html.search(/<\/body\s*>/i);
  return close >= 0 ? html.slice(0, close) + extra + html.slice(close) : html + extra;
}
