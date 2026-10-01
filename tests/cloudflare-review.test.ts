import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudflareApi, CloudflareApiError } from "../workers/routing/cloudflare-api";
import { identityMayUse } from "../workers/mcp/keys";
import { TOOLS } from "../workers/mcp/tools";

/**
 * Units behind the 0.8.1 review of the several-accounts work (docs/app-store/tasks/2026-09-30-cloudflare-accounts.md,
 * "Review 2026-10-01"): which token a refusal names, Email Sending's own refusals, the agent tool that
 * merges two answers, and the gate on the relay's paths.
 */
const answer = (status: number, errors: { code: number | null; message: string }[]) =>
  (async () => new Response(JSON.stringify({ success: false, errors, messages: [] }), { status })) as unknown as typeof fetch;

test("a refusal names the token it is about: the server's own, or the one saved for an account", async () => {
  const own = new CloudflareApi("t", answer(401, [{ code: 1000, message: "Invalid API Token" }]));
  await assert.rejects(own.call("/x"), /no longer accepts this server's token/);
  const saved = new CloudflareApi("t", answer(401, [{ code: 1000, message: "Invalid API Token" }]),
    { whose: "the token saved for the Cloudflare account b0", fix: "Connect it again." });
  await assert.rejects(saved.call("/x"), /no longer accepts the token saved for the Cloudflare account b0 \(mistyped, expired or deleted\)\. Connect it again\./);
  const denied = new CloudflareApi("t", answer(403, [{ code: 10000, message: "Authentication error" }]),
    { whose: "the token saved for the Cloudflare account b0", fix: "" });
  await assert.rejects(denied.call("/x", { what: "list your domains (Zone: Read)" }), /^Error: The token saved for the Cloudflare account b0 is not allowed to list your domains/);
});

test("Email Sending's own refusals are the domain's state, not a missing permission", async () => {
  const api = new CloudflareApi("t", answer(403, [{ code: null, message: "email.sending.error.sending_disabled" }]));
  const error = await api.call("/accounts/a/email/sending/send", { method: "POST", body: {}, what: "send from the domain (Email Sending: Edit)" }).catch((e) => e);
  assert.ok(error instanceof CloudflareApiError);
  assert.equal(error.status, 403);
  assert.doesNotMatch(error.message, /not allowed to/);
  assert.match(error.message, /sending_disabled/);
});

test("list_domains with destinations keeps the domain's own account", async () => {
  const tool = TOOLS.find((t) => t.name === "list_domains")!;
  const ctx = { api: { request: async (_m: string, path: string) => ({ status: 200, contentType: "application/json",
    data: path === "/api/domains/destinations" ? { account: "server-account", destinations: [] } : { domain: "studio.invalid", account: { id: "b0", server: false } } }) } };
  const result = await tool.call({ domain: "studio.invalid", destinations: true }, ctx as never) as Record<string, any>;
  assert.deepEqual(result.account, { id: "b0", server: false });
  assert.deepEqual(result.destinations, { account: "server-account", destinations: [] });
});

test("a service token may reach the relay's two paths exactly, and nothing else but /mcp", () => {
  const relay = { common_name: "client.access" };
  assert.equal(identityMayUse(relay, "/relay/incoming"), true);
  assert.equal(identityMayUse(relay, "/relay/forwarded"), true);
  assert.equal(identityMayUse(relay, "/relay/incoming/"), false);
  assert.equal(identityMayUse(relay, "/api/domains"), false);
  assert.equal(identityMayUse(relay, "/api/cloudflare/accounts"), false);
  assert.equal(identityMayUse({ email: "owner@example.invalid" }, "/api/domains"), true);
});

test("a reply to mail with no Message-ID threads here but puts no internal id in its headers", async () => {
  const { buildReferencesChain } = await import("../workers/lib/email-helpers");
  const noId = buildReferencesChain({ id: "incoming-abc", message_id: null, thread_id: "t1", email_references: JSON.stringify(["incoming-zzz", "real@mail.invalid"]) } as never);
  assert.equal(noId.originalMsgId, "");
  assert.deepEqual(noId.references, ["real@mail.invalid"]);
  assert.equal(noId.threadId, "t1");
  const withId = buildReferencesChain({ id: "incoming-abc", message_id: "orig@mail.invalid", thread_id: null, email_references: null } as never);
  assert.deepEqual([withId.originalMsgId, withId.references, withId.threadId], ["orig@mail.invalid", ["orig@mail.invalid"], "incoming-abc"]);
});
