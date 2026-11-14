// B-263: the inbox's server tabs stay one line in a narrow window; a long server name is cut, never wrapped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("a server tab is one line, its name cut with its full name as the title, nothing past the row's edge", () => {
  const css = readFileSync("app/styles/workbench.css", "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${selector} has a rule`);
    return css.slice(at, css.indexOf("}", at));
  };
  const tab = rule(".fi-server-tabs .fi-chip");
  for (const d of ["white-space: nowrap", "flex: 0 0 auto", "max-width: 100%", "box-sizing: border-box"]) assert.ok(tab.includes(d), d);
  assert.match(rule(".fi-server-tabs .fi-chip > *"), /flex-shrink: 0/);
  const name = rule(".fi-server-tabs .fi-chip > .fi-server-name");
  for (const d of ["min-width: 0", "overflow: hidden", "text-overflow: ellipsis", "flex: 0 1 auto"]) assert.ok(name.includes(d), d);
  const tsx = readFileSync("app/components/inbox/ServerTabs.tsx", "utf8");
  assert.equal(tsx.match(/<span className="fi-server-name">\{s\.label\}<\/span>/g)?.length, 4, "every server tab names its server in the cut span");
  assert.equal(tsx.match(/title=\{s\.label\}/g)?.length, 2, "the tabs without a title of their own carry the full name");
});

test("B-266: the tabs' row is as tall as its tabs in the mail list's column, never the column's whole height", () => {
  // Measured in WebKit on 2026-11-14: with `.fi-chip-row`'s `flex: 1 0 100%` in the list's flex column the row took
  // 780 px and every tab grew to 253 px; with this rule the tabs are 26 px and the mail list stays in view.
  const css = readFileSync("app/styles/workbench.css", "utf8");
  const at = css.indexOf(".fi-server-tabs {");
  const rule = css.slice(at, css.indexOf("}", at));
  for (const d of ["flex: 0 0 auto", "align-content: flex-start", "align-items: center"]) assert.ok(rule.includes(d), d);
  assert.ok(at > css.indexOf(".fi-chip-row {"), "the tabs' rule comes after the shared chip row's, so it wins");
});
