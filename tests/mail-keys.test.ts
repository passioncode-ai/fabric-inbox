import { test } from "node:test";
import assert from "node:assert/strict";
import { isMacPlatform, isTypingTarget, mailKeyAction, shortcutList, type KeyLike } from "../app/lib/mail-keys";

// Keyboard actions in the message list and the open message (operator, 2026-10-06): Delete or
// Backspace archives and marks read; with ⌘ (Ctrl elsewhere) it discards. Never while typing, and
// never for a combination nobody defined.
const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("Delete or Backspace alone archives; with ⌘ on a Mac (Ctrl elsewhere) it discards", () => {
  for (const k of ["Backspace", "Delete"]) {
    assert.equal(mailKeyAction(key(k), true), "archive");
    assert.equal(mailKeyAction(key(k), false), "archive");
    assert.equal(mailKeyAction(key(k, { metaKey: true }), true), "discard");
    assert.equal(mailKeyAction(key(k, { ctrlKey: true }), false), "discard");
    assert.equal(mailKeyAction(key(k, { ctrlKey: true }), true), null, "Ctrl on a Mac is not the discard key");
    assert.equal(mailKeyAction(key(k, { metaKey: true }), false), null, "the Windows key elsewhere is not either");
    assert.equal(mailKeyAction(key(k, { altKey: true }), true), null, "Alt is not defined");
    assert.equal(mailKeyAction(key(k, { shiftKey: true }), true), null, "Shift is not defined");
    assert.equal(mailKeyAction(key(k, { metaKey: true, shiftKey: true }), true), null);
    assert.equal(mailKeyAction(key(k, { metaKey: true, ctrlKey: true }), true), null);
  }
});

test("moving in the list: arrows and j/k, Shift extends the selection; Escape clears it", () => {
  assert.equal(mailKeyAction(key("ArrowDown"), true), "next");
  assert.equal(mailKeyAction(key("j"), true), "next");
  assert.equal(mailKeyAction(key("ArrowUp"), true), "previous");
  assert.equal(mailKeyAction(key("k"), true), "previous");
  assert.equal(mailKeyAction(key("ArrowDown", { shiftKey: true }), true), "extendNext");
  assert.equal(mailKeyAction(key("J", { shiftKey: true }), true), "extendNext");
  assert.equal(mailKeyAction(key("K", { shiftKey: true }), true), "extendPrevious");
  assert.equal(mailKeyAction(key("ArrowDown", { metaKey: true }), true), null, "⌘↓ belongs to the system");
  assert.equal(mailKeyAction(key("j", { ctrlKey: true }), false), null);
  assert.equal(mailKeyAction(key("Escape"), true), "clear");
});

test("Undo is ⌘Z (Ctrl+Z elsewhere); the help is ?; Refresh is ⌘⇧N (Ctrl+Shift+N), clear of the menu's ⌘R", () => {
  assert.equal(mailKeyAction(key("z", { metaKey: true }), true), "undo");
  assert.equal(mailKeyAction(key("z", { ctrlKey: true }), false), "undo");
  assert.equal(mailKeyAction(key("z", { metaKey: true, shiftKey: true }), true), null, "⌘⇧Z (redo) is not defined");
  assert.equal(mailKeyAction(key("?", { shiftKey: true }), true), "help");
  assert.equal(mailKeyAction(key("?"), false), "help");
  assert.equal(mailKeyAction(key("N", { metaKey: true, shiftKey: true }), true), "refresh");
  assert.equal(mailKeyAction(key("n", { ctrlKey: true, shiftKey: true }), false), "refresh");
  assert.equal(mailKeyAction(key("r", { metaKey: true }), true), null, "⌘R stays the desktop menu's Retry connection");
  assert.equal(mailKeyAction(key("n"), true), null);
});

test("nothing fires while typing, or while an input method composes", () => {
  assert.equal(mailKeyAction(key("Backspace", { target: { tagName: "INPUT", type: "text" } }), true), null);
  assert.equal(mailKeyAction(key("Delete", { metaKey: true, target: { tagName: "TEXTAREA" } }), true), null);
  assert.equal(mailKeyAction(key("j", { target: { tagName: "DIV", isContentEditable: true } }), true), null);
  assert.equal(mailKeyAction(key("Backspace", { target: { tagName: "SELECT" } }), true), null);
  assert.equal(mailKeyAction(key("Backspace", { isComposing: true }), true), null);
  assert.equal(mailKeyAction(key("Backspace", { target: { tagName: "BUTTON" } }), true), "archive", "a focused message row is a button, and it counts");
  assert.equal(mailKeyAction(key("Backspace", { target: { tagName: "INPUT", type: "checkbox" } }), true), "archive");
  assert.ok(isTypingTarget({ tagName: "DIV", role: "textbox" }));
  assert.ok(isTypingTarget({ tagName: "SPAN", closest: (s: string) => (s.includes("contenteditable") ? {} : null) }));
  assert.ok(!isTypingTarget(null));
});

test("the platform is read from the browser, and the help names keys the way the platform does", () => {
  assert.equal(isMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(isMacPlatform({ userAgentData: { platform: "macOS" } }), true);
  assert.equal(isMacPlatform({ platform: "Win32" }), false);
  assert.equal(isMacPlatform(undefined), false);
  const mac = shortcutList(true).flatMap((g) => g.keys);
  assert.ok(mac.some((k) => k.keys.includes("⌘⌫") && /Discard/.test(k.does)));
  assert.ok(mac.some((k) => k.keys.includes("⌘⇧N")));
  const other = shortcutList(false).flatMap((g) => g.keys);
  assert.ok(other.some((k) => k.keys.includes("Ctrl+Backspace")));
  assert.ok(other.some((k) => k.keys.includes("Ctrl+Z")));
});
