// B-266: the person sets the sidebar's and the mail list's widths; each is kept on this device and stays in its bounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIST_COLUMN, SIDEBAR_COLUMN, clampWidth, columnStyle, readWidth, widthForKey, writeWidth } from "../app/lib/column-width";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

test("a width stays between its column's narrowest and widest", () => {
  assert.equal(clampWidth(SIDEBAR_COLUMN, 50), SIDEBAR_COLUMN.min);
  assert.equal(clampWidth(SIDEBAR_COLUMN, 9999), SIDEBAR_COLUMN.max);
  assert.equal(clampWidth(LIST_COLUMN, 400.6), 401);
});

test("a width is kept on this device; nothing kept, or anything unreadable, is the layout's default", () => {
  const store = memory();
  assert.equal(readWidth(LIST_COLUMN, store), null);
  writeWidth(LIST_COLUMN, store, 480);
  assert.equal(readWidth(LIST_COLUMN, store), 480);
  store.setItem(LIST_COLUMN.key, "wide");
  assert.equal(readWidth(LIST_COLUMN, store), null);
  store.setItem(LIST_COLUMN.key, "5000");
  assert.equal(readWidth(LIST_COLUMN, store), LIST_COLUMN.max, "an old width beyond the bounds is brought back in");
  writeWidth(LIST_COLUMN, store, null);
  assert.equal(store.m.has(LIST_COLUMN.key), false, "a double click forgets it");
  const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} };
  assert.equal(readWidth(SIDEBAR_COLUMN, refusing), null);
  assert.doesNotThrow(() => writeWidth(SIDEBAR_COLUMN, refusing, 300));
});

test("the arrow keys move the edge, Shift by more, Home and End to the bounds; other keys do nothing", () => {
  assert.equal(widthForKey(SIDEBAR_COLUMN, 300, "ArrowRight", false), 316);
  assert.equal(widthForKey(SIDEBAR_COLUMN, 300, "ArrowLeft", true), 236);
  assert.equal(widthForKey(SIDEBAR_COLUMN, 210, "ArrowLeft", true), SIDEBAR_COLUMN.min);
  assert.equal(widthForKey(LIST_COLUMN, 400, "Home", false), LIST_COLUMN.min);
  assert.equal(widthForKey(LIST_COLUMN, 400, "End", false), LIST_COLUMN.max);
  assert.equal(widthForKey(LIST_COLUMN, 400, "Enter", false), undefined);
});

test("only a width the person set reaches the layout, through the variables the grid reads with its defaults", () => {
  assert.deepEqual(columnStyle([[SIDEBAR_COLUMN, null], [LIST_COLUMN, 455]]), { "--fi-list-width": "455px" });
  const css = readFileSync("app/styles/workbench.css", "utf8");
  for (const fallback of ["var(--fi-sidebar-width, 232px)", "var(--fi-sidebar-width, 205px)", "var(--fi-list-width, 350px)", "var(--fi-list-width, 390px)", "var(--fi-list-width, 300px)"])
    assert.ok(css.includes(fallback), fallback);
  const page = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  assert.match(page, /<ColumnResizer spec=\{SIDEBAR_COLUMN\}/);
  assert.match(page, /<ColumnResizer spec=\{LIST_COLUMN\}/);
});
