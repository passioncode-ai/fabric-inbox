/**
 * B-266: the person sets how wide the sidebar and the mail list are, by dragging the edge between two columns or with
 * the arrow keys on it; each width is kept on this device. Without a saved width the layout's own default for the
 * window applies (CSS), so a person who never drags sees the app as before.
 */
export interface ColumnSpec {
	/** Where the width is kept on this device. */
	key: string;
	/** The CSS variable on `.fi-app` that the layout reads (with its own default as the fallback). */
	cssVar: string;
	min: number;
	max: number;
}

export const SIDEBAR_COLUMN: ColumnSpec = { key: "fabric-inbox:sidebar-width", cssVar: "--fi-sidebar-width", min: 200, max: 460 };
export const LIST_COLUMN: ColumnSpec = { key: "fabric-inbox:list-width", cssVar: "--fi-list-width", min: 280, max: 760 };

/** A key on the edge moves it by this much; with Shift by four times as much. */
export const KEY_STEP = 16;

export function clampWidth(spec: ColumnSpec, width: number): number {
	return Math.round(Math.min(spec.max, Math.max(spec.min, width)));
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The saved width, or null for the layout's default; anything unreadable is the default. */
export function readWidth(spec: ColumnSpec, store: Store | undefined): number | null {
	try {
		const raw = store?.getItem(spec.key);
		if (!raw) return null;
		const n = Number(raw);
		return Number.isFinite(n) ? clampWidth(spec, n) : null;
	} catch {
		return null;
	}
}

/** Keeps a width (null forgets it: back to the default). A store that refuses is a per-device convenience lost. */
export function writeWidth(spec: ColumnSpec, store: Store | undefined, width: number | null): void {
	try {
		if (width === null) store?.removeItem(spec.key);
		else store?.setItem(spec.key, String(clampWidth(spec, width)));
	} catch {
		/* the width still applies until the page reloads */
	}
}

/** The width a key on the edge leads to, or undefined when the key does nothing there. */
export function widthForKey(spec: ColumnSpec, current: number, key: string, shift: boolean): number | undefined {
	const step = shift ? KEY_STEP * 4 : KEY_STEP;
	if (key === "ArrowLeft") return clampWidth(spec, current - step);
	if (key === "ArrowRight") return clampWidth(spec, current + step);
	if (key === "Home") return spec.min;
	if (key === "End") return spec.max;
	return undefined;
}

/** The inline style `.fi-app` carries: only the widths the person set. */
export function columnStyle(widths: Array<[ColumnSpec, number | null]>): Record<string, string> {
	const style: Record<string, string> = {};
	for (const [spec, width] of widths) if (width !== null) style[spec.cssVar] = `${clampWidth(spec, width)}px`;
	return style;
}
