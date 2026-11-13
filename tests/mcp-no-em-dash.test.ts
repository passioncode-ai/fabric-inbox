import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZodTypeAny } from "zod";
import { NOT_TOOLS, TOOLS } from "../workers/mcp/tools";

/**
 * B-260: the text agents and people read about each tool carries no em dash (U+2014), by the operator's rule for text
 * people read: a full stop, a colon or parentheses instead. Exact quotations stay, and none is in a tool's text.
 */
const DASH = "—";

test("no tool's title, description, input or reason for having no tool carries an em dash", () => {
  const found: string[] = [];
  for (const t of TOOLS) {
    if (t.title.includes(DASH)) found.push(`${t.name}: title`);
    if (t.description.includes(DASH)) found.push(`${t.name}: description`);
    for (const [name, schema] of Object.entries(t.input as Record<string, ZodTypeAny>))
      if (schema.description?.includes(DASH)) found.push(`${t.name}.${name}`);
  }
  for (const [route, why] of Object.entries(NOT_TOOLS)) if (why.includes(DASH)) found.push(route);
  assert.deepEqual(found, []);
});
