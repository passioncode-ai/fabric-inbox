// B-85 REQ-6: the agent editor offers a tool grant's fixed arguments, the call before the model and
// public-only, and writes them into the grant the server validates (workers/agents/definition.ts).
// Read from source like tests/agent-access-ui.test.ts: the editor is not rendered in node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("app/components/settings/sections/AgentsSection.tsx", "utf8");

test("B-85 REQ-6: each tool grant has the fixed arguments, the call before answering and public-only", () => {
  assert.match(src, /<FixedArguments value=\{tool\.fixed\} onChange=\{\(fixed\) => setTool\(i, \{ \.\.\.tool, fixed \}\)\} \/>/);
  assert.match(src, /prefetch: e\.target\.value\.trim\(\) \? \{ argument: e\.target\.value\.trim\(\) \} : undefined/, "an empty name removes the call before answering");
  assert.match(src, /publicOnly: e\.target\.checked \|\| undefined/);
});

test("B-85 REQ-6: fixed arguments that are not a flat JSON object are shown as not applied and never saved", () => {
  const body = src.slice(src.indexOf("function FixedArguments"), src.indexOf("const hostOf"));
  assert.match(body, /\["string", "number", "boolean"\]\.includes\(typeof v\)/);
  assert.match(body, /onChange\(parsed === null \? undefined : parsed\)/, "invalid text clears the fixed arguments instead of keeping the old ones");
  assert.match(body, /useEffect\(/, "the field follows the grant under it");
  assert.match(body, /role="alert"/);
});
