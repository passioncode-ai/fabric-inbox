// S08 (B-273): select text in a message, press Reply, and the reply quotes exactly that text.
// The quote is text (CB-14), built with the header the HTML quote uses (CB-15); the frame's script sends
// only what a reader sees (SEC-13); the reader takes it only from its own frame, with user activation, and
// a reload or another message drops it (SEC-14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	acceptFrameSelection,
	buildQuotedReplyText,
	cleanQuoteText,
	FRAME_SELECTION_FUNCTIONS,
	FRAME_SELECTION_SCRIPT,
	heldQuote,
	MAX_QUOTE,
	pageSelection,
	quoteButtonPlace,
	type HeldQuote,
} from "../app/lib/quote-selection";
import { createT } from "../shared/i18n";

// ---- the quote builder ----------------------------------------------------------------------------

test("the quote starts with the header, then each selected line after '> '", () => {
	const text = buildQuotedReplyText("2026-11-14T10:00:00Z", "Ann <ann@example.com>", "First line\n\nSecond line");
	const [header, ...lines] = text.split("\n");
	assert.match(header!, /^On .+2026.+, Ann <ann@example\.com> wrote:$/);
	assert.deepEqual(lines, ["> First line", ">", "> Second line"]);
});

test("the header follows the writer's language", () => {
	const text = buildQuotedReplyText("2026-11-14T10:00:00Z", "Ann", "Hi", createT("ru"));
	assert.match(text.split("\n")[0]!, /, Ann пишет:$/);
});

test("the selection is trimmed: no blank lines around it, no trailing spaces, at most one empty line in a row", () => {
	assert.equal(cleanQuoteText("\n\n  Hello  \n\n\n\nworld\t \n\n"), "Hello\n\nworld");
	const text = buildQuotedReplyText(undefined, "Ann", "  \n Hello \r\n");
	assert.equal(text.split("\n").slice(1).join("\n"), "> Hello");
});

test("zero-width and bidi characters are removed from the quote", () => {
	assert.equal(cleanQuoteText("pa​y‮na⁦l﻿"), "paynal");
});

test("a selection longer than 4,000 characters is cut at 4,000", () => {
	const quote = buildQuotedReplyText(undefined, "Ann", "x".repeat(5000));
	const body = quote.split("\n").slice(1).join("\n");
	assert.equal(body, "> " + "x".repeat(MAX_QUOTE));
});

test("markup in a selection stays text: the composer writes text, nothing is parsed", () => {
	const quote = buildQuotedReplyText(undefined, "Ann", "</blockquote><img src=x onerror=alert(1)>");
	assert.ok(quote.endsWith("> </blockquote><img src=x onerror=alert(1)>"));
});

test("nothing left to quote gives nothing, so the reply is as before (Q8)", () => {
	assert.equal(buildQuotedReplyText(undefined, "Ann", " ​\n "), "");
});

test("the HTML quote shares the text header and still escapes it (CB-15)", () => {
	const src = readFileSync("app/lib/utils.ts", "utf8");
	assert.match(src, /escapeHtml\(quoteHeader\(dateStr, sender, t\)\)/);
});

// ---- the frame's visible text ----------------------------------------------------------------------

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height, width, height });
type FakeNode = {
	nodeType: number;
	tagName?: string;
	nodeValue?: string;
	parentNode: FakeNode | null;
	childNodes: FakeNode[];
	style: Record<string, string>;
	box: Rect;
	getBoundingClientRect(): Rect;
	getClientRects(): Rect[];
};

function el(tagName: string, style: Record<string, string>, children: FakeNode[], box = rect(0, 0, 300, 20)): FakeNode {
	const node: FakeNode = {
		nodeType: 1, tagName, parentNode: null, childNodes: children,
		style: { display: tagName === "SPAN" ? "inline" : "block", visibility: "visible", opacity: "1", fontSize: "14px", clip: "auto", clipPath: "none", overflow: "visible", ...style },
		box,
		getBoundingClientRect: () => node.box,
		getClientRects: () => (node.box.width || node.box.height ? [node.box] : []),
	};
	for (const c of children) c.parentNode = node;
	return node;
}
function text(value: string, box = rect(0, 0, 50, 16)): FakeNode {
	return { nodeType: 3, nodeValue: value, parentNode: null, childNodes: [], style: {}, box, getBoundingClientRect: () => box, getClientRects: () => [box] };
}
function page(body: FakeNode) {
	const win = {
		scrollX: 0, scrollY: 0, innerWidth: 600,
		getComputedStyle: (n: FakeNode) => n.style,
		document: {
			documentElement: { scrollWidth: 600 },
			createRange() {
				let target: FakeNode | null = null;
				return {
					setStart(n: FakeNode) { target = n; },
					setEnd() {},
					getClientRects: () => (target ? [target.box] : []),
				};
			},
		},
	};
	const texts: FakeNode[] = [];
	const collect = (n: FakeNode) => { if (n.nodeType === 3) texts.push(n); n.childNodes.forEach(collect); };
	collect(body);
	const first = texts[0]!, last = texts[texts.length - 1]!;
	const range = {
		collapsed: false,
		commonAncestorContainer: body,
		startContainer: first, startOffset: 0,
		endContainer: last, endOffset: last.nodeValue!.length,
		intersectsNode: () => true,
	};
	const selection = { rangeCount: 1, getRangeAt: () => range };
	return { win, selection };
}
const frameFns = new Function(`${FRAME_SELECTION_FUNCTIONS}; return { fiVisibleText, fiSelectionRect };`)() as {
	fiVisibleText: (sel: unknown, win: unknown) => string;
};

test("the frame sends only visible text: hidden, transparent, zero-size, clipped and off-screen text is left out (SEC-13)", () => {
	const body = el("BODY", {}, [
		el("P", {}, [
			text("Hello "),
			el("SPAN", { visibility: "hidden" }, [text("HIDDEN ")]),
			el("SPAN", { overflow: "hidden" }, [text("ZERO ")], rect(0, 0, 0, 0)),
			el("SPAN", {}, [text("AWAY ")], rect(-10000, 0, 100, 20)),
			el("SPAN", { opacity: "0" }, [text("GHOST ")]),
			el("SPAN", { clip: "rect(0px, 0px, 0px, 0px)", overflow: "hidden" }, [text("CLIPPED ")], rect(0, 0, 1, 1)),
			el("SPAN", { display: "none" }, [text("NONE ")]),
			el("SPAN", { fontSize: "0px" }, [text("TINY ")]),
			el("STYLE", {}, [text(".x{}")]),
			text("there"),
		]),
		el("P", {}, [text("world​‮!")]),
	]);
	const { win, selection } = page(body);
	assert.equal(frameFns.fiVisibleText(selection, win), "Hello there\nworld!");
});

test("text whose own rendering has no area, or sits off-screen, is left out too", () => {
	const body = el("BODY", {}, [el("P", {}, [text("Seen "), text("indent ", rect(-9999, 0, 40, 16)), text("flat ", rect(0, 0, 40, 0)), text("end")])]);
	const { win, selection } = page(body);
	assert.equal(frameFns.fiVisibleText(selection, win), "Seen end");
});

test("the frame's text is cut at 4,000 characters", () => {
	const { win, selection } = page(el("BODY", {}, [el("P", {}, [text("y".repeat(6000))])]));
	assert.equal(frameFns.fiVisibleText(selection, win).length, MAX_QUOTE);
});

test("every frame runs the selection script; height reporting stays with autoSize (R2-7)", () => {
	const src = readFileSync("app/components/EmailIframe.tsx", "utf8");
	assert.match(src, /const selectionScript = `<script>\$\{FRAME_SELECTION_SCRIPT\}<\\\/script>`;/);
	assert.match(src, /<body>\$\{cleanBody\}\$\{selectionScript\}\$\{heightScript\}<\/body>/);
	assert.match(src, /const heightScript = autoSize/);
	assert.match(src, /event\.source !== frame\.contentWindow/);
	assert.match(FRAME_SELECTION_SCRIPT, /addEventListener\("mouseup", fiReport\)/);
	assert.match(FRAME_SELECTION_SCRIPT, /addEventListener\("keyup", fiReport\)/);
	assert.match(FRAME_SELECTION_SCRIPT, /type: "selection"/);
	assert.doesNotMatch(FRAME_SELECTION_SCRIPT, /<\/script/i);
	// The script parses: a syntax error would silently drop height and selection reports alike.
	assert.doesNotThrow(() => new Function(FRAME_SELECTION_SCRIPT));
});

// ---- the reader's checks -----------------------------------------------------------------------------

const frame = {};
const active = { isActive: true };

test("a selection from the reader's own frame, with user activation, is held", () => {
	const got = acceptFrameSelection({ source: frame, data: { type: "selection", text: "Quote me", rect: { left: 1, top: 2, right: 3, bottom: 4 } } }, frame, active);
	assert.deepEqual(got, { text: "Quote me", rect: { left: 1, top: 2, right: 3, bottom: 4 } });
});

test("a selection from another window is ignored (SEC-14)", () => {
	assert.equal(acceptFrameSelection({ source: {}, data: { type: "selection", text: "x" } }, frame, active), undefined);
	assert.equal(acceptFrameSelection({ source: null, data: { type: "selection", text: "x" } }, null, active), undefined);
});

test("a selection without user activation is ignored; a clear needs none", () => {
	assert.equal(acceptFrameSelection({ source: frame, data: { type: "selection", text: "x" } }, frame, { isActive: false }), undefined);
	assert.equal(acceptFrameSelection({ source: frame, data: { type: "selection", text: "" } }, frame, { isActive: false }), null);
	// A browser without the userActivation API: the source check still holds.
	assert.ok(acceptFrameSelection({ source: frame, data: { type: "selection", text: "x" } }, frame, undefined));
});

test("the reader re-checks type, string and length, and drops a bad rect", () => {
	for (const data of [null, "selection", { type: "other", text: "x" }, { type: "selection", text: 5 }, { type: "selection", text: "x".repeat(MAX_QUOTE + 1) }])
		assert.equal(acceptFrameSelection({ source: frame, data }, frame, active), undefined);
	assert.deepEqual(acceptFrameSelection({ source: frame, data: { type: "selection", text: "a‮b", rect: { left: "1" } } }, frame, active), { text: "ab", rect: null });
});

const held: HeldQuote = { key: "m1", source: "frame", text: "Quote me", at: { left: 10, top: 20 } };

test("a frame's reload clears what was held from it, and only that (SEC-14)", () => {
	assert.equal(heldQuote(held, { type: "reload", key: "m1" }), null);
	assert.equal(heldQuote(held, { type: "reload", key: "m2" }), held);
	assert.equal(heldQuote({ ...held, source: "page" }, { type: "reload", key: "m1" })?.source, "page");
});

test("another message opening clears the held selection; a clear from another source keeps it", () => {
	assert.equal(heldQuote(held, { type: "reset" }), null);
	assert.equal(heldQuote(held, { type: "clear", key: "m1", source: "page" }), held);
	assert.equal(heldQuote(held, { type: "clear", key: "m1", source: "frame" }), null);
	assert.equal(heldQuote(null, { type: "select", quote: { ...held, text: "" } }), null);
});

test("a text body's selection counts only when both ends are inside the same body", () => {
	const inside = { key: "m1" };
	const sourceOf = (node: unknown) => (node === "in" ? inside : null);
	const sel = (anchorNode: string, focusNode: string, value = " Hi​ ") => ({ isCollapsed: false, anchorNode, focusNode, toString: () => value });
	assert.deepEqual(pageSelection(sel("in", "in"), sourceOf), { key: "m1", text: "Hi" });
	assert.equal(pageSelection(sel("in", "out"), sourceOf), null);
	assert.equal(pageSelection({ ...sel("in", "in"), isCollapsed: true }, sourceOf), null);
	assert.equal(pageSelection(null, sourceOf), null);
});

test("the reader quotes the selection in Reply and Reply all, and says how on both buttons", () => {
	const src = readFileSync("app/routes/unified-inbox.tsx", "utf8");
	assert.match(src, /const quoted = mode === "reply" \? quotedStart\(\) : "";/);
	assert.match(src, /quoted\s*\? quoted \+ "\\n\\n" \+ signature\s*: signed/);
	assert.equal(src.match(/title=\{t\("Select text in the message to quote it"\)\}/g)?.length, 2);
	assert.match(src, /<pre data-quote-key=\{selected\.id\}>/);
	assert.match(src, /useEffect\(\(\) => dispatchQuote\(\{ type: "reset" \}\), \[selected\?\.id\]\);/);
	assert.match(src, /t\("Reply with quote"\)/);
});

test("A-24: Reply with quote sits beside the selection's end, else above it, never on the line under it", () => {
  const pane = { left: 100, top: 50, width: 800, scrollLeft: 0, scrollTop: 0 };
  const line = { left: 200, top: 300, right: 400, bottom: 320 };
  const beside = quoteButtonPlace(line, pane, { width: 180, height: 30 });
  assert.deepEqual(beside, { left: 306, top: 245 }, "right of the last line, centred on it");
  // A selection ending near the pane's right edge: just above the last line, clamped into the pane.
  const atEdge = quoteButtonPlace({ left: 600, top: 300, right: 880, bottom: 320 }, pane, { width: 180, height: 30 });
  assert.deepEqual(atEdge, { left: 600, top: 214 });
  assert.ok(atEdge.top + 30 <= 300 - 50, "above the line, not on the text below it");
  // At the very top of what is shown there is no room above: below the line, as before.
  const top = quoteButtonPlace({ left: 600, top: 52, right: 880, bottom: 70 }, pane, { width: 180, height: 30 });
  assert.equal(top.top, 70 - 50 + 6);
  // Scrolled: positions are in the scroll area's own coordinates.
  assert.equal(quoteButtonPlace(line, { ...pane, scrollTop: 400 }).top, 645);
});
