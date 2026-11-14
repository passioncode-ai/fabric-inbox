// B-263, B-266, S01 (B-267): the mail list's server switch sits in the list heading as one line; it never wraps into
// tall ovals; its counts say when they are a lower bound; segments up to four servers in a wide enough list, else a menu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { switchCounts, SEGMENTS_MIN_WIDTH } from "../app/components/inbox/ServerTabs";
import type { HeldServer, OtherServerState } from "../app/lib/other-servers";

const css = readFileSync("app/styles/workbench.css", "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule`);
  return css.slice(at, css.indexOf("}", at));
};

test("S01: the switch sits in the list heading, at its right, and never wraps", () => {
  const reader = readFileSync("app/routes/unified-inbox.tsx", "utf8");
  const heading = reader.slice(reader.indexOf('<div className="fi-list-heading">'), reader.indexOf('<div className="fi-filter-bar"'));
  assert.match(heading, /<ServerTabs /, "the switch is inside the list heading");
  assert.match(heading, /marked\.size > 1 \? <span>\{TT\.selected\(marked\.size\)\}<\/span>/, "a selection's count replaces it while messages are selected");
  const box = rule(".fi-server-tabs");
  for (const d of ["display: flex", "justify-content: flex-end", "min-width: 0"]) assert.ok(box.includes(d), d);
  assert.doesNotMatch(box, /flex-wrap: wrap/, "the switch never wraps into a second line of tall chips");
  const name = rule(".fi-server-switch .fi-server-choice > .fi-server-name");
  for (const d of ["max-width: 160px", "overflow: hidden", "text-overflow: ellipsis"]) assert.ok(name.includes(d), d);
  assert.match(reader, /\{t\("All groups"\)\}/, "the group chips' All says what it is");
});

test("S01: segments in a list at least 360 px wide with up to four servers, a menu otherwise", () => {
  assert.equal(SEGMENTS_MIN_WIDTH, 360);
  const tsx = readFileSync("app/components/inbox/ServerTabs.tsx", "utf8");
  assert.match(tsx, /layout=\{narrow \|\| servers\.length > 4 \? "menu" : "segments"\}/);
});

test("S01: counts are this server's own unread, another's from its read, N+ when that read was full", () => {
  const servers: HeldServer[] = [
    { origin: "https://own.example", label: "Mine", context: null, shown: true },
    { origin: "https://acme.example", label: "Acme", context: null, shown: false },
    { origin: "https://beta.example", label: "Beta", context: null, shown: false },
    { origin: "https://gone.example", label: "Gone", context: null, shown: false },
  ];
  const states: OtherServerState[] = [
    { origin: "https://acme.example", label: "Acme", state: "ok", unread: 50, full: true },
    { origin: "https://beta.example", label: "Beta", state: "ok", unread: 3 },
    { origin: "https://gone.example", label: "Gone", state: "unreachable", unread: null },
  ];
  const counts = switchCounts(servers, states, 7);
  assert.deepEqual(counts["https://own.example"], { n: 7 });
  assert.deepEqual(counts["https://acme.example"], { n: 50, more: true });
  assert.deepEqual(counts["https://beta.example"], { n: 3 });
  assert.equal(counts["https://gone.example"], undefined, "a server not read shows its state, not a count");
  assert.deepEqual(counts.all, { n: 60, more: true }, "All is the sum, a lower bound when any part is");
  assert.deepEqual(switchCounts(servers.slice(0, 1), [], 0).all, { n: 0 });
});
