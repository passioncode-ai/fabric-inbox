import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TRIAGE_TEXT } from "../app/components/inbox/triage-text";
import { SYNC_TEXT } from "../app/lib/sync-status";
import { SHORTCUT_TEXT } from "../app/lib/mail-keys";

// A Russian localization follows WS8 (Discarded: «Выброшенные»): the words of the new components
// live in their text tables, never as text written inline in the markup, so it translates tables.
const COMPONENTS = [
  "app/components/inbox/SyncStatus.tsx",
  "app/components/inbox/UndoToast.tsx",
  "app/components/inbox/ShortcutsDialog.tsx",
  "app/components/settings/sections/DiscardSection.tsx",
];

test("the new components write no words inline: text nodes and labels come from their tables", () => {
  for (const file of COMPONENTS) {
    const code = readFileSync(file, "utf8");
    const markup = code.slice(code.indexOf("export default function"));
    const inline = [...markup.matchAll(/>\s*([A-Za-z][A-Za-z ,.'’…:;!?-]{2,})\s*<\//g)].map((m) => m[1]);
    assert.deepEqual(inline, [], `${file}: text written in the markup`);
    const attributes = [...markup.matchAll(/\b(aria-label|title|placeholder)="([^"]*[A-Za-z][^"]*)"/g)].map((m) => `${m[1]}="${m[2]}"`);
    assert.deepEqual(attributes, [], `${file}: labels written in the markup`);
  }
});

test("the tables carry the words the brand pack registers", () => {
  assert.equal(TRIAGE_TEXT.folder, "Discarded");
  assert.equal(TRIAGE_TEXT.notDiscarded, "Not discarded");
  assert.equal(TRIAGE_TEXT.stopDiscarding, "Stop discarding mail like this");
  assert.equal(TRIAGE_TEXT.futureMail("Weekly Digest"), "Future mail from Weekly Digest will go to Discarded.");
  assert.equal(SYNC_TEXT.live, "Live");
  assert.equal(SYNC_TEXT.updated("2 min ago"), "Updated 2 min ago");
  assert.equal(SHORTCUT_TEXT.title, "Keyboard shortcuts");
});
