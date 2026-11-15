import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { menuTemplate } = require("../desktop/menu.cjs");

/**
 * B-281 (fabric-workspace plan row 2.11, agent parity): every action a menu of the desktop app offers
 * a person is a row of docs/agents/desktop-actions.md, with its door for an agent or the reason it has
 * none. A menu item added without its row fails here, as the server's routes fail without their tool
 * (tests/mcp-coverage.test.ts). Electron's own roles (Copy, Zoom, Hide, Quit…) are presentation or the
 * broker's launch door and are covered by the rows that name them.
 */
const fn = () => {};
const SERVER = "Server Fixture";
const ctx = {
  t: (s: string) => s,
  update: { label: "Check for Updates…", enabled: true, click: fn },
  automatic: { checked: true, enabled: true, click: fn },
  usage: { checked: false, enabled: true, click: fn, about: fn },
  login: { checked: true, enabled: true, click: fn },
  newMail: { checked: false, enabled: true, click: fn },
  serverUpdate: { label: "Update Server", enabled: true, click: fn },
  openSettings: fn, showServer: fn, showCloudflare: fn, connectGmail: fn, retry: fn,
  servers: { items: [{ label: SERVER, checked: true, click: fn }], all: fn, add: fn, move: fn,
    rename: [{ label: SERVER, click: fn }], forget: [{ label: SERVER, click: fn }] },
  console: fn, consoleSkip: { checked: true, click: fn },
};
/** A server's own item stands for its parent action (Rename Server, Forget Server) or the switch in Account. */
function actions(items: any[], parent = ""): string[] {
  return items.flatMap((item) => {
    if (item.submenu) return actions(item.submenu, item.label ?? "");
    if (!item.click) return [];
    const label = String(item.label).replace(/…$/, "");
    if (label === SERVER) return [parent === "Account" ? "A server in the list" : parent];
    return [item.label];
  });
}
const doc = readFileSync("docs/agents/desktop-actions.md", "utf8");
const rows = doc.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Action") && !l.startsWith("|---"))
  .map((l) => l.split(" | ").map((c) => c.replace(/^\| |\s*\|$/g, "").trim()));
const DOORS = ["server", "link", "launch", "profile", "partial", "none", "not needed"];

test("B-281: every menu action of the desktop app, on every platform, has its row in the agent inventory", () => {
  const missing = new Set<string>();
  for (const platform of ["darwin", "win32", "linux"])
    for (const action of actions(menuTemplate(platform, ctx)))
      if (!rows.some((r) => r[0]!.includes(action.replace(/…$/, "")))) missing.add(`${platform}: ${action}`);
  assert.deepEqual([...missing], [], "add a row to docs/agents/desktop-actions.md with its door or the reason it has none");
});

test("B-281: each row names a door from the list, and a row with no door says why and how an agent works without it", () => {
  assert.ok(rows.length >= 20, `rows read: ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.length, 4, `four columns: ${r[0]}`);
    const door = r[2]!;
    assert.ok(DOORS.some((d) => door.startsWith(d)), `"${r[0]}" names a door from ${DOORS.join(", ")} (it says "${door}")`);
    assert.ok(r[3]!.length >= 20, `"${r[0]}" says how an agent does it, or why not`);
  }
});
