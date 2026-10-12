// B-85 review findings, as tests of the grant rules in workers/agents/definition.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { grantSchemaProblems, modelSchema, publicOnlyProblem, toolArgumentsValid } from "../workers/agents/definition";

const grant = (over: Record<string, unknown> = {}) => ({ name: "kb", description: "d", endpoint: "https://kb.invalid/mcp", tool: "search", ...over }) as never;

test("publicOnly: every value must sit inside an item marked public", () => {
  assert.equal(publicOnlyProblem(JSON.stringify({ results: [{ class: "public", quote: "ok", source: { title: "Wiki" } }] })), null, "a public item's nested fields inherit its class");
  assert.match(publicOnlyProblem(JSON.stringify({ results: [{ class: "public", quote: "ok" }, { quote: "internal revenue" }] }))!, /not marked public/, "an unlabelled sibling");
  assert.match(publicOnlyProblem(JSON.stringify({ answer: "confidential synthesis", results: [{ class: "public", quote: "ok" }] }))!, /not marked public/, "an unlabelled top-level field");
  assert.match(publicOnlyProblem(JSON.stringify({ results: [{ class: "public", n: 1 }, { revenue: 1200000 }] }))!, /not marked public/, "numbers count too");
  assert.match(publicOnlyProblem(JSON.stringify({ results: [{ class: "confidential", quote: "x" }] }))!, /not marked public/);
  let deep: unknown = { class: "public", quote: "ok" };
  for (let i = 0; i < 30; i++) deep = { wrap: [deep] };
  assert.match(publicOnlyProblem(JSON.stringify(deep))!, /too deep/, "depth is a refusal, not a skip");
});

test("publicOnly (FI-3): the brief's rule is the code's — class is the string public, inherited by everything inside", () => {
  assert.equal(publicOnlyProblem(JSON.stringify({ class: "public", answer: "a", sources: [{ title: "Wiki", score: 0.9 }] })), null, "a top-level public class covers the whole output");
  assert.match(publicOnlyProblem(JSON.stringify({ answer: "a", sources: [{ title: "Wiki" }] }))!, /not marked public/, "no class anywhere is not public");
  assert.match(publicOnlyProblem(JSON.stringify({ results: [{ class: { label: "public" }, quote: "x" }] }))!, /not marked public/, "a class object is not the string public");
  assert.match(publicOnlyProblem(JSON.stringify({ results: [{ class: "PUBLIC", quote: "x" }] }))!, /not marked public/, "the value is exact");
  assert.match(publicOnlyProblem(JSON.stringify({ class: "public", results: [{ class: "internal", quote: "x" }] }))!, /not marked public/, "an inner class overrides the outer one");
  assert.match(publicOnlyProblem("plain text answer")!, /not JSON/);
});

test("modelSchema: a schema with $ref falls back to the wrapper; required drops fixed keys", () => {
  assert.equal(modelSchema(grant({ inputSchema: JSON.stringify({ type: "object", properties: { q: { $ref: "#/$defs/Q" } }, $defs: { Q: { type: "string" } } }) })), null);
  const s = modelSchema(grant({ inputSchema: JSON.stringify({ type: "object", properties: { q: { type: "string" }, domain: { type: "string" } }, required: ["q", "domain"] }), fixed: { domain: "nicegram" } }))!;
  assert.deepEqual(Object.keys(s.properties as object), ["q"]);
  assert.deepEqual(s.required, ["q"]);
});

test("grantSchemaProblems: inherited names are not schema keys; prefetch cannot be a fixed argument", () => {
  const schema = { type: "object", properties: { query: { type: "string" } } };
  assert.match(grantSchemaProblems(grant({ fixed: { toString: "x" } }), schema).join(), /fixed argument "toString"/);
  assert.match(grantSchemaProblems(grant({ fixed: { query: "pinned" }, prefetch: { argument: "query" } }), schema).join(), /"query" is fixed/);
});

test("toolArgumentsValid: the model's arguments are a plain object with the schema's required keys", () => {
  const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
  assert.equal(toolArgumentsValid(schema, { q: "x" }), true);
  assert.equal(toolArgumentsValid(schema, {}), false);
  assert.equal(toolArgumentsValid(schema, "q"), false);
  assert.equal(toolArgumentsValid(schema, ["q"]), false);
});
