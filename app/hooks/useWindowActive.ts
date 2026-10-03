import { useSyncExternalStore } from "react";
import { isWindowActive, subscribeWindowActivity } from "~/lib/window-activity";

/**
 * Whether this window is visible and focused (app/lib/window-activity.ts). The server render has
 * no window and reports active; nothing polls there.
 */
export function useWindowActive(): boolean {
	return useSyncExternalStore(
		(onChange) => subscribeWindowActivity(window, document, onChange),
		() => isWindowActive(document),
		() => true,
	);
}
