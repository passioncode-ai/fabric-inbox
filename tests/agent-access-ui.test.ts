import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import AgentAccess, { LEVELS, sendingText } from "../app/routes/agent-access";

/** SCR-15 (SCN-043, SCN-044) rendered with the server's answers already in the cache. */
function render(keys: unknown, journal: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (keys) client.setQueryData(["agent-keys"], keys);
  if (journal) client.setQueryData(["agent-journal", null], journal);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(AgentAccess))));
}

test("each level says what it may do, and sending reads the way the key sends (SCN-043)", () => {
  assert.deepEqual(LEVELS.map((l) => l.title), ["Read", "Mail", "Admin"]);
  assert.match(LEVELS[0]!.hint, /Changes nothing/);
  assert.equal(sendingText({ level: "read", send: "send", dailySendLimit: 9 }), "Sends nothing");
  assert.equal(sendingText({ level: "mail", send: "drafts", dailySendLimit: 9 }), "Drafts only");
  assert.equal(sendingText({ level: "admin", send: "send", dailySendLimit: 9 }), "Can send, 9 a day");
});

test("Agent access lists keys and changes, never a secret, and says it is not the reply agents (SCN-043, SCN-044)", () => {
  const html = render(
    { keys: [{ id: "t1", clientId: "abc.access", name: "Support assistant", level: "mail", send: "send", dailySendLimit: 20, createdAt: "2026-09-29T10:00:00Z", expiresAt: "2027-09-29T10:00:00Z" }],
      mcpUrl: "https://inbox.example/mcp", canIssue: true },
    { entries: [{ at: Date.parse("2026-09-29T11:00:00Z"), callerLabel: "Support assistant", tool: "send_email", target: "cloudflare:support@x.invalid → ann@y.invalid", outcome: "done", detail: "" }], nextBefore: null },
  );
  assert.match(html, /These are not the reply agents/);
  assert.match(html, /Support assistant/);
  assert.match(html, /Can send, 20 a day/);
  assert.match(html, /Revoke…/);
  assert.match(html, /send_email/);
  assert.match(html, /Done/);
  assert.match(html, /Make key/);
  assert.doesNotMatch(html, /Client Secret/, "the secret panel appears only right after a key is made");
});

test("with no keys, no changes and no Cloudflare token, each part says so and where to go (SCN-043)", () => {
  const html = render({ keys: [], mcpUrl: "https://inbox.example/mcp", canIssue: false }, { entries: [], nextBefore: null });
  assert.match(html, /No agent has a key yet/);
  assert.match(html, /No agent has changed anything yet/);
  assert.match(html, /has no Cloudflare token, so it cannot make keys/);
  assert.doesNotMatch(html, /Make key/);
});
