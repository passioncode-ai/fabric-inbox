// A tool token named by a grant (`tokenRef`) was sent as a bearer to whatever allowlisted endpoint
// the grant named: an Admin key could point SIGNALS' token at another allowlisted host (bug hunt
// 2026-10-12). A token can now be bound to its host and then only goes there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenFor } from "../workers/automation/mcp";

const url = (u: string) => new URL(u);
const tokens = { NGDATA: { host: "nicegram-data-agent.example.com", token: "t-ng" }, SIGNALS: { host: "signals.example.com", token: "t-sig" }, OLD: "t-old" };

test("a bound token goes only to its own host", () => {
  assert.equal(tokenFor(tokens, "NGDATA", url("https://nicegram-data-agent.example.com/mcp")), "t-ng");
  assert.equal(tokenFor(tokens, "NGDATA", url("https://NICEGRAM-DATA-AGENT.example.com/mcp")), "t-ng", "host case does not matter");
  assert.throws(() => tokenFor(tokens, "NGDATA", url("https://signals.example.com/mcp")), /belongs to another tool host/);
});

test("no tokenRef sends nothing; an unknown or malformed one is refused", () => {
  assert.equal(tokenFor(tokens, undefined, url("https://signals.example.com/mcp")), undefined);
  assert.throws(() => tokenFor(tokens, "MISSING", url("https://signals.example.com/mcp")), /not configured/);
  assert.throws(() => tokenFor({ BAD: { host: 1 } } as never, "BAD", url("https://signals.example.com/mcp")), /misconfigured/);
});

test("an unbound (legacy) token still works, for configurations made before hosts were named", () => {
  assert.equal(tokenFor(tokens, "OLD", url("https://anything.example.com/mcp")), "t-old");
});
