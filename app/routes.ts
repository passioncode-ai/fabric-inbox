// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	index,
	type RouteConfig,
	route,
} from "@react-router/dev/routes";

/**
 * The addresses of the settings pages before Settings became one screen (SCR-02, 0.11). Each one
 * still works: it answers with a redirect into its section (app/components/settings/paths.ts).
 * (`/agents` is not one: the Worker gives that path to the Agents SDK, which is why the old page was
 * `/ai-agents`.)
 */
const LEGACY_SETTINGS = ["mailboxes", "accounts", "ai-agents", "knowledge", "categories", "spam", "agent-access", "projects", "setup"];

export default [
	index("routes/unified-inbox.tsx"),
	route("settings/:section?/:id?/:tab?", "routes/settings.tsx"),
	...LEGACY_SETTINGS.map((path) => route(path, "routes/settings-redirect.tsx", { id: `legacy-${path}` })),
	route("accounts/:accountId", "routes/gmail-inbox.tsx"),
	route("automation/:account", "routes/automation.tsx"),
	route("mailbox/:mailboxId", "routes/mailbox.tsx", [
		index("routes/mailbox-index.tsx"),
		route("emails/:folder", "routes/email-list.tsx"),
		route("settings", "routes/settings-redirect.tsx", { id: "legacy-mailbox-settings" }),
		route("search", "routes/search-results.tsx"),
	]),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
