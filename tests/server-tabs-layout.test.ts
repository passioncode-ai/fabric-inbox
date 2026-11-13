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
