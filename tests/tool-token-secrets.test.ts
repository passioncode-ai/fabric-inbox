// B-264: AUTOMATION_TOOL_TOKENS is one JSON secret that cannot be read back, so adding a credential
// meant writing the whole map again from sources that may be gone (a reply agent's project asked to
// connect its offers desk; one current entry's value is in no vault). A credential can now be its own
// secret, `AUTOMATION_TOOL_TOKEN_<NAME>` holding `{ host, token }`, added without touching the map.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readToolTokens, tokenFor, invokeTool } from "../workers/automation/mcp";

const url = (u: string) => new URL(u);

test("a credential in its own secret joins the map's entries", () => {
  const tokens = readToolTokens({
    AUTOMATION_TOOL_TOKENS: JSON.stringify({ SIGNALS: { host: "signals.example.com", token: "t-sig" } }),
    AUTOMATION_TOOL_TOKEN_LEADS: JSON.stringify({ host: "leads.example.com", token: "t-leads" }),
  });
  assert.equal(tokenFor(tokens, "SIGNALS", url("https://signals.example.com/mcp")), "t-sig");
  assert.equal(tokenFor(tokens, "LEADS", url("https://leads.example.com/mcp")), "t-leads");
  assert.throws(() => tokenFor(tokens, "LEADS", url("https://signals.example.com/mcp")), /belongs to another tool host/);
});

test("with no map at all the own secrets are the whole set", () => {
  const tokens = readToolTokens({ AUTOMATION_TOOL_TOKEN_LEADS: JSON.stringify({ host: "leads.example.com", token: "t" }) });
  assert.deepEqual(Object.keys(tokens), ["LEADS"]);
  assert.deepEqual(readToolTokens({}), {});
});

test("an own secret replaces the map's entry of the same name", () => {
  const tokens = readToolTokens({
    AUTOMATION_TOOL_TOKENS: JSON.stringify({ LEADS: { host: "old.example.com", token: "t-old" } }),
    AUTOMATION_TOOL_TOKEN_LEADS: JSON.stringify({ host: "leads.example.com", token: "t-new" }),
  });
  assert.equal(tokenFor(tokens, "LEADS", url("https://leads.example.com/mcp")), "t-new");
});

test("a malformed own secret breaks only the tool that names it", () => {
  const tokens = readToolTokens({
    AUTOMATION_TOOL_TOKENS: JSON.stringify({ SIGNALS: { host: "signals.example.com", token: "t-sig" } }),
    AUTOMATION_TOOL_TOKEN_BROKEN: "not json",
    AUTOMATION_TOOL_TOKEN_BARE: JSON.stringify("a bare token"),
  });
  assert.equal(tokenFor(tokens, "SIGNALS", url("https://signals.example.com/mcp")), "t-sig");
  assert.throws(() => tokenFor(tokens, "BROKEN", url("https://signals.example.com/mcp")), /misconfigured/);
  // A bare token would go to any allowlisted host; an own secret must name its host.
  assert.throws(() => tokenFor(tokens, "BARE", url("https://signals.example.com/mcp")), /misconfigured/);
});

test("other bindings and an empty name are not credentials", () => {
  const tokens = readToolTokens({ AUTOMATION_TOOL_TOKEN_: "{}", AUTOMATION_MCP_HOSTS: "a.example.com", OPENROUTER_API_KEY: "k" });
  assert.deepEqual(tokens, {});
});

test("a malformed map still refuses, as before", () => {
  assert.throws(() => readToolTokens({ AUTOMATION_TOOL_TOKENS: "{" }), /misconfigured/);
});

test("a rule's tool call refuses a misconfigured credential set before any request", async () => {
  await assert.rejects(
    invokeTool({ type: "mcp", endpoint: "https://leads.example.com/mcp", tool: "t", arguments: {}, tokenRef: "LEADS", location: "cloud" } as never, "leads.example.com", () => readToolTokens({ AUTOMATION_TOOL_TOKENS: "{" })),
    /misconfigured/,
  );
});
