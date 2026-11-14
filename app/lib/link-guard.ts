/**
 * S04 (B-270): links in a message ask before they open when the safety check cannot vouch for them. The guard lives
 * in the sanitizer: such a link loses its address and keeps an index (`data-okolos-link`) into a list the reader holds,
 * so a middle click, a modifier click, a drag or the desktop menu has nothing to open. The frame's script reports an
 * activated link only as its index and this render's nonce; the reader resolves the index in its own list (never a
 * URL from the frame) and decides again at every activation (`linkDecision`).
 *
 * Plain module, no React and no aliases: tests load it as the app does.
 */
import { canonicalLink, guardsLinks, visibleText, type CheckedLink, type ReaderLink, type SafetyColour } from "../../shared/mail/safety";

/** What the sanitizer needs to decide each link of one render. */
export interface LinkGuardContext {
  colour: SafetyColour;
  /** The server's checked links, by canonical URL. */
  checked: Map<string, CheckedLink>;
}

/** No record (or one that cannot be read): grey, every link asks. */
export const UNCHECKED: SafetyColour = { colour: "grey", label: "notChecked", linksComplete: false };

export function guardContext(colour: SafetyColour | null | undefined, links: CheckedLink[] | undefined): LinkGuardContext {
  return { colour: colour ?? UNCHECKED, checked: new Map((links ?? []).map((l) => [l.url, l])) };
}

/**
 * One href as the sanitizer meets it: whether it keeps its address, and the reader's record of it. A link keeps its
 * address only when the message's links are vouched for, its canonical URL is one the server checked (and found
 * nothing on), and it is written plainly; `mailto:` keeps it unless the message is red.
 */
export function guardHref(raw: string, text: string, index: number, ctx: LinkGuardContext): { keep: boolean; link: ReaderLink } {
  const { url, odd } = canonicalLink(raw);
  const checked = url ? ctx.checked.get(url) : undefined;
  const link: ReaderLink = { index, url, raw: raw.slice(0, 2000), text: visibleText(text).replace(/\s+/g, " ").trim().slice(0, 200), odd, ...(checked ? { checked } : {}) };
  let scheme = "";
  try { scheme = url ? new URL(url).protocol : ""; } catch { scheme = ""; }
  if (scheme === "mailto:") return { keep: ctx.colour.colour !== "red", link };
  const keep = !guardsLinks(ctx.colour) && !odd && !!checked && !checked.why && (scheme === "http:" || scheme === "https:");
  return { keep, link };
}

/**
 * The script every message frame runs: a click, a middle click or Enter on a guarded link posts
 * `{type: "okolos-link", index, nonce}` to the parent and opens nothing itself.
 */
export function frameLinkScript(nonce: string): string {
	const n = JSON.stringify(nonce);
	return `(function(){var N=${n};
function target(e){var t=e.target;if(t&&t.nodeType!==1)t=t.parentElement;return t&&t.closest?t.closest("[data-okolos-link]"):null;}
function send(a,e){var i=Number(a.getAttribute("data-okolos-link"));if(!(i>=0))return;e.preventDefault();e.stopPropagation();parent.postMessage({type:"okolos-link",index:i,nonce:N},"*");}
document.addEventListener("click",function(e){var a=target(e);if(a)send(a,e);},true);
document.addEventListener("auxclick",function(e){var a=target(e);if(a)send(a,e);},true);
document.addEventListener("keydown",function(e){if(e.key!=="Enter"&&e.key!==" ")return;var a=target(e);if(a)send(a,e);},true);
document.addEventListener("dragstart",function(e){if(target(e))e.preventDefault();},true);
})();`;
}

/**
 * The parent's reading of a frame's link message (KIMI-47): only from this frame's window, with this render's nonce,
 * an index of this render's list, and user activation. Anything else opens nothing (`undefined`).
 */
export function acceptFrameLink(
	event: { source: unknown; data: unknown },
	frameWindow: unknown,
	nonce: string,
	count: number,
	activation: { isActive: boolean } | undefined,
): number | undefined {
	if (!frameWindow || event.source !== frameWindow) return undefined;
	const data = event.data as { type?: unknown; index?: unknown; nonce?: unknown } | null;
	if (!data || typeof data !== "object" || data.type !== "okolos-link") return undefined;
	if (data.nonce !== nonce || typeof data.index !== "number" || !Number.isInteger(data.index) || data.index < 0 || data.index >= count) return undefined;
	if (activation && !activation.isActive) return undefined;
	return data.index;
}

/** A host as the notice shows it: ASCII (punycode), the registrable part apart so it can be emphasised. */
export function hostParts(url: string | null): { sub: string; registrable: string } | null {
	if (!url) return null;
	let host = "";
	try { host = new URL(url).hostname; } catch { return null; }
	host = visibleText(host);
	const labels = host.split(".");
	// Two labels, three under a two-letter country code with a short second label (co.uk, com.au): enough for a notice.
	const keep = labels.length > 2 && labels[labels.length - 1]!.length === 2 && labels[labels.length - 2]!.length <= 3 ? 3 : 2;
	return { sub: labels.slice(0, -keep).join("."), registrable: labels.slice(-keep).join(".") };
}
