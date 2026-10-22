// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import { msg } from "../../shared/i18n";
import { readRetrying } from "./do-retry";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
	};
};

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: "Not found" }, 404);
	}

	// B-27: a mailbox being renamed is frozen until the rename ends or is cancelled. Reading goes on;
	// a change made now would not reach the new address (review 2026-10-21).
	if (c.req.method !== "GET" && c.req.method !== "HEAD"
		&& await c.env.BUCKET.head(`renames/${mailboxId.toLowerCase()}.json`)) {
		return c.json({ error: msg("{email} is being renamed. Wait until the rename ends, or cancel it.", { email: mailboxId }) }, 409);
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	// A read survives a mailbox object reset or replaced mid-call (a deploy): it is tried once more.
	// A change is not repeated, since a call that failed this way may have happened.
	c.set("mailboxStub", c.req.method === "GET" || c.req.method === "HEAD" ? readRetrying(stub) : stub);
	
	await next();
});
