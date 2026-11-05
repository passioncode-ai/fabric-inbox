// B-209: what this server uses, declared for a host's map (workers/lib/connections.ts, DEC-0096).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTIONS_EXTENSION, SCAN_MODEL, connectionsOf } from "../workers/lib/connections";
import { REPLY_FALLBACK_MODEL, REPLY_MODEL, checkersFor } from "../workers/agents/model";

const full = { OPENROUTER_API_KEY: "sk-synthetic", CLOUDFLARE_API_TOKEN: "synthetic", CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), GOOGLE_CLIENT_ID: "synthetic",
  AGENT_REGISTRY: {}, CATEGORIES: {}, KNOWLEDGE: {} } as never;

test("B-209: the extension key is the contract's connections key", () => {
  assert.equal(CONNECTIONS_EXTENSION, "https://fabric.passioncode.ai/agent-contract/extensions/connections/0.1");
});

test("B-209: with every setting, the stores, the channels and each model the agents call, ids unique, no credential", () => {
  const list = connectionsOf(full);
  const ids = list.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  for (const c of list) { assert.match(c.target, /^[^\s]+$/); assert.ok(["ok", "degraded", "down", "unknown"].includes(c.state)); }
  const by = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.equal(by.cloudflare.state, "ok");
  assert.equal(by.gmail.kind, "channel");
  assert.equal(by.outlook, undefined, "no Outlook app, no Outlook channel");
  assert.equal(by["model-writer"].target, REPLY_MODEL);
  assert.equal(by["model-fallback"].target, REPLY_FALLBACK_MODEL);
  assert.deepEqual(list.filter((c) => c.id.startsWith("model-checker-")).map((c) => c.target), checkersFor(REPLY_MODEL));
  assert.equal(by["model-scan"].target, SCAN_MODEL);
  assert.equal(JSON.stringify(list).includes("synthetic"), false, "a setting's value is never named");
});

test("B-209: without a token or a model key the connections say degraded, with the reason", () => {
  const list = connectionsOf({ AGENT_REGISTRY: {} } as never);
  const by = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.equal(by.cloudflare.state, "degraded");
  assert.match(by.cloudflare.reason!, /No Cloudflare token/);
  assert.equal(by["model-writer"].state, "degraded");
  assert.match(by["model-writer"].reason!, /No OpenRouter key/);
  assert.equal(list.some((c) => c.id.startsWith("model-checker-")), false);
  assert.equal(by.gmail, undefined);
});

test("B-209: a server with no agents names no agent model", () => {
  const list = connectionsOf({} as never);
  assert.equal(list.some((c) => c.kind === "model"), false);
  assert.deepEqual(list.map((c) => c.id), ["mailboxes", "files", "cloudflare"]);
});
