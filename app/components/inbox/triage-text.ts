// Every user-facing string of the triage keys, Discarded and the Undo toast in one place, built in
// the interface's language (Russian: Discarded = «Выброшенные», shared/i18n/ru/inbox.ts). Plain
// module: the tests and the components read it. Wording: docs/brand/strings.md.
import { englishT, type T } from "../../../shared/i18n";

export function triageText(t: T) {
  return {
    folder: t("Discarded"),
    emptyTitle: t("Nothing discarded"),
    emptyBody: t("Discard a message with ⌘⌫ (Ctrl+Backspace) and it waits here 30 days; mail like it comes here on its own after that."),
    banner: t("Discarded mail is deleted after 30 days (in Gmail, IMAP and Outlook accounts it moves to their Trash). Nothing here reaches an agent, a rule or a category."),
    bannerLink: t("Discard rules"),
    whyDiscarded: t("Why discarded:"),
    discardButton: t("Discard message"),
    discardTitle: (key: string) => t("Discard: out of the inbox, and mail like it from now on ({key})", { key }),
    archiveTitle: (key: string) => t("Archive and mark read ({key})", { key }),
    notDiscarded: t("Not discarded"),
    notDiscardedTitle: t("Not discarded: back to the inbox"),
    backInInbox: t("Back in the inbox."),
    stillDiscarding: (labels: string) => t("Back in the inbox. Future mail from {labels} still goes to Discarded.", { labels }),
    stopDiscarding: t("Stop discarding mail like this"),
    ruleRemoved: (label?: string) => label
      ? t("Mail from {label} will not be discarded on its own. Discarded mail stays where it is.", { label })
      : t("Mail like this will not be discarded on its own. Discarded mail stays where it is."),
    ruleNotRemoved: (error: string) => t("The rule could not be removed: {error} Remove it in Settings → Discard rules.", { error: t.text(error) }),
    selected: (n: number) => t("{n} selected", { n }),
    selectedTitle: (n: number) => t.plural(n, { one: "{n} message selected", other: "{n} messages selected" }),
    selectedBody: t("Act on all of them at once, or press Esc to clear the selection."),
    archive: t("[action] Archive"),
    discard: t("Discard"),
    clearSelection: t("Clear selection"),
    shortcutsNav: t("Keyboard shortcuts"),
    undo: t("Undo"),
    undoing: t("Undoing…"),
    undone: (n: number) => (n === 1 ? t("Undone.") : t.plural(n, { one: "Undone: {n} message is back.", other: "Undone: {n} messages are back." })),
    undoFailed: (restored: number, failed: number, first: string) => restored
      ? t("{restored} came back; {failed} could not: {error}", { restored, failed, error: t.text(first) })
      : t("{failed} could not: {error}", { failed, error: t.text(first) }),
    dont: t("Don't"),
    dismiss: t("Dismiss"),
    // What an action did (triage-actions.ts): "Archived", "3 messages discarded".
    done: (kind: "archive" | "discard", n: number) => kind === "archive"
      ? t.plural(n, { one: "Archived", other: "{n} messages archived" })
      : t.plural(n, { one: "Discarded", other: "{n} messages discarded" }),
    someFailed: (done: string, n: number, first: string) => t("{done}; {n} could not be: {error}", { done, n, error: t.text(first) }),
    futureMail: (who: string) => t("Future mail from {who} will go to Discarded.", { who }),
    andOthers: (first: string, more: number) => t.plural(more, { one: "{first} and {n} other", other: "{first} and {n} others" }, { first }),
    and: (a: string, b: string) => t("{a} and {b}", { a, b }),
    notDiscardedAny: t("It could not be discarded"),
    notRestored: t("It could not be brought back"),
    // Why an action cannot be done here (triage-actions.ts canAct).
    alreadyArchived: t("It is already archived."),
    archiveInboxOnly: t("Archive works on mail in the inbox; use the buttons above the message here."),
    noArchiveFolder: t("This account has no Archive folder; discard or trash it instead."),
    alreadyDiscarded: t("It is already discarded."),
    sentNotDiscardable: t("Mail in Sent is yours: it cannot be discarded."),
  } as const;
}

export type TriageText = ReturnType<typeof triageText>;
/** The English table: what tests and plain modules without a translator read. */
export const TRIAGE_TEXT: TriageText = triageText(englishT);
