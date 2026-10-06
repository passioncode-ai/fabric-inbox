import { redirect } from "react-router";
import { legacyTarget, settingsPath } from "~/components/settings/paths";

/**
 * An address of an older version (`/projects`, `/accounts`, `/setup`, `/mailbox/:id/settings`, …)
 * answers with a redirect into its Settings section, keeping what it pointed at: `?domain=`,
 * `?c=` and the desktop app's `?source=`. The same answer serves a reload, a bookmark and a link
 * followed inside the app.
 */
export function loader({ request }: { request: Request }) {
	const url = new URL(request.url);
	throw redirect(legacyTarget(url.pathname, url.search) ?? settingsPath("addresses"));
}

export default function SettingsRedirect() {
	return null;
}
