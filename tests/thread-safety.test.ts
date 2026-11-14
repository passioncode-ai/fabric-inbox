// A-11 (S02, S03, S04): every cell of a conversation carries its own safety colour and checked links, not only the
// open one; a cell with no record (or one checked against an older phishing list) is checked as the open one is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCheck } from "../workers/safety/verdict";
import { threadCellSafety, CELL_CHECKS } from "../app/components/inbox/thread-safety";
import type { MailCheck, SafetyLikeRecord } from "../shared/mail/safety";
import type { SafetyFindings } from "../workers/safety/check";

const findings = (extra: Partial<SafetyFindings> = {}): SafetyFindings => ({ visibleStrong: [], hiddenSignals: [], hidden: "", model: false, ...extra });
const auth = { key: "Authentication-Results", value: "mx.cloudflare.net; dkim=pass header.d=acme.example; dmarc=pass header.from=acme.example policy.dmarc=reject; spf=pass" };
const check = (version: number, over: Partial<Parameters<typeof buildCheck>[0]> = {}): MailCheck => buildCheck({
  provider: "cloudflare", headers: [auth], from: "Ann <ann@acme.example>", replyTo: null, ownDomains: ["owner.example"],
  findings: findings(), links: [{ url: "https://acme.example/", host: "acme.example" }], linksCapped: false,
  feed: { version, state: "fresh" }, files: [], scope: "received", contentHash: "h", now: 1, ...over,
});
const rec = (c: MailCheck, extra: Partial<SafetyLikeRecord["findings"]> = {}): SafetyLikeRecord => ({ state: "clear", decidedBy: "check", findings: { ...findings(), ...extra, check: c } });

test("A-11: each cell's colour and links come from its own record; missing and stale ones are checked, at most the cap", async () => {
  const account = "cloudflare:Hello@owner.example";
  const key = (id: string) => `cloudflare:hello@owner.example|${id}`;
  const looked = {
    feedVersion: 7,
    records: {
      [key("clean")]: rec(check(7)),
      [key("phish")]: rec(check(7), { phishing: [{ host: "x.example" }] }),
      [key("old")]: rec(check(6)),
    },
  };
  const asked: string[] = [];
  const cells = await threadCellSafety(account, ["clean", "phish", "old", "none", "fails"], looked, async (id) => {
    asked.push(id);
    if (id === "fails") throw new Error("offline");
    return { record: rec(check(7)), feedVersion: 7 };
  });
  assert.deepEqual(asked.sort(), ["fails", "none", "old"], "only a missing or stale record is checked");
  assert.equal(cells.clean!.colour.colour, "green", "a clean cell with a current record is green: its checked links open");
  assert.equal(cells.clean!.links[0]!.url, "https://acme.example/", "a cell's links are its own record's");
  assert.equal(cells.phish!.colour.colour, "red", "a dangerous cell is red, not grey");
  assert.equal(cells.old!.colour.linksComplete, true, "a stale record checked again counts the current list");
  assert.equal(cells.fails!.colour.label, "notChecked", "a check that fails leaves the cell grey: its links ask");
  // A lookup the server could not answer checks nothing; a long thread is checked up to the cap.
  assert.deepEqual(Object.keys(await threadCellSafety(account, ["a"], { unavailable: true }, async () => { throw new Error("no"); })), ["a"]);
  let n = 0;
  await threadCellSafety(account, Array.from({ length: 30 }, (_, i) => `m${i}`), { records: {} }, async () => { n++; return null; });
  assert.equal(n, CELL_CHECKS);
});

test("A-11: the conversation passes each cell its colour, marks amber and red cells with their word", () => {
  const list = readFileSync("app/components/inbox/ConversationList.tsx", "utf8");
  assert.match(list, /linkSafety=\{safety \?\? \(cellSafetyPending \? "pending" : null\)\}/);
  assert.match(list, /\{!open && safety && <CellMark colour=\{safety\.colour\} \/>\}/);
  assert.match(list, /badgeWords\(colour\.label, t\)/, "the mark says its word, never colour alone");
});
