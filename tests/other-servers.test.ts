// B-244 D-3 (SCN-099): the merged list of the servers the app holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { interleave, readOtherInbox, readServers, type OtherRow } from "../app/lib/other-servers";

const row = (at: number, link = "/m/" + at): OtherRow => ({ origin: "https://inbox.acme.example", server: "Acme", sender: "a@acme.example", to: "", subject: "s", snippet: "", at, read: false, link });
const own = [{ id: "a", at: 100 }, { id: "b", at: 80 }, { id: "c", at: 60 }];
const ids = (list: ReturnType<typeof interleave<{ id: string; at: number }>>) => list.map((x) => (x.kind === "own" ? x.item.id : "o" + x.row.at));

test("the other servers' rows go in newest first among this server's messages", () => {
  assert.deepEqual(ids(interleave(own, (m) => m.at, [row(90), row(110), row(70)], false)), ["o110", "a", "o90", "b", "o70", "c"]);
});

test("rows older than the loaded mail wait for older pages; with every page loaded they all show", () => {
  assert.deepEqual(ids(interleave(own, (m) => m.at, [row(50), row(95)], false)), ["a", "o95", "b", "c"]);
  assert.deepEqual(ids(interleave(own, (m) => m.at, [row(50), row(95)], true)), ["a", "o95", "b", "c", "o50"]);
});

test("with no mail of its own, the list is the other servers' mail; with none of theirs, this server's alone", () => {
  assert.deepEqual(ids(interleave([], (m: { id: string; at: number }) => m.at, [row(1), row(3)], false)), ["o3", "o1"]);
  assert.deepEqual(ids(interleave(own, (m) => m.at, [], false)), ["a", "b", "c"]);
});

test("this server's own order is kept as it is (a pinned message stays first)", () => {
  const pinned = [{ id: "old-pinned", at: 10 }, ...own];
  assert.deepEqual(ids(interleave(pinned, (m) => m.at, [row(90)], false)), ["old-pinned", "a", "o90", "b", "c"]);
});

test("what the bridge answers is kept to well-formed servers and rows; a link that is not a path is dropped", () => {
  assert.deepEqual(readServers([{ origin: "https://a.example", label: "A", context: "personal", shown: true }, { origin: 3 }, null]),
    [{ origin: "https://a.example", label: "A", context: "personal", shown: true }]);
  assert.deepEqual(readServers("nope"), []);
  const inbox = readOtherInbox({
    servers: [{ origin: "https://b.example", label: "B", state: "signed_out", unread: null }, { origin: "https://c.example", label: "C", state: "weird" }],
    messages: [row(5), { ...row(6), link: "https://evil.example/" }, { ...row(7), at: "x" }],
  });
  assert.deepEqual(inbox.servers.map((s) => s.state), ["signed_out"]);
  assert.deepEqual(inbox.messages.map((m) => m.at), [5]);
  assert.deepEqual(readOtherInbox(undefined), { servers: [], messages: [] });
});
