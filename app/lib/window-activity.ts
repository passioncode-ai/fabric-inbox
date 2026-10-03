// When a screen may poll (knowledge/lifecycle.md LC-08: idle means idle). A window is active only
// while it is visible AND focused. TanStack Query pauses an interval only for a hidden page, so a
// screen left visible behind another app kept polling; the audit found Automation at every 5 s
// (raw/fabric-inbox.md §4, F6). Screens that poll pass pollInterval(useWindowActive(), ms) as their
// refetchInterval: no interval below MIN_POLL_MS, none at all while the window is not active.

/** No screen polls faster than this. */
export const MIN_POLL_MS = 30_000;
/** Automation's runs and outbox, while the window is active. */
export const AUTOMATION_POLL_MS = 30_000;

type ActivityDocument = { visibilityState: string; hasFocus(): boolean };

export function isWindowActive(doc: ActivityDocument): boolean {
	return doc.visibilityState === "visible" && doc.hasFocus();
}

/** A TanStack refetchInterval: `ms` (never under MIN_POLL_MS) while active, off otherwise. */
export function pollInterval(active: boolean, ms: number): number | false {
	return active ? Math.max(ms, MIN_POLL_MS) : false;
}

/** Calls `onChange` with the new activity on focus, blur and visibility changes. */
export function subscribeWindowActivity(
	win: EventTarget,
	doc: EventTarget & ActivityDocument,
	onChange: (active: boolean) => void,
): () => void {
	const update = () => onChange(isWindowActive(doc));
	win.addEventListener("focus", update);
	win.addEventListener("blur", update);
	doc.addEventListener("visibilitychange", update);
	return () => {
		win.removeEventListener("focus", update);
		win.removeEventListener("blur", update);
		doc.removeEventListener("visibilitychange", update);
	};
}
