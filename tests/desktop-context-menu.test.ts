import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error a CommonJS module of the desktop app
import { contextMenuTemplate } from "../desktop/context-menu.cjs";

// Operator, 2026-10-21: a right-click on a link or a button in a message opens it in the browser or copies it.
const t = (s: string) => s;
const run = (params: Record<string, unknown>) => {
  const opened: string[] = [], copied: string[] = [];
  const items = contextMenuTemplate(params, { t, open: (u: string) => opened.push(u), copy: (s: string) => copied.push(s) });
  return { items, opened, copied, labels: items.map((i: { label?: string; type?: string }) => i.label ?? i.type) };
};

test("a link or a button in a message: Open Link in Browser and Copy Link, each doing just that", () => {
  const r = run({ linkURL: "https://shop.example/confirm?token=1", selectionText: "" });
  assert.deepEqual(r.labels, ["Open Link in Browser", "Copy Link"]);
  r.items[0].click(); r.items[1].click();
  assert.deepEqual(r.opened, ["https://shop.example/confirm?token=1"]);
  assert.deepEqual(r.copied, ["https://shop.example/confirm?token=1"]);
});

test("a mail address: write to it, or copy the address without mailto:", () => {
  const r = run({ linkURL: "mailto:ann@shop.example?subject=Hi" });
  assert.deepEqual(r.labels, ["Write to This Address", "Copy Address"]);
  r.items[1].click();
  assert.deepEqual(r.copied, ["ann@shop.example"]);
});

test("selected text offers Copy; a field the editing items; a link that is not the web or mail is not offered", () => {
  assert.deepEqual(run({ selectionText: "order 1234" }).labels, ["Copy"]);
  assert.deepEqual(run({ isEditable: true, editFlags: { canCopy: true, canPaste: true } }).labels, ["Cut", "Copy", "Paste", "Select All"]);
  assert.deepEqual(run({ linkURL: "javascript:alert(1)" }).labels, []);
  assert.deepEqual(run({ linkURL: "file:///etc/hosts" }).labels, []);
  assert.deepEqual(run({}).labels, [], "nothing to offer: no menu");
  assert.deepEqual(run({ linkURL: "https://a.example/", selectionText: "a" }).labels, ["Open Link in Browser", "Copy Link", "separator", "Copy"]);
});

test("the mail window shows the menu, for every frame of it, with the system clipboard", () => {
  const main = readFileSync("desktop/main.cjs", "utf8");
  assert.match(main, /win\.webContents\.on\('context-menu', \(_event, params\) => \{/);
  assert.match(main, /copy: \(text\) => clipboard\.writeText\(text\)/);
  assert.match(main, /Menu\.buildFromTemplate\(items\)\.popup\(\{ window: win \}\)/);
});
