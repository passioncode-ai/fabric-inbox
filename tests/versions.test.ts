import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

// One version for everything a release ships: the server, the Mac app that uploads it (main.cjs
// refuses a bundle whose version differs from the app's) and the agents' skill. Seen 2026-09-29:
// 0.7.0's image was built as 0.6.2 because only the root package.json had been bumped.
test("the server, the Mac app and the skill plugin carry one version", () => {
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8")).version as string;
  const root = read("package.json");
  assert.equal(read("desktop/package.json"), root, "desktop/package.json");
  assert.equal(read("plugins/fabric-inbox/.claude-plugin/plugin.json"), root, "the skill plugin");
  if (existsSync("desktop/package-lock.json")) assert.equal(read("desktop/package-lock.json"), root, "desktop/package-lock.json");
});

// The release notes come from CHANGELOG.md (desktop/dist-mac.mjs refuses a version without its
// section), so its newest section is the version the manifests carry.
test("CHANGELOG.md opens with the version the manifests carry", async () => {
  const { changelogSection } = await import("../desktop/dist-mac.mjs");
  const version = JSON.parse(readFileSync("package.json", "utf8")).version as string;
  const text = readFileSync("CHANGELOG.md", "utf8");
  const newest = /^## (\d+\.\d+\.\d+)/m.exec(text)?.[1];
  assert.equal(newest, version, "the first ## heading of CHANGELOG.md");
  assert.ok(changelogSection(text, version).length > 0, `CHANGELOG.md has notes for ${version}`);
});
