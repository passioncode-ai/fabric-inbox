// B-85 REQ-6: the agent editor offers a tool grant's fixed arguments, the call before the model and
// public-only, and writes them into the grant the server validates (workers/agents/definition.ts).
// Read from source like tests/agent-access-ui.test.ts: the editor is not rendered in node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("app/components/settings/sections/AgentsSection.tsx", "utf8");

test("B-85 REQ-6: each tool grant has the fixed arguments, the call before answering and public-only", () => {
  assert.match(src, /<FixedArguments value=\{tool\.fixed\} onChange=\{\(fixed\) => setTool\(i, \{ \.\.\.tool, fixed \}\)\} onProblem=\{\(bad\) => markFixed\(i, bad\)\} \/>/);
  assert.match(src, /prefetch: e\.target\.value\.trim\(\) \? \{ argument: e\.target\.value\.trim\(\) \} : undefined/, "an empty name removes the call before answering");
  assert.match(src, /publicOnly: e\.target\.checked \|\| undefined/);
});

test("UI walk 2026-10-13: invalid fixed arguments block saving instead of silently saving the grant without them", () => {
  const field = src.slice(src.indexOf("function FixedArguments"), src.indexOf("const hostOf"));
  assert.match(field, /onProblem\?\.\(parsed === null\)/, "the field reports its problem to the editor");
  const editor = src.slice(src.indexOf("function AgentEditor"));
  assert.match(editor, /const blocked = badFixed\.size > 0/);
  assert.match(editor, /disabled=\{busy \|\| blocked\}/, "Save is disabled while a tool's fixed arguments are invalid");
  assert.match(editor, /if \(blocked\) return;/, "submitting with Enter is refused too");
  assert.match(editor, /onProblem=\{\(bad\) => /);
});

test("B-85 REQ-6: fixed arguments that are not a flat JSON object are shown as not applied and never saved", () => {
  const body = src.slice(src.indexOf("function FixedArguments"), src.indexOf("const hostOf"));
  assert.match(body, /\["string", "number", "boolean"\]\.includes\(typeof v\)/);
  assert.match(body, /onChange\(parsed === null \? undefined : parsed\)/, "invalid text clears the fixed arguments instead of keeping the old ones");
  assert.match(body, /useEffect\(/, "the field follows the grant under it");
  assert.match(body, /role="alert"/);
});

test("UI walk 2026-10-13: removing a tool forgets its invalid fixed arguments and renumbers the rest", () => {
  const editor = src.slice(src.indexOf("function AgentEditor"));
  assert.match(editor, /setBadFixed\(\(old\) => new Set\(\[\.\.\.old\]\.filter\(\(j\) => j !== i\)\.map\(\(j\) => \(j > i \? j - 1 : j\)\)\)\)/);
});
