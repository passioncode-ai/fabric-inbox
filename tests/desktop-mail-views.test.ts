// B-244 D-1 (SCN-093, SCN-099): the mail window keeps one page per server and swaps the visible one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMailViews } = require("../desktop/mail-views.cjs");

const MINE = "https://inbox.owner.example";
const ACME = "https://inbox.acme.example";

function fakeView(name: string) {
  return { name, visible: true, loads: 0, closed: false, webContents: { id: name }, setVisible(v: boolean) { this.visible = v; } };
}
function window() {
  const children: unknown[] = [];
  const closed: unknown[] = [];
  const views = createMailViews({
    attach: (v: unknown) => children.push(v),
    detach: (v: unknown) => children.splice(children.indexOf(v), 1),
    close: (v: { closed: boolean }) => { v.closed = true; closed.push(v); },
  });
  return { views, children, closed };
}

test("a page is added hidden and shown on request; the window holds it as a child", () => {
  const { views, children } = window();
  const mine = views.add(MINE, fakeView("mine"), "persist:mine");
  assert.equal(mine.visible, false);
  assert.deepEqual(children, [mine]);
  assert.equal(views.current(), null);
  assert.equal(views.show(MINE), true);
  assert.equal(mine.visible, true);
  assert.deepEqual(views.current(), { origin: MINE, view: mine, partition: "persist:mine" });
});

test("switching shows the other page and hides the first; both stay alive and nothing is reloaded or closed", () => {
  const { views, children, closed } = window();
  const mine = views.add(MINE, fakeView("mine"));
  const acme = views.add(ACME, fakeView("acme"));
  views.show(MINE);
  views.show(ACME);
  assert.equal(mine.visible, false);
  assert.equal(acme.visible, true);
  views.show(MINE);
  assert.equal(mine.visible, true);
  assert.equal(acme.visible, false);
  assert.equal(views.get(ACME), acme, "the hidden page is kept");
  assert.deepEqual(children.length, 2);
  assert.deepEqual(closed, []);
  assert.equal(mine.loads + acme.loads, 0);
});

test("one page per server; show of a server with no page answers false and changes nothing", () => {
  const { views } = window();
  const mine = views.add(MINE, fakeView("mine"));
  views.show(MINE);
  assert.throws(() => views.add(MINE, fakeView("again")), /already has a page/);
  assert.equal(views.show(ACME), false);
  assert.equal(mine.visible, true);
  assert.equal(views.current()?.origin, MINE);
});

test("a page sending something is known by its server; another page is not", () => {
  const { views } = window();
  const mine = views.add(MINE, fakeView("mine"));
  views.add(ACME, fakeView("acme"));
  assert.equal(views.originOf(mine.webContents), MINE);
  assert.equal(views.originOf({ id: "stranger" }), null);
});

test("dropping a page takes it out of the window and ends it; the shown one leaves nothing shown", () => {
  const { views, children, closed } = window();
  const mine = views.add(MINE, fakeView("mine"), "persist:mine");
  const acme = views.add(ACME, fakeView("acme"), "persist:acme");
  views.show(ACME);
  assert.equal(views.dropPartition("persist:acme"), 1);
  assert.deepEqual(closed, [acme]);
  assert.deepEqual(children, [mine]);
  assert.equal(views.current(), null);
  assert.equal(views.drop(ACME), false);
  views.clear();
  assert.deepEqual(views.origins(), []);
  assert.deepEqual(closed, [acme, mine]);
});

test("a window already gone does not stop a drop", () => {
  const views = createMailViews({ attach() {}, detach() { throw new Error("gone"); }, close() { throw new Error("gone"); } });
  views.add(MINE, fakeView("mine"));
  assert.equal(views.drop(MINE), true);
  assert.deepEqual(views.origins(), []);
});
