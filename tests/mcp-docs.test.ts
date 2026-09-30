import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOC_PATH, withTools } from "../scripts/mcp-docs";
import { TOOLS } from "../workers/mcp/tools";

// AP-8: docs/agents/mcp.md documents every tool, generated from the definitions.
test("the agent protocol's tool reference is current (npm run mcp:docs)", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  assert.equal(withTools(doc), doc, "docs/agents/mcp.md is stale: run npm run mcp:docs and commit it");
  for (const t of TOOLS) assert.ok(doc.includes(`| \`${t.name}\` |`), `${t.name} is not in docs/agents/mcp.md`);
});
