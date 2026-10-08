// The message list's keyboard (operator, 2026-10-06; board B-25): Delete or Backspace archives and
// marks read; with ⌘ on a Mac (Ctrl elsewhere) it discards; arrows and j/k move, Shift extends a
// selection; ⌘Z undoes the last of these; ? shows the help; ⌘⇧N (Ctrl+Shift+N) checks for new mail.
// Escape clears the selection — but first it cancels an inline confirmation that is open
// (escapeCancelsConfirmation, board B-8-02: Spam's Delete all, the sidebar's Hide them).
// ⌘R is not used: it is the desktop menu's Retry connection, which reloads the window
// (desktop/main.cjs installMenu); ⌘⇧N is Apple Mail's own "Get All New Mail".
// Nothing fires while the person types, and no combination that is not listed here does anything.

import { englishT, type T } from "../../shared/i18n";

export type MailKey ="archive" | "discard" | "next" | "previous" | "extendNext" | "extendPrevious" | "undo" | "help" | "refresh" | "clear";

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

/**
 * Escape with no modifiers, not while typing: an inline confirmation that is open cancels itself
 * (on a capture listener, before the list's own keydown clears the selection).
 */
export function escapeCancelsConfirmation(e: KeyLike): boolean {
  return e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing && !isTypingTarget(e.target);
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

/** The help's words in the interface's language (key names stay as keys are labelled). */
export function shortcutText(t: T) {
  return {
    title: t("Keyboard shortcuts"),
    close: t("Close keyboard shortcuts"),
    or: t(" or "),
    footnote: t("Keys do nothing while you type in a field or the composer."),
    move: t("Move"), act: t("Act"), help: t("Help"),
    next: t("Next message"),
    previous: t("Previous message"),
    extend: t("Select the next or previous message too"),
    several: t("Select several messages"),
    clear: t("Clear the selection"),
    archive: t("Archive and mark read"),
    discard: t("Discard: out of the inbox, kept in Discarded for 30 days; future mail like it goes there too"),
    undo: t("Undo the last archive or discard"),
    refresh: t("Check for new mail"),
    show: t("Show these shortcuts"),
    commandClick: t("⌘-click"),
    controlClick: t("Ctrl+click"),
    shiftClick: t("Shift-click"),
  };
}
/** The English table: what tests read. */
export const SHORTCUT_TEXT = shortcutText(englishT);

/** The Keyboard shortcuts help, with the keys spelled as the platform spells them. */
export function shortcutList(mac: boolean, t: T = englishT): { title: string; keys: { keys: string[]; does: string }[] }[] {
  const T = shortcutText(t);
  return [
    { title: T.move, keys: [
      { keys: ["↓", "J"], does: T.next },
      { keys: ["↑", "K"], does: T.previous },
      { keys: ["Shift ↓", "Shift ↑"], does: T.extend },
      { keys: [mac ? T.commandClick : T.controlClick, T.shiftClick], does: T.several },
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
