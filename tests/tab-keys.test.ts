import { test } from "node:test";
import assert from "node:assert/strict";
import { tabAfterKey } from "../app/lib/tab-keys";

const tabs = ["rules", "history", "sending"] as const;

test("arrow keys move along the tab list and wrap at either end (A-29)", () => {
  assert.equal(tabAfterKey(tabs, "rules", "ArrowRight"), "history");
  assert.equal(tabAfterKey(tabs, "history", "ArrowRight"), "sending");
  assert.equal(tabAfterKey(tabs, "sending", "ArrowRight"), "rules");
  assert.equal(tabAfterKey(tabs, "rules", "ArrowLeft"), "sending");
  assert.equal(tabAfterKey(tabs, "history", "ArrowLeft"), "rules");
});

test("Home and End go to the first and the last tab", () => {
  assert.equal(tabAfterKey(tabs, "history", "Home"), "rules");
  assert.equal(tabAfterKey(tabs, "history", "End"), "sending");
});

test("any other key, or a current tab not in the list, moves nothing", () => {
  assert.equal(tabAfterKey(tabs, "rules", "Enter"), null);
  assert.equal(tabAfterKey(tabs, "rules", "ArrowDown"), null);
  assert.equal(tabAfterKey(["rules", "history"], "sending", "ArrowRight"), null);
  assert.equal(tabAfterKey([], "rules", "Home"), null);
});
