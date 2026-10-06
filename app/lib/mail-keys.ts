// The message list's keyboard (operator, 2026-10-06; board B-25): Delete or Backspace archives and
// marks read; with ⌘ on a Mac (Ctrl elsewhere) it discards; arrows and j/k move, Shift extends a
// selection; ⌘Z undoes the last of these; ? shows the help; ⌘⇧N (Ctrl+Shift+N) checks for new mail.
// ⌘R is not used: it is the desktop menu's Retry connection, which reloads the window
// (desktop/main.cjs installMenu); ⌘⇧N is Apple Mail's own "Get All New Mail".
// Nothing fires while the person types, and no combination that is not listed here does anything.

export type MailKey = "archive" | "discard" | "next" | "previous" | "extendNext" | "extendPrevious" | "undo" | "help" | "refresh" | "clear";

/** What the handler reads of an element: enough to tell a field from a message row. */
export interface KeyTarget {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  role?: string | null;
  getAttribute?(name: string): string | null;
  closest?(selector: string): unknown;
}
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  target?: KeyTarget | null;
}

/** Inputs that are not typed into: a key on them is still the list's. */
const NOT_TYPED = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/** Whether a key on this element is the person typing (a field, an editor, a text box). */
export function isTypingTarget(target: KeyTarget | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NOT_TYPED.has((target.type ?? "text").toLowerCase());
  if (target.isContentEditable) return true;
  const role = target.role ?? target.getAttribute?.("role");
  if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
  return !!target.closest?.('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]');
}

/** A Mac (⌘ is the command key) by the browser's own platform. */
export function isMacPlatform(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  const platform = nav?.userAgentData?.platform || nav?.platform || "";
  return /mac|iphone|ipad/i.test(platform);
}

/** The action a key press means in the mail list, or null when it means nothing here. */
export function mailKeyAction(e: KeyLike, mac: boolean): MailKey | null {
  if (e.isComposing || isTypingTarget(e.target)) return null;
  const command = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  const key = e.key;
  if (key === "Backspace" || key === "Delete") {
    if (plain && !e.shiftKey) return "archive";
    if (command && !e.altKey && !e.shiftKey) return "discard";
    return null;
  }
  if (command && !e.altKey && !e.shiftKey && key.toLowerCase() === "z") return "undo";
  if (command && !e.altKey && e.shiftKey && key.toLowerCase() === "n") return "refresh";
  if (!plain) return null;
  if (key === "?") return "help";
  if (key === "Escape" && !e.shiftKey) return "clear";
  if (key === "ArrowDown" || key.toLowerCase() === "j") return e.shiftKey ? "extendNext" : "next";
  if (key === "ArrowUp" || key.toLowerCase() === "k") return e.shiftKey ? "extendPrevious" : "previous";
  return null;
}

/** The help's words, in one table for the localization that follows (key names stay as keys are labelled). */
export const SHORTCUT_TEXT = {
  title: "Keyboard shortcuts",
  close: "Close keyboard shortcuts",
  or: " or ",
  footnote: "Keys do nothing while you type in a field or the composer.",
  move: "Move", act: "Act", help: "Help",
  next: "Next message",
  previous: "Previous message",
  extend: "Select the next or previous message too",
  several: "Select several messages",
  clear: "Clear the selection",
  archive: "Archive and mark read",
  discard: "Discard: out of the inbox, kept in Discarded for 30 days; future mail like it goes there too",
  undo: "Undo the last archive or discard",
  refresh: "Check for new mail",
  show: "Show these shortcuts",
  click: "click",
};

/** The Keyboard shortcuts help, with the keys spelled as the platform spells them. */
export function shortcutList(mac: boolean): { title: string; keys: { keys: string[]; does: string }[] }[] {
  const T = SHORTCUT_TEXT;
  return [
    { title: T.move, keys: [
      { keys: ["↓", "J"], does: T.next },
      { keys: ["↑", "K"], does: T.previous },
      { keys: ["Shift ↓", "Shift ↑"], does: T.extend },
      { keys: [mac ? `⌘-${T.click}` : `Ctrl+${T.click}`, `Shift-${T.click}`], does: T.several },
      { keys: ["Esc"], does: T.clear },
    ] },
    { title: T.act, keys: [
      { keys: mac ? ["⌫", "⌦"] : ["Backspace", "Delete"], does: T.archive },
      { keys: mac ? ["⌘⌫", "⌘⌦"] : ["Ctrl+Backspace", "Ctrl+Delete"], does: T.discard },
      { keys: [mac ? "⌘Z" : "Ctrl+Z"], does: T.undo },
      { keys: [mac ? "⌘⇧N" : "Ctrl+Shift+N"], does: T.refresh },
    ] },
    { title: T.help, keys: [{ keys: ["?"], does: T.show }] },
  ];
}
