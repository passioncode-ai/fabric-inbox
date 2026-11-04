// B-161: the knowledge events a change leaves (workers/agents/knowledge-events.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { ANSWER_CHARS, agentLearned, collectionStale, documentLearned, documentRetracted, readersOf, validatorOf } from "../workers/agents/knowledge-events";

test("B-161: who saved a change: a person is the operator, an agent key an agent, nothing known is unknown", () => {
  assert.equal(validatorOf("owner@owner.example"), "operator");
  assert.equal(validatorOf("owner:owner@owner.example"), "operator");
  assert.equal(validatorOf("key:k-123"), "agent");
  assert.equal(validatorOf(null), "unknown");
});

test("B-161: a long text is cut and marked; a removal names its ref and no text; readers are the agents that grant the collection", () => {
  const at = "2026-10-27T12:00:00.000Z";
  const long = documentLearned({ collectionId: "c1", id: "d1", revision: "r1", title: "Refunds", text: "x".repeat(ANSWER_CHARS + 5) }, ["a@acme.example"], at, "operator");
  const value = long.data.value as { answer: string; truncated: boolean; ref: string; questions: string[] };
  assert.deepEqual([value.answer.length, value.truncated, value.ref, value.questions], [ANSWER_CHARS, true, "doc:c1/d1@r1", ["Refunds"]]);
  assert.equal(long.link, "/settings/knowledge/c1");
  const gone = documentRetracted({ collectionId: "c1", id: "d1", revision: "r1", title: "Refunds" }, [], at, "agent");
  assert.equal(gone.kind, "knowledge.retracted");
  assert.equal(JSON.stringify(gone).includes("answer"), false);
  const own = agentLearned({ id: "support", version: 3, knowledge: "Short." }, [], at, "operator");
  assert.deepEqual([(own.data.value as { ref: string }).ref, (own.data.value as { truncated: boolean }).truncated, own.link], ["agent:support@3", false, "/settings/agents/support"]);
  const byAgent = new Map([["support", ["a@acme.example"]], ["sales", ["b@acme.example", "a@acme.example"]], ["other", ["c@acme.example"]]]);
  assert.deepEqual(readersOf("c1", [{ id: "support", collections: ["c1"] }, { id: "sales", collections: ["c1", "c2"] }, { id: "other", collections: ["c2"] }], byAgent),
    ["a@acme.example", "b@acme.example"]);
});

test("B-199: a stale collection's event names it, its last batch, its limit and when it went stale, and fits the published schema", () => {
  const schema = JSON.parse(readFileSync("docs/agents/knowledge-event.schema.json", "utf8"));
  const validate = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false }).compile(schema);
  const e = collectionStale({ id: "docs", name: "Docs", syncedAt: "2026-11-04T00:00:00.000Z", maxAgeHours: 2, ageHours: 3.5 }, ["support@acme.example"], "2026-11-04T03:30:00.000Z");
  assert.equal(e.kind, "knowledge.stale");
  assert.equal(e.level, "warning");
  assert.deepEqual(e.data.value, { ref: "collection:docs@2026-11-04T00:00:00.000Z", source: "collection", collectionId: "docs", addresses: ["support@acme.example"],
    syncedAt: "2026-11-04T00:00:00.000Z", maxAgeHours: 2, ageHours: 3.5, staleSince: "2026-11-04T02:00:00.000Z" });
  assert.ok(validate(e.data.value), JSON.stringify(validate.errors));
  for (const other of [documentLearned({ collectionId: "c", id: "d", revision: "r", title: "T", text: "x" }, [], e.at, "operator"),
    documentRetracted({ collectionId: "c", id: "d", revision: "r", title: "T" }, [], e.at, "agent")]) assert.ok(validate(other.data.value), JSON.stringify(validate.errors));
});
