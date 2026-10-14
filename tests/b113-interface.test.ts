// B-113 / B-73 (UI walk 2026-10-13): the remaining interface items, held by what the code does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGENT_TEMPLATES } from "../workers/agents/definition";
import { RU } from "../shared/i18n/ru";

test("agent templates fill in the interface's language", () => {
  for (const template of Object.values(AGENT_TEMPLATES)) {
    assert.ok(RU[template.name], `"${template.name}" has a Russian name`);
    assert.ok(RU[template.instructions], `"${template.name}" instructions have a Russian text`);
  }
  const section = readFileSync("app/components/settings/sections/AgentsSection.tsx", "utf8");
  assert.match(section, /name: t\.text\(template\.name\), instructions: t\.text\(template\.instructions\)/);
});

test("Move to Trash from the inbox is said with Undo, which brings the message back to the inbox", () => {
  const route = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(route, /if \(change\.trashed && folder === "inbox" && selected\.id === change\.id\)\n\s+setToast\(\{ trashed: selected/);
  assert.match(route, /if \(toast\?\.trashed && !toast\.undoing\) return undoTrash\(toast\.trashed\);/);
  assert.match(route, /await changeMessage\(message, \{ trashed: false \}\);\n\s+forgetFeedChanges\(\[message\.id\]\);/);
  assert.match(route, /onUndo=\{toast\.done \|\| toast\.trashed \?/);
});

test("the toast region is named in the interface's language (B-73)", () => {
  const root = readFileSync("app/root.tsx", "utf8");
  assert.match(root, /<Toasty>\n\s+<ToastRegionLabel \/>/);
  assert.match(root, /const label = t\("Notifications"\);/);
  // The viewport's fixed attributes the label is found by.
  const viewport = readFileSync("node_modules/@base-ui/react/esm/toast/viewport/ToastViewport.js", "utf8");
  assert.match(viewport, /role: 'region',\n\s+'aria-live': 'polite',\n\s+'aria-atomic': false,\n\s+'aria-relevant': 'additions text',\n\s+'aria-label': 'Notifications'/);
  assert.equal(RU["Notifications"], "Уведомления");
});

test("on a phone the reader takes the screen and Settings shows the current section", () => {
  const css = readFileSync("app/styles/workbench.css", "utf8");
  assert.match(css, /\.fi-has-selection \.fi-sidebar,\n\s+\.fi-has-selection \.fi-toolbar \{\n\s+display: none;/);
  const settings = readFileSync("app/routes/settings.tsx", "utf8");
  assert.match(settings, /current\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
  assert.match(settings, /<nav ref=\{nav\} className="fi-settings-nav"/);
});
