// R28 of the agent template database (board request b72b3d85; operator, 2026-11-11: «мы всегда только добавили, чтобы
// всегда можно было посмотреть ... только улучшали и все изменения были логированы»): a shipped agent template or
// prompt is never changed or deleted. A changed one ships beside it under a new name and gets its own lock line; one
// leaves only by a `retired` mark ({date, reason}) in the lock, and stays readable. The digest is the sha256 of the
// entry as JSON with sorted keys, as the database's add-only-catalog pattern computes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AGENT_TEMPLATES, LEGACY_INSTRUCTIONS, OFFERED_TEMPLATES, RETIRED_TEMPLATES, withNewAgentDefaults } from "../workers/agents/definition";

type LockEntry = { digest: string; shipped: string; retired?: { date: string; reason: string } };
const lock = JSON.parse(readFileSync(new URL("../workers/agents/shipped.lock.json", import.meta.url), "utf8")) as { schema: string; entries: Record<string, LockEntry> };

const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
const digest = (v: unknown) => "sha256:" + createHash("sha256").update(JSON.stringify(canon(v))).digest("hex");

const catalog = (): Record<string, unknown> => ({
  "legacy-instructions": { instructions: LEGACY_INSTRUCTIONS },
  ...Object.fromEntries(Object.entries(AGENT_TEMPLATES).map(([k, v]) => [`template:${k}`, v])),
});

test("the lock is add-only-lock/1 and every line names its digest and shipping day; a retired line its date and reason", () => {
  assert.equal(lock.schema, "add-only-lock/1");
  for (const [name, e] of Object.entries(lock.entries)) {
    assert.match(e.digest, /^sha256:[0-9a-f]{64}$/, name);
    assert.match(e.shipped, /^\d{4}-\d{2}-\d{2}$/, name);
    if (e.retired) {
      assert.match(e.retired.date, /^\d{4}-\d{2}-\d{2}$/, `${name}: retired.date`);
      assert.ok(e.retired.reason?.trim(), `${name}: retired.reason`);
    }
  }
});

test("no shipped template or prompt is changed or deleted, retired ones included", () => {
  const now = catalog();
  for (const [name, e] of Object.entries(lock.entries)) {
    assert.ok(name in now, `${name} was shipped and is gone: keep it (mark it retired in the lock to stop offering it)`);
    assert.equal(digest(now[name]), e.digest, `${name} was shipped and changed: restore it and ship the change under a new name`);
  }
});

test("every template in the catalogue is in the lock", () => {
  for (const [name, entry] of Object.entries(catalog())) {
    assert.ok(lock.entries[name], `${name} is new: add {"digest": "${digest(entry)}", "shipped": "<today>"} to workers/agents/shipped.lock.json and a line to CHANGELOG.md`);
  }
});

test("the digest is the add-only-catalog pattern's: sorted keys, compact JSON", () => {
  assert.equal(digest({ b: 1, a: [{ d: 2, c: 3 }] }), digest({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(digest({ a: "é" }), "sha256:" + createHash("sha256").update('{"a":"é"}').digest("hex"));
});

test("B-253: retired templates are exactly the ones marked in the lock, and none is offered", () => {
  const marked = Object.entries(lock.entries).filter(([name, e]) => name.startsWith("template:") && e.retired).map(([name]) => name.slice(9)).sort();
  assert.deepEqual([...RETIRED_TEMPLATES].sort(), marked);
  for (const key of RETIRED_TEMPLATES) assert.ok(!(key in OFFERED_TEMPLATES), `${key} is retired and still offered`);
  assert.deepEqual(Object.keys(OFFERED_TEMPLATES).sort(), ["billing-auto", "sales-auto", "support-auto"]);
  for (const template of Object.values(OFFERED_TEMPLATES)) assert.equal(template.replyPolicy?.mode, "auto");
});

test("B-253: a new agent with no mode answers by itself; a mode given is kept", () => {
  assert.deepEqual(withNewAgentDefaults({ name: "A", instructions: "x" }), { name: "A", instructions: "x", replyPolicy: { mode: "auto" } });
  assert.deepEqual(withNewAgentDefaults({ name: "A", replyPolicy: { dailySendLimit: 5 } }), { name: "A", replyPolicy: { dailySendLimit: 5, mode: "auto" } });
  const drafting = { name: "A", replyPolicy: { mode: "draft" } };
  assert.equal(withNewAgentDefaults(drafting), drafting);
  assert.equal(withNewAgentDefaults(null), null);
});
