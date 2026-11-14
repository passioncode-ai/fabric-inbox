// B-263, B-266, S01 (B-267): the mail list's server switch sits in the list heading as one line; it never wraps into
// tall ovals; its counts say when they are a lower bound; segments up to four servers in a wide enough list, else a menu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { switchCounts, tabsLayout, SEGMENTS_MAX_SERVERS } from "../app/components/inbox/ServerTabs";
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

test("S01, A-13: segments whenever they fit whole beside the folder's name, up to four servers; a menu otherwise", () => {
  assert.equal(SEGMENTS_MAX_SERVERS, 4);
  // The default window (1400x900, measured in WebKit): the list column is 350 px; its padding, "Inbox" and the gap leave
  // 265 px. All 54+, My space, Acme 50+ and Beta 4, in the heading's tighter segments, measure 255 px: segments.
  assert.equal(tabsLayout(3, 255, 265), "segments", "three servers in the default list column show segments");
  assert.equal(tabsLayout(2, 170, 265), "segments");
  assert.equal(tabsLayout(3, 230, null), "segments", "until measured (the first paint) the segments are drawn");
  assert.equal(tabsLayout(3, 420, 265), "menu", "long names that do not fit whole take the menu");
  assert.equal(tabsLayout(4, 300, 300), "segments", "an exact fit is a fit");
  assert.equal(tabsLayout(5, 200, 900), "menu", "five or more servers are always a menu");
  const tsx = readFileSync("app/components/inbox/ServerTabs.tsx", "utf8");
  assert.match(tsx, /layout=\{tabsLayout\(servers\.length, size\?\.natural \?\? null, size\?\.available \?\? null\)\}/);
  assert.match(tsx, /className="fi-server-tabs-measure" aria-hidden="true" inert/, "the measured copy is out of reach");
  assert.match(css, /\.fi-list-heading \.fi-server-switch-segments \.fi-server-choice \{ padding: 0 7px; gap: 3px; \}/, "the heading's segments are tighter");
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
