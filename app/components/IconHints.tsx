// B-226: one hint for every icon control in the app, mounted once in root.tsx. The pointer resting on a control
// whose icon says nothing, or keyboard focus reaching it, shows its name (and shortcut) in a small label beside it.
// A native title is held back while ours shows, so two hints never stack; a control's own Kumo tooltip wins.
import { useEffect, useState } from "react";
import { HINT_DELAY_MS, HINT_SELECTOR, hintFor } from "~/lib/icon-hint";

type Shown = { text: string; x: number; y: number; below: boolean };

export function IconHints() {
	const [shown, setShown] = useState<Shown | null>(null);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let current: HTMLElement | null = null;
		let heldTitle: string | null = null;
		let watch: MutationObserver | null = null;
		const hide = () => {
			if (timer) clearTimeout(timer);
			timer = null;
			watch?.disconnect();
			watch = null;
			if (current && heldTitle !== null) current.setAttribute("title", heldTitle);
			current = null;
			heldTitle = null;
			setShown(null);
		};
		const show = (el: HTMLElement) => {
			const text = hintFor(el, heldTitle);
			if (!text || !el.isConnected) return;
			const box = el.getBoundingClientRect();
			const below = box.top < 40;
			setShown({ text, x: box.left + box.width / 2, y: below ? box.bottom + 6 : box.top - 6, below });
			// The control's own tooltip opened: ours steps aside.
			watch = new MutationObserver(() => { if (el.hasAttribute("data-popup-open")) setShown(null); });
			watch.observe(el, { attributes: true, attributeFilter: ["data-popup-open"] });
		};
		const enter = (target: EventTarget | null, delay: number) => {
			const el = target instanceof Element ? (target.closest(HINT_SELECTOR) as HTMLElement | null) : null;
			if (el === current) return;
			hide();
			if (!el || !hintFor(el)) return;
			current = el;
			const title = el.getAttribute("title");
			if (title !== null) { heldTitle = title; el.removeAttribute("title"); }
			timer = setTimeout(() => { timer = null; show(el); }, delay);
		};
		const over = (e: PointerEvent) => { if (e.pointerType !== "touch") enter(e.target, HINT_DELAY_MS); };
		const focus = (e: FocusEvent) => {
			const el = e.target instanceof Element ? e.target : null;
			if (el?.matches(":focus-visible")) enter(el, 0);
		};
		const out = (e: PointerEvent) => {
			if (current && !(e.relatedTarget instanceof Node && current.contains(e.relatedTarget))) hide();
		};
		document.addEventListener("pointerover", over, true);
		document.addEventListener("pointerout", out, true);
		document.addEventListener("focusin", focus, true);
		document.addEventListener("focusout", hide, true);
		document.addEventListener("pointerdown", hide, true);
		document.addEventListener("keydown", hide, true);
		window.addEventListener("scroll", hide, true);
		return () => {
			hide();
			document.removeEventListener("pointerover", over, true);
			document.removeEventListener("pointerout", out, true);
			document.removeEventListener("focusin", focus, true);
			document.removeEventListener("focusout", hide, true);
			document.removeEventListener("pointerdown", hide, true);
			document.removeEventListener("keydown", hide, true);
			window.removeEventListener("scroll", hide, true);
		};
	}, []);
	if (!shown) return null;
	return (
		<div
			role="tooltip"
			className="pointer-events-none fixed z-[1000] max-w-xs whitespace-nowrap rounded-md bg-kumo-contrast px-2 py-1 text-xs text-kumo-inverse shadow-md"
			style={{ left: shown.x, top: shown.y, transform: `translate(-50%, ${shown.below ? "0" : "-100%"})` }}
		>
			{shown.text}
		</div>
	);
}
