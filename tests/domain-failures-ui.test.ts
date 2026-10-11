// B-40: mail the server could neither take nor refuse shows on its domain's panel (SCN-025), with
// whom it was for, when and why, and a way to clear it. (The section imports "~/" paths that only the
// app's own build resolves, so the panel is read as source here; the data and route are tested in
// tests/incoming-failure-log.test.ts.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync("app/components/settings/sections/DomainsSection.tsx", "utf8");

test("each domain shows only its own failed deliveries, with whom, when and why, and Clear (B-40, SCN-025)", () => {
  assert.match(panel, /const failures = \(data\?\.incomingFailures \?\? \[\]\)\.filter\(\(f\) => f\.domain === domain\);/);
  assert.match(panel, /\{failures\.length > 0 && \(/, "no failure, no block");
  assert.match(panel, /t\("Mail this server could not take"\)/);
  assert.match(panel, /could not be taken or refused, so it was not kept/);
  assert.match(panel, /t\("\{address\}, \{when\}: \{problem\}", \{ address: f\.to \?\? domain, when: t\.dateTime\(f\.at\), problem: f\.error \}\)/);
  assert.match(panel, /fabric\(`\/api\/incoming-failures\?domain=\$\{encodeURIComponent\(domain\)\}`, undefined, "DELETE"\)/);
});

test("the server lists them with the addresses and clears them by domain (B-40)", () => {
  const route = readFileSync("workers/routes/agents.ts", "utf8");
  assert.match(route, /incomingFailures: failures\.map\(/);
  assert.match(route, /agentsRouter\.delete\("\/api\/incoming-failures"/);
});
