// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	index,
	type RouteConfig,
	route,
} from "@react-router/dev/routes";

export default [
	index("routes/unified-inbox.tsx"),
	route("mailboxes", "routes/home.tsx"),
	route("accounts", "routes/fabric-accounts.tsx"),
	route("accounts/:accountId", "routes/gmail-inbox.tsx"),
	route("automation/:account", "routes/automation.tsx"),
	route("ai-agents", "routes/agents.tsx"),
	route("knowledge", "routes/knowledge.tsx"),
	route("categories", "routes/categories.tsx"),
	route("spam", "routes/spam.tsx"),
	route("agent-access", "routes/agent-access.tsx"),
	route("projects", "routes/project-addresses.tsx"),
	route("setup", "routes/setup.tsx"),
	route("mailbox/:mailboxId", "routes/mailbox.tsx", [
		index("routes/mailbox-index.tsx"),
		route("emails/:folder", "routes/email-list.tsx"),
		route("settings", "routes/settings.tsx"),
		route("search", "routes/search-results.tsx"),
	]),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
