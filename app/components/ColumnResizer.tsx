import { useLayoutEffect, useState, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import { clampWidth, widthForKey, type ColumnSpec } from "~/lib/column-width";

/**
 * B-266: the edge after a column (the sidebar, the mail list), which the person drags or moves with the arrow keys
 * (Shift for bigger steps, Home and End for the narrowest and widest); a double click gives the layout's default back.
 * It sits over the column's right edge, in the column's own positioned parent, wherever the layout put that edge.
 */
export default function ColumnResizer({ spec, target, width, onChange, label }: {
	spec: ColumnSpec;
	/** The column this edge resizes. */
	target: RefObject<HTMLElement | null>;
	/** The width the person set, or null for the layout's default. */
	width: number | null;
	/** A new width while dragging (`commit` false) and when it is done (`commit` true); null is the default again. */
	onChange: (width: number | null, commit: boolean) => void;
	label: string;
}) {
	const [edge, setEdge] = useState<number | null>(null);
	useLayoutEffect(() => {
		const el = target.current;
		if (!el) return;
		const update = () => setEdge(el.offsetParent ? el.offsetLeft + el.offsetWidth : null);
		update();
		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
		observer?.observe(el);
		window.addEventListener("resize", update);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [target]);
	const shown = () => Math.round(target.current?.getBoundingClientRect().width ?? spec.min);
	const start = (e: ReactPointerEvent<HTMLDivElement>) => {
		const el = target.current;
		if (e.button !== 0 || !el) return;
		e.preventDefault();
		const left = el.getBoundingClientRect().left;
		const handle = e.currentTarget;
		handle.setPointerCapture?.(e.pointerId);
		document.body.classList.add("fi-resizing");
		let last = width ?? shown();
		const move = (ev: PointerEvent) => {
			last = clampWidth(spec, ev.clientX - left);
			onChange(last, false);
		};
		const end = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			document.body.classList.remove("fi-resizing");
			onChange(last, true);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	};
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuemin={spec.min}
			aria-valuemax={spec.max}
			aria-valuenow={width ?? (edge === null ? undefined : shown())}
			tabIndex={0}
			className="fi-col-resizer"
			style={edge === null ? { display: "none" } : { left: edge - 3 }}
			onPointerDown={start}
			onDoubleClick={() => onChange(null, true)}
			onKeyDown={(e) => {
				const next = widthForKey(spec, width ?? shown(), e.key, e.shiftKey);
				if (next === undefined) return;
				e.preventDefault();
				onChange(next, true);
			}}
		/>
	);
}
