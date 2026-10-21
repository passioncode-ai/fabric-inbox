/**
 * A forwarded message keeps its own HTML (operator, 2026-10-21: a forwarded mail with buttons
 * arrived as text, and nobody could press them). The person writes above it as usual; the original
 * travels below, as it was, inside a marked block, so a draft saved on the server and opened again
 * gets the person's text back as text and the original back as the original.
 */
import { htmlToText, textToHtml } from "./text";

const OPEN = '<div data-fabric-forward="1">';
const CLOSE = "</div><!--/fabric-forward-->";
/** Longest original kept (the send and draft routes take 1,000,000 characters in all). */
export const FORWARD_HTML_MAX = 900_000;

/** The original as the forwarded part: a whole document is reduced to its body, so it nests. */
export function forwardBody(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body\s*>/i.exec(html);
  return (body ? body[1]! : html).slice(0, FORWARD_HTML_MAX);
}

/** The message's HTML: the person's text, then the original in its marked block. */
export function withForward(text: string, original: string): string {
  return `${textToHtml(text)}<br>${OPEN}${forwardBody(original)}${CLOSE}`;
}

/** The message's text part: the person's text, then the original read as text. */
export function withForwardText(text: string, original: string): string {
  const plain = htmlToText(forwardBody(original)).trim();
  return plain ? `${text}\n\n${plain}` : text;
}

/** A saved message split back: the HTML before the forwarded block, and the original, or null without one. */
export function splitForward(html: string): { before: string; original: string | null } {
  const start = html.indexOf(OPEN);
  const end = html.lastIndexOf(CLOSE);
  if (start < 0 || end < start) return { before: html, original: null };
  return { before: html.slice(0, start).replace(/<br>\s*$/i, ""), original: html.slice(start + OPEN.length, end) };
}
