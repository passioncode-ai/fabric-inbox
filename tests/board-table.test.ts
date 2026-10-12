// The board is read by the workspace's backlog aggregation (docs/backlog-sources.json): a row with
// more or fewer cells than its header makes the aggregate INCOMPLETE. B-78 once had six cells under
// a five-column header after a status was written as a cell of its own (2026-10-12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/);

test("every board row has as many cells as its table's header", () => {
  const lines = readFileSync("docs/evidence/backlog.md", "utf8").split("\n");
  let header = 0;
  const bad: string[] = [];
  lines.forEach((line, i) => {
    if (!line.startsWith("|")) { header = 0; return; }
    if (!header) { header = cells(line).length; return; }
    if (/^\|\s*-/.test(line)) return;
    if (cells(line).length !== header) bad.push(`line ${i + 1} (${line.split("|")[1]?.trim()}): ${cells(line).length} cells, header ${header}`);
  });
  assert.deepEqual(bad, []);
});
