// B-265: no em dash (U+2014) in the interface strings a person reads, against the operator's rule (text for
// people carries no em dash and no substitute). The English sources are the dictionary's keys; B-260 keeps
// them out of the tool texts agents read. A reply agent's prompt template keeps its words (R28: a shipped
// template changes only as a new version), so a multi-line prompt is left out of the Russian check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const EM = "—";

test("no English interface string carries an em dash", () => {
  const dir = "shared/i18n/ru";
  const found: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    for (const m of readFileSync(path.join(dir, file), "utf8").matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"/gm))
      if (m[1].includes(EM)) found.push(`${file}: ${m[1]}`);
  }
  assert.deepEqual(found, []);
});

test("no Russian translation carries an em dash, but a shipped prompt template", () => {
  const dir = "shared/i18n/ru";
  const found: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    for (const m of readFileSync(path.join(dir, file), "utf8").matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/gm))
      if (m[2].includes(EM) && !m[1].includes("\\n")) found.push(`${file}: ${m[2]}`);
  }
  assert.deepEqual(found, []);
});

test("no em dash between elements in the app's markup", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith(".tsx"))
        readFileSync(full, "utf8").split("\n").forEach((line, i) => {
          const code = line.replace(/\{\/\*.*?\*\/\}/g, "").replace(/\/\/.*$/, "");
          if (code.includes(EM) && !/^\s*(\*|\/\*)/.test(line)) found.push(`${full}:${i + 1}`);
        });
    }
  };
  walk("app");
  assert.deepEqual(found, []);
});
