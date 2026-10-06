// An open page that is older than its server (P3-13): it says so and offers to reload, and a page
// that cannot load its own code because the server was updated under it reloads once by itself.
import { BUILD_HEADER, BUILD_ID } from "../../shared/build";

/** Dispatched on window when the server answers with another build than this page's. */
export const UPDATE_EVENT = "fabric:update-available";

let announced = false;
/**
 * Compares a response's build with this page's. True, once, when they differ: the server was
 * updated after this page loaded. A missing header or a development build never counts.
 */
export function noteServerBuild(headers: Pick<Headers, "get">, ownBuild = BUILD_ID, target: EventTarget | undefined = typeof window === "undefined" ? undefined : window): boolean {
	const server = headers.get(BUILD_HEADER);
	if (!server || server === "dev" || ownBuild === "dev" || server === ownBuild || announced) return false;
	announced = true;
	target?.dispatchEvent(new Event(UPDATE_EVENT));
	return true;
}
/** For tests: forget that an update was announced. */
export function resetBuildNotice() {
	announced = false;
}

const RELOAD_KEY = "fabric-inbox:chunk-reload";
/** At most one automatic reload a minute, so a server that really is broken does not loop. */
const RELOAD_GAP_MS = 60_000;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/**
 * A piece of this page's code could not be loaded (Vite's `vite:preloadError`): after a server
 * update the old file names are gone. Reloads the page once to get the new build. True when it did.
 */
export function reloadForMissingCode(storage: Storage | undefined, reload: () => void, now = Date.now()): boolean {
	let last = 0;
	try { last = Number(storage?.getItem(RELOAD_KEY) || 0); } catch { /* storage unavailable: still reload once */ }
	if (now - last < RELOAD_GAP_MS) return false;
	try { storage?.setItem(RELOAD_KEY, String(now)); } catch { /* the gap is then per page, which is still bounded */ }
	reload();
	return true;
}
