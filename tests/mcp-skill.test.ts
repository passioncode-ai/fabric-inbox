import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "../workers/mcp/tools";

/**
 * AP-10: the skill agents work by names only tools that exist, stays inside the Agent Skills
 * limits, and carries the same version as the app it describes.
 */
const PLUGIN = "plugins/fabric-inbox";
const SKILL_DIR = join(PLUGIN, "skills", "working-with-fabric-inbox");
const files = [join(SKILL_DIR, "SKILL.md"), ...readdirSync(join(SKILL_DIR, "references")).map((f) => join(SKILL_DIR, "references", f))];
/** Backticked snake_case words in the skill that are not tools. */
const NOT_TOOL_WORDS = new Set(["reconnect_required", "testing_expiry", "gmail_api_disabled", "microsoft_access_revoked", "microsoft_signin_required", "microsoft_secret_expired",
  // States check_address and check_test_message answer (SCN-061, SCN-062).
  "can_receive", "needs_fix", "not_arrived"]);

test("the skill names only tools the server has", () => {
  const names = new Set(TOOLS.map((t) => t.name));
  const named = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) named.add(m[1]!);
  const unknown = [...named].filter((n) => !names.has(n) && !NOT_TOOL_WORDS.has(n));
  assert.deepEqual(unknown, [], `The skill names tools that do not exist: ${unknown.join(", ")}`);
  assert.ok(named.size >= 30, `the skill should guide through the tools (${named.size} named)`);
});

test("the skill's front matter and body are within the Agent Skills limits", () => {
  const text = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  assert.ok(fm, "front matter");
  assert.match(fm!, /^name: working-with-fabric-inbox$/m, "name equals the directory");
  const description = fm!.match(/description: >-\n((?:  .*\n?)+)/)?.[1]?.split("\n").map((l) => l.trim()).filter(Boolean).join(" ") ?? "";
  assert.ok(description.startsWith("Use when"), "description starts with Use when");
  assert.ok(description.length <= 970, `description ${description.length} chars (≤970 keeps 5% headroom under 1024)`);
  assert.ok(!/[<>]/.test(description), "no angle brackets in description");
  assert.ok(!/claude|anthropic/i.test(fm!.match(/^name: .*$/m)![0]), "reserved words in name");
  for (const key of fm!.split("\n").filter((l) => /^[a-z-]+:/.test(l)).map((l) => l.split(":")[0]))
    assert.ok(["name", "description", "license", "compatibility", "metadata"].includes(key!), `front-matter key ${key}`);
  const body = text.slice(text.indexOf("\n---\n", 4) + 5);
  assert.ok(body.split("\n").length < 500, "body under 500 lines");
  assert.ok(body.length / 4 < 4750, "body under ~4750 tokens (5% headroom)");
});

test("the plugin carries the app's version, so an update of the app updates the skill", () => {
  const plugin = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
  const app = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(plugin.version, app.version);
  assert.equal(plugin.name, "fabric-inbox");
  assert.equal(plugin.license, "AGPL-3.0-only OR LicenseRef-PassionCode-Commercial");
});
