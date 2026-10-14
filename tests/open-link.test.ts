// B-119: a link opens one message in the inbox, with its agent run — for the voice-of-the-customer
// dashboard's "open in source" and for the agent-events feed's `link` (fabric-service/0.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { messageLink, openFromLink } from "../app/components/inbox/open-link";
import { runEvent } from "../workers/agents/events";

test("a message link round-trips to the message the reader opens, with its run", () => {
  const link = messageLink("cloudflare:support@x.invalid", "e/1", "agent-0123456789abcdef0123456789abcdef");
  assert.equal(link, "/?open=cloudflare%3Asupport%40x.invalid%7Ce%2F1&run=agent-0123456789abcdef0123456789abcdef");
  const params = new URL("https://h.invalid" + link).searchParams;
  const m = openFromLink(params)!;
  assert.equal(m.accountId, "cloudflare:support@x.invalid");
  assert.equal(m.providerMessageId, "e/1");
  assert.equal(m.provider, "cloudflare");
  assert.equal(m.id, JSON.stringify(["cloudflare:support@x.invalid", "e/1"]));
  assert.deepEqual(m.agentRun, { id: "agent-0123456789abcdef0123456789abcdef", status: "" });
});

test("Gmail, IMAP and Outlook accounts open too; a malformed link opens nothing", () => {
  assert.equal(openFromLink(new URLSearchParams({ open: "gmail:g1|m9" }))!.provider, "gmail");
  assert.equal(openFromLink(new URLSearchParams({ open: "outlook:o1|m9" }))!.agentRun, undefined);
  for (const bad of ["", "nobar", "unknown:x|m", "cloudflare:a@x.invalid|"]) assert.equal(openFromLink(new URLSearchParams({ open: bad })), null, bad);
  assert.equal(openFromLink(new URLSearchParams({ open: "cloudflare:a@x.invalid|m", run: "not-a-run" }))!.agentRun, undefined);
});

test("every agent event links to its message in the inbox", () => {
  const e = runEvent({ id: "agent-0123456789abcdef0123456789abcdef", mailboxId: "support@x.invalid", emailId: "e1", sender: "", subject: "", status: "drafted", reason: "", toolCalls: [], createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:01Z" } as never)!;
  assert.equal(e.link, "/?open=cloudflare%3Asupport%40x.invalid%7Ce1&run=agent-0123456789abcdef0123456789abcdef");
});

test("the inbox opens the linked message once, when it loads", async () => {
  const { readFileSync } = await import("node:fs");
  const route = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(route, /const message = openFromLink\(params\);\n    if \(message\) setSelected\(message\);/);
});
