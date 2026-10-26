import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { runTool } from "../workers/mcp/protocol";
import { TOOLS } from "../workers/mcp/tools";
import { fakeApi, ledger, ok, owner } from "./mcp-fake-api";

/**
 * B-154 (DEC-0121 AP-4): the buttons whose step only the person takes stand on the agent surface as tools that
 * refuse with human-step-required and the direct link. The refusal is checked against the contract's own schema
 * (tests/fixtures/fabric-contract, pinned in its README).
 */
const dir = new URL("./fixtures/fabric-contract/", import.meta.url);
const ajv = new (Ajv2020 as unknown as typeof import("ajv").default)({ allErrors: true, strict: false });
(addFormats as unknown as (a: unknown) => void)(ajv);
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) ajv.addSchema(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
const refusal = ajv.getSchema("https://fabric.passioncode.ai/agent-contract/0.1.0/schemas/delegation-refusal.schema.json")!;

async function step(name: string, args: Record<string, unknown>, accounts: Record<string, unknown> = {}) {
  const { api, calls } = fakeApi({ "GET /api/accounts": ok(accounts) });
  const tool = TOOLS.find((t) => t.name === name)!;
  const { ledger: l, journal } = ledger();
  const result = await runTool(tool, z.object(tool.input).parse(args), { api, principal: owner }, l);
  assert.equal(result.isError, true, `${name} never succeeds`);
  if (result.structuredContent) assert.ok(refusal(result.structuredContent), JSON.stringify(refusal.errors));
  assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent ?? JSON.parse(result.content[0]!.text), "the text says the same");
  assert.deepEqual(journal, [], "a person's step changes nothing to journal");
  return { error: (result.structuredContent as any)?.error ?? JSON.parse(result.content[0]!.text), calls };
}

test("connecting an account answers the person's step and its link; nothing is connected", async () => {
  const imap = await step("connect_account", { provider: "imap" });
  assert.deepEqual([imap.error.code, imap.error.data], ["human-step-required", { humanStep: "secret", url: "/settings/accounts?connect=imap" }]);
  assert.deepEqual(imap.calls, [], "an IMAP account needs nothing read");
  assert.deepEqual((await step("connect_account", { provider: "cloudflare" })).error.data, { humanStep: "secret", url: "/settings/accounts?connect=cloudflare" });
  const gmail = await step("connect_account", { provider: "gmail" }, { configuration: "configured", connectUrl: "https://inbox.example/api/accounts/gmail/connect" });
  assert.deepEqual(gmail.error.data, { humanStep: "consent", url: "https://inbox.example/api/accounts/gmail/connect" });
  const unset = await step("connect_account", { provider: "gmail" }, { configuration: "missing" });
  assert.deepEqual(unset.error.data, { humanStep: "secret", url: "/settings/accounts?connect=gmail" }, "the owner's setup comes first");
  assert.deepEqual((await step("connect_account", { provider: "outlook" }, { outlookConnectUrl: "https://inbox.example/api/accounts/outlook/connect" })).error.data,
    { humanStep: "consent", url: "https://inbox.example/api/accounts/outlook/connect" });
});

test("a new app password and a provider's client secret are the person's to type, at the exact place", async () => {
  assert.deepEqual((await step("set_account_password", { accountId: "imap:a1" })).error.data, { humanStep: "secret", url: "/settings/accounts/imap%3Aa1" });
  const gmail = await step("set_account_password", { accountId: "gmail:g1" });
  assert.match(gmail.error.error, /^Only an IMAP account has an app password/, "a plain refusal, not a human step");
  assert.deepEqual((await step("set_provider_setup", { provider: "outlook" })).error.data, { humanStep: "secret", url: "/settings/accounts?connect=outlook" });
});
