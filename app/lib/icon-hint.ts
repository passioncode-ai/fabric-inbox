// B-226 (operator, 2026-11-06: «на иконке показывать подсказки, что это за кнопки, сейчас многие иконки всякие
// непонятные»): which name a hovered or focused control shows. A control whose visible text says nothing (an icon,
// a "×") shows its title, else its aria-label with its shortcut; one that already reads as words shows nothing, and
// one wrapped in its own tooltip (Kumo's sets data-popup-open while it shows) is left to it. Pure, so it is tested
// without a page.

/** What the hint reads of an element: the few attributes and the text it needs. */
export type HintTarget = {
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
	textContent: string | null;
};

/** Text that reads as a label: two letters or digits in a row. A glyph such as ×, ↵ or … does not. */
const readsAsWords = (text: string | null) => /[\p{L}\p{N}]{2,}/u.test(text ?? "");

/** The name to show for a control, with its shortcut when it declares one, or null for no hint. */
export function hintFor(el: HintTarget, storedTitle?: string | null): string | null {
	if (el.hasAttribute("data-no-hint") || el.hasAttribute("data-popup-open")) return null;
	if (readsAsWords(el.textContent)) return null;
	// A title is what the control's author wrote for hovering (often with its shortcut): it is shown as it is.
	const title = (storedTitle ?? el.getAttribute("title") ?? "").trim();
	if (title) return title;
	const name = (el.getAttribute("aria-label") || "").trim();
	if (!name) return null;
	const keys = (el.getAttribute("aria-keyshortcuts") || el.getAttribute("data-shortcut") || "").trim();
	return keys ? `${name} (${keys})` : name;
}

/** The controls a hint is looked for on. */
export const HINT_SELECTOR = 'button, a[href], [role="button"], [role="menuitem"]';

/** How long the pointer rests on a control before its name shows (ms). */
export const HINT_DELAY_MS = 450;
