/**
 * S08 (B-273): select text in a message, press Reply, and the reply quotes exactly that text.
 *
 * Three parts live here so they can be tested without a browser:
 * - `FRAME_SELECTION_SCRIPT`, the script every message frame runs (`EmailIframe`). It posts
 *   `{type: "selection", text, rect}` to the parent on mouseup and keyup, and an empty selection when it
 *   clears. The text is only what the reader sees: text under a hidden, transparent, clipped, zero-size or
 *   off-screen element is left out (SEC-13), zero-width and bidi characters are removed, at most 4,000.
 * - `acceptFrameSelection`, the parent's check of such a message: its own frame only, the right shape,
 *   the length re-checked, and a selection (not a clear) only with user activation (SEC-14).
 * - `heldQuote`, the reader's held selection: a frame's reload, or another message opening, clears it.
 * And `buildQuotedReplyText`, the plain-text quote a reply starts with: "On {date}, {sender} wrote:",
 * then the selection as "> " lines (CB-14, CB-15: the header is the one `buildQuotedReplyBlock` uses).
 *
 * Plain module, no React and no aliases: tests load it as the app does.
 */
import { formatQuotedDate } from "../../shared/dates";
import { englishT, type T } from "../../shared/i18n";

/** The longest selection a quote carries, in UTF-16 code units. */
export const MAX_QUOTE = 4000;

/** Zero-width and bidirectional control characters: they hide or reorder text a person did not see. */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

/** A selection's text made safe to quote: invisible characters out, line ends kept, blank runs closed, at most 4,000. */
export function cleanQuoteText(text: string): string {
	const lines = text
		.replace(INVISIBLE, "")
		.replace(/\r\n?/g, "\n")
		.replace(/ /g, " ")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""));
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_QUOTE).trim();
}

/** "On {date}, {sender} wrote:" in the writer's language, as text (the HTML quote escapes it). */
export function quoteHeader(dateStr: string | undefined, sender: string, t: T = englishT): string {
	return t("On {date}, {sender} wrote:", { date: formatQuotedDate(dateStr, t.locale), sender });
}

/**
 * The start of a reply that quotes a selection: the header, then each line of the selection after "> ".
 * Plain text: the composer writes text, so "</blockquote><img onerror>" stays the characters it is.
 * Empty when nothing is left to quote.
 */
export function buildQuotedReplyText(dateStr: string | undefined, sender: string, selection: string, t: T = englishT): string {
	const text = cleanQuoteText(selection);
	if (!text) return "";
	const quoted = text.split("\n").map((line) => (line ? "> " + line : ">")).join("\n");
	return quoteHeader(dateStr, sender, t) + "\n" + quoted;
}

/** Where a selection ends, in the coordinates of the window that reports it. */
export type QuoteRect = { left: number; top: number; right: number; bottom: number };
export type FrameSelection = { text: string; rect: QuoteRect | null };

/**
 * A-24 (S08): where "Reply with quote" sits in the reader's scroll area, never on the text under the selection: at
 * the right of the selection's last line when there is room, else just above that line (clamped into the pane), and
 * below it only when the line is at the very top of what is shown. `end` is the last line's box in window coordinates;
 * `pane` the scroll area's box, scroll and visible width.
 */
export function quoteButtonPlace(
	end: QuoteRect,
	pane: { left: number; top: number; width: number; scrollLeft: number; scrollTop: number },
	button = { width: 180, height: 30 },
): { left: number; top: number } {
	const gap = 6;
	const x = (v: number) => v - pane.left + pane.scrollLeft;
	const y = (v: number) => v - pane.top + pane.scrollTop;
	const maxLeft = pane.scrollLeft + pane.width - button.width - 8;
	const right = x(end.right) + gap;
	if (right <= maxLeft) return { left: right, top: Math.max(0, y(end.top) + (end.bottom - end.top - button.height) / 2) };
	const left = Math.max(pane.scrollLeft + 8, Math.min(x(end.right) - button.width, maxLeft));
	const above = y(end.top) - button.height - gap;
	return { left, top: above >= pane.scrollTop ? above : y(end.bottom) + gap };
}

/**
 * The parent's reading of a frame's message. `undefined`: not a selection message for us, or refused
 * (another window sent it, a selection without user activation, a text over the limit); `null`: the
 * frame's selection cleared; otherwise the selection, cleaned again.
 */
export function acceptFrameSelection(
	event: { source: unknown; data: unknown },
	frameWindow: unknown,
	activation: { isActive: boolean } | undefined,
): FrameSelection | null | undefined {
	if (!frameWindow || event.source !== frameWindow) return undefined;
	const data = event.data as { type?: unknown; text?: unknown; rect?: unknown } | null;
	if (!data || typeof data !== "object" || data.type !== "selection") return undefined;
	if (typeof data.text !== "string" || data.text.length > MAX_QUOTE) return undefined;
	const text = cleanQuoteText(data.text);
	if (!text) return null;
	if (activation && !activation.isActive) return undefined;
	return { text, rect: readRect(data.rect) };
}

function readRect(value: unknown): QuoteRect | null {
	if (!value || typeof value !== "object") return null;
	const r = value as Record<string, unknown>;
	const keys = ["left", "top", "right", "bottom"] as const;
	if (!keys.every((k) => typeof r[k] === "number" && Number.isFinite(r[k]) && Math.abs(r[k] as number) < 1e6)) return null;
	return { left: r.left as number, top: r.top as number, right: r.right as number, bottom: r.bottom as number };
}

/** A selection the reader holds: whose message, its text, where the "Reply with quote" button sits. */
export type HeldQuote = {
	/** The frame or text body it came from (a message id). */
	key: string;
	/** "frame": a message frame; "page": a text body in the page. */
	source: "frame" | "page";
	text: string;
	/** The button's place in the reader's scroll area, or null when the frame sent no rect. */
	at: { left: number; top: number } | null;
};

export type HeldQuoteAction =
	| { type: "select"; quote: HeldQuote }
	/** A source's selection cleared. */
	| { type: "clear"; key: string; source: HeldQuote["source"] }
	/** A frame's content was replaced (srcdoc set again): what it held is gone. */
	| { type: "reload"; key: string }
	/** Another message opened, the quote was used, or the reader closed. */
	| { type: "reset" };

/** The reader's held selection after an action (a reducer). */
export function heldQuote(state: HeldQuote | null, action: HeldQuoteAction): HeldQuote | null {
	switch (action.type) {
		case "select":
			return action.quote.text ? action.quote : null;
		case "clear":
			return state && state.key === action.key && state.source === action.source ? null : state;
		case "reload":
			return state && state.source === "frame" && state.key === action.key ? null : state;
		case "reset":
			return null;
	}
}

/**
 * The functions the frame's script uses, exported as source so a test can run them against a fake page.
 * `fiVisibleText(selection, window)` returns the selection's visible text, cleaned and capped;
 * `fiSelectionRect(selection)` the rectangle of its end.
 */
export const FRAME_SELECTION_FUNCTIONS = String.raw`
var FI_MAX = 4000;
var FI_INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
var FI_SKIP = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1 };
function fiZeroClip(style) {
	var clip = String(style.clip || "");
	if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(clip)) return true;
	var path = String(style.clipPath || "");
	return /inset\(\s*50%|circle\(\s*0(px|%)?\s*[a)]|polygon\(\s*0(px)?\s+0(px)?\s*\)/.test(path);
}
function fiHiddenElement(el, win, cache) {
	if (cache.has(el)) return cache.get(el);
	var hidden = false;
	var style = win.getComputedStyle ? win.getComputedStyle(el) : null;
	if (style) {
		var overflowHidden = /hidden|clip/.test(String(style.overflow || "") + String(style.overflowX || "") + String(style.overflowY || ""));
		if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") hidden = true;
		else if (style.opacity !== undefined && style.opacity !== "" && parseFloat(style.opacity) === 0) hidden = true;
		else if (style.fontSize !== undefined && style.fontSize !== "" && parseFloat(style.fontSize) === 0) hidden = true;
		else if (fiZeroClip(style)) hidden = true;
		else if (style.display !== "contents" && el.getBoundingClientRect) {
			var r = el.getBoundingClientRect();
			var sx = win.scrollX || 0, sy = win.scrollY || 0;
			if ((r.width <= 1 || r.height <= 1) && overflowHidden) hidden = true;
			else if (r.width === 0 && r.height === 0 && (!el.getClientRects || el.getClientRects().length === 0)) hidden = true;
			else if (r.right + sx <= 0 || r.bottom + sy <= 0) hidden = true;
		}
	}
	if (!hidden && el.parentNode && el.parentNode.nodeType === 1) hidden = fiHiddenElement(el.parentNode, win, cache);
	cache.set(el, hidden);
	return hidden;
}
function fiTextHasArea(node, start, end, win) {
	var doc = win.document;
	if (!doc || !doc.createRange) return true;
	var range = doc.createRange();
	range.setStart(node, start);
	range.setEnd(node, end);
	var rects = range.getClientRects ? range.getClientRects() : [];
	var sx = win.scrollX || 0, sy = win.scrollY || 0;
	var width = Math.max(win.innerWidth || 0, (doc.documentElement && doc.documentElement.scrollWidth) || 0);
	for (var i = 0; i < rects.length; i++) {
		var r = rects[i];
		if (r.width > 0 && r.height > 0 && r.right + sx > 0 && r.bottom + sy > 0 && (!width || r.left + sx < width)) return true;
	}
	return false;
}
function fiBlockOf(el, win) {
	var node = el;
	while (node && node.nodeType === 1) {
		var style = win.getComputedStyle ? win.getComputedStyle(node) : null;
		var display = style ? String(style.display || "") : "";
		if (display && display.indexOf("inline") !== 0 && display !== "contents") return node;
		node = node.parentNode;
	}
	return null;
}
function fiVisibleText(sel, win) {
	if (!sel || !sel.rangeCount) return "";
	var cache = new Map();
	var out = "";
	var lastBlock = null;
	function walk(node, range) {
		if (out.length > FI_MAX * 2) return;
		if (range.intersectsNode && !range.intersectsNode(node)) return;
		if (node.nodeType === 3) {
			var parent = node.parentNode;
			if (!parent || parent.nodeType !== 1 || fiHiddenElement(parent, win, cache)) return;
			var value = String(node.nodeValue || "");
			var start = node === range.startContainer ? range.startOffset : 0;
			var end = node === range.endContainer ? range.endOffset : value.length;
			if (end <= start) return;
			if (!fiTextHasArea(node, start, end, win)) return;
			var block = fiBlockOf(parent, win);
			if (lastBlock && block !== lastBlock && out && out.charAt(out.length - 1) !== "\n") out += "\n";
			lastBlock = block;
			out += value.slice(start, end);
			return;
		}
		if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
		if (node.nodeType === 1) {
			if (FI_SKIP[String(node.tagName).toUpperCase()]) return;
			if (fiHiddenElement(node, win, cache)) return;
			if (String(node.tagName).toUpperCase() === "BR") { out += "\n"; return; }
		}
		var children = node.childNodes || [];
		for (var i = 0; i < children.length; i++) walk(children[i], range);
	}
	for (var r = 0; r < sel.rangeCount; r++) {
		var range = sel.getRangeAt(r);
		if (range.collapsed) continue;
		var root = range.commonAncestorContainer;
		if (out) out += "\n";
		lastBlock = null;
		walk(root, range);
	}
	var lines = out.replace(FI_INVISIBLE, "").replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
	for (var j = 0; j < lines.length; j++) lines[j] = lines[j].replace(/[ \t]+$/, "");
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, FI_MAX).trim();
}
function fiSelectionRect(sel) {
	if (!sel || !sel.rangeCount) return null;
	var range = sel.getRangeAt(sel.rangeCount - 1);
	var rects = range.getClientRects ? range.getClientRects() : [];
	var r = rects.length ? rects[rects.length - 1] : (range.getBoundingClientRect ? range.getBoundingClientRect() : null);
	if (!r) return null;
	return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
}
`;

/**
 * The selection half of every message frame's script. It runs in the frame's opaque-origin sandbox and can
 * only post to its parent. It posts on mouseup and keyup, and once more, empty, when a selection it reported
 * is gone.
 */
export const FRAME_SELECTION_SCRIPT = `(function () {
${FRAME_SELECTION_FUNCTIONS}
	var reported = false;
	function fiReport() {
		var sel = document.getSelection ? document.getSelection() : null;
		var text = sel && !sel.isCollapsed ? fiVisibleText(sel, window) : "";
		if (!text && !reported) return;
		reported = !!text;
		parent.postMessage({ type: "selection", text: text, rect: text ? fiSelectionRect(sel) : null }, "*");
	}
	document.addEventListener("mouseup", fiReport);
	document.addEventListener("keyup", fiReport);
})();`;

/**
 * A text body in the page (the reader's <pre>): the part of the page's selection inside one element marked
 * `data-quote-key`. Both ends must be inside the same element, so the text is that element's alone.
 */
export function pageSelection(
	selection: { isCollapsed: boolean; anchorNode: unknown; focusNode: unknown; toString(): string } | null,
	sourceOf: (node: unknown) => { key: string } | null,
): { key: string; text: string } | null {
	if (!selection || selection.isCollapsed) return null;
	const a = sourceOf(selection.anchorNode), f = sourceOf(selection.focusNode);
	if (!a || !f || a.key !== f.key) return null;
	const text = cleanQuoteText(selection.toString());
	return text ? { key: a.key, text } : null;
}
