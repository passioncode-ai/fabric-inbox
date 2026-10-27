import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * B-176 (SCN-079): Settings → Addresses → Reply status lists the Gmail, IMAP and Outlook accounts that have a reply
 * agent, each under its email's domain, beside the Cloudflare addresses; the server names them in GET /api/agent-status.
 */
const APP = pathToFileURL(`${process.cwd()}/app/`).href;
registerHooks({ resolve: (s, c, next) => (s.startsWith("~/") ? next(new URL(s.slice(2), APP).href, c) : next(s, c)) });
const { withAccounts } = await import("../app/components/settings/sections/ReplyStatusSettings");
const { inboxRouter } = await import("../workers/routes/inbox");

test("an account with an agent joins its domain's group, or a group of its own; an address already listed is not repeated", () => {
  const groups = [{ domain: "shop.example", addresses: ["support@shop.example"] }];
  assert.deepEqual(withAccounts(groups, [{ email: "Sales@Shop.example" }, { email: "me@mail.example" }, { email: "support@shop.example" }]), [
    { domain: "shop.example", addresses: ["support@shop.example"], accounts: ["sales@shop.example"] },
    { domain: "mail.example", addresses: [], accounts: ["me@mail.example"] },
  ]);
  assert.deepEqual(withAccounts(groups), [{ domain: "shop.example", addresses: ["support@shop.example"], accounts: [] }]);
});

test("GET /api/agent-status names the accounts with a reply agent by email; an account with its agent Off or none is left out", async () => {
  const objects: Record<string, unknown> = {
    "accounts/gmail:g1.json": { agent: { id: "support" } },
    "accounts/imap:i1.json": { agent: "off" },
    "accounts/outlook:o1.json": {},
  };
  const BUCKET = {
    get: async (key: string) => (key in objects ? { json: async () => objects[key] } : null),
    list: async ({ prefix }: { prefix: string }) => ({ objects: Object.keys(objects).filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
  };
  const GMAIL_ACCOUNTS = { getByName: () => ({ listAccounts: async () => ({ accounts: [
    { id: "g1", provider: "gmail", email: "Help@Acme.example" }, { id: "i1", provider: "imap", email: "box@acme.example" }, { id: "o1", provider: "outlook", email: "o@acme.example" },
  ] }) }) };
  const r = await inboxRouter.request("/api/agent-status", {}, { BUCKET, GMAIL_ACCOUNTS } as never);
  const body = await r.json() as { enabled: boolean; accounts: { email: string; accountId: string }[] };
  assert.equal(body.enabled, false, "the settings are there as before");
  assert.deepEqual(body.accounts, [{ email: "help@acme.example", accountId: "gmail:g1" }]);
  const none = await (await inboxRouter.request("/api/agent-status", {}, { BUCKET } as never)).json() as { accounts: unknown[] };
  assert.deepEqual(none.accounts, [], "no accounts object: no accounts, the settings still read");
});
