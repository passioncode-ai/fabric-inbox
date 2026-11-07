// B-226: which name a hovered icon control shows (app/lib/icon-hint.ts), without a page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hintFor } from "../app/lib/icon-hint";

const el = (attrs: Record<string, string>, text = "") => ({
	getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
	hasAttribute: (n: string) => n in attrs,
	textContent: text,
});

test("an icon or glyph control shows its title as written, else its aria-label with its shortcut", () => {
	assert.equal(hintFor(el({ "aria-label": "Check for new mail", title: "Check for new mail (Ctrl+Shift+N)", "aria-keyshortcuts": "Control+Shift+N" })), "Check for new mail (Ctrl+Shift+N)");
	assert.equal(hintFor(el({ "aria-label": "Mark as read" })), "Mark as read");
	assert.equal(hintFor(el({ "aria-label": "Close" }, "×")), "Close");
	assert.equal(hintFor(el({ title: "Archive" }, "↵")), "Archive");
	assert.equal(hintFor(el({ "aria-label": "Archive", "aria-keyshortcuts": "Delete" })), "Archive (Delete)");
	assert.equal(hintFor(el({ "aria-label": "Refresh", "data-shortcut": "⌘⇧N" })), "Refresh (⌘⇧N)");
});

test("a title held back while the hint shows is still read", () => {
	assert.equal(hintFor(el({}), "Theme"), "Theme");
});

test("no hint for a labelled button, a control with no name, its own open tooltip, or one that opts out", () => {
	assert.equal(hintFor(el({ "aria-label": "Send" }, "Send")), null);
	assert.equal(hintFor(el({ "aria-label": "Отправить" }, "Отправить")), null);
	assert.equal(hintFor(el({})), null);
	assert.equal(hintFor(el({ "aria-label": "Search", "data-popup-open": "" })), null);
	assert.equal(hintFor(el({ "aria-label": "Search", "data-no-hint": "" })), null);
});
