import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readAll, stateOf, INBOX_PATH } = require("../desktop/all-servers.cjs");

// B-233 (SCN-099): the mail of every server the app holds in one list, each server read through its own session.
const A = { origin: "https://own.example", label: "My space" };
const B = { origin: "https://org.example", label: "Acme" };
const C = { origin: "https://down.example", label: "Other" };
const msg = (id: string, ts: number, read = false) => ({ accountId: "cloudflare:support@acme.example", providerMessageId: id, sender: "Ann <ann@shop.example>",
  recipient: "support@acme.example", subject: `s-${id}`, snippet: "hello", timestamp: ts, date: new Date(ts).toISOString(), read });

test("merges every server's inbox newest first, each row naming its server and a link on its own server", async () => {
  const asked: string[] = [];
  const read = async (origin: string, path: string) => {
    asked.push(`${origin}${path}`);
    return origin === A.origin ? { status: 200, body: { messages: [msg("a1", 100), msg("a2", 300, true)] } } : { status: 200, body: { messages: [msg("b1", 200)] } };
  };
  const out = await readAll({ servers: [A, B], read });
  assert.deepEqual(asked.sort(), [`${A.origin}${INBOX_PATH}`, `${B.origin}${INBOX_PATH}`].sort());
  assert.deepEqual(out.messages.map((m: any) => [m.server, m.subject]), [["My space", "s-a2"], ["Acme", "s-b1"], ["My space", "s-a1"]]);
  assert.equal(out.messages[1].origin, B.origin);
  assert.equal(out.messages[1].link, "/?open=cloudflare%3Asupport%40acme.example%7Cb1");
  assert.equal(out.messages[1].to, "support@acme.example");
  assert.deepEqual(out.servers.map((s: any) => [s.label, s.state, s.unread]), [["My space", "ok", 1], ["Acme", "ok", 1]]);
});

test("a signed-out or unreachable server never hides the others", async () => {
  const read = async (origin: string) => {
    if (origin === B.origin) return { status: 401, body: null };
    if (origin === C.origin) throw new Error("ENOTFOUND");
    return { status: 200, body: { messages: [msg("a1", 1)] } };
  };
  const out = await readAll({ servers: [A, B, C], read });
  assert.deepEqual(out.servers.map((s: any) => [s.label, s.state, s.unread]), [["My space", "ok", 1], ["Acme", "signed_out", null], ["Other", "unreachable", null]]);
  assert.equal(out.messages.length, 1);
});

test("a row it cannot open is left out, and an answer that is not an inbox reads as unreachable", async () => {
  assert.equal(stateOf({ status: 200, body: { error: "x" } }), "unreachable");
  assert.equal(stateOf({ status: 502, body: null }), "unreachable");
  assert.equal(stateOf({ status: 403, body: null }), "signed_out");
  const out = await readAll({ servers: [A], read: async () => ({ status: 200, body: { messages: [{ subject: "no id" }, msg("a1", 5)] } }) });
  assert.deepEqual(out.messages.map((m: any) => m.subject), ["s-a1"]);
});

test("S01 (B-267): a read that came back with a full page says so, so its unread count shows as a lower bound", async () => {
  const page = Array.from({ length: 50 }, (_, i) => msg(`f${i}`, i));
  const read = async (origin: string) => origin === A.origin ? { status: 200, body: { messages: page } } : { status: 200, body: { messages: [msg("b1", 1)] } };
  const out = await readAll({ servers: [A, B], read });
  assert.deepEqual(out.servers.map((s: any) => [s.label, s.full]), [["My space", true], ["Acme", false]]);
});
