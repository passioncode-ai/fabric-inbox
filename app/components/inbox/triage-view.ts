import { englishT, type T } from "../../../shared/i18n";
import { TRIAGE_GROUPS, triage, type Triage, type TriageGroup } from "../../../shared/mail/triage";

export type ListView = "focus" | "newest";
export interface TriageMessage {
  id: string;
  sender: string;
  subject: string;
  read: boolean;
  starred: boolean;
  triage?: Triage;
}
export interface GroupSection<M> {
  id: TriageGroup;
  label: string;
  messages: M[];
  unread: number;
}
export interface FocusSections<M> {
  important: M[];
  groups: GroupSection<M>[];
}

/** The server's triage, or the same rules locally for a response from an older server. */
export function triageOf(message: TriageMessage): Triage {
  return message.triage ?? triage({ sender: message.sender, subject: message.subject, read: message.read, starred: message.starred });
}

/**
 * Focus view (REQ-T2): important mail first, the rest in collapsed groups in a
 * fixed order. Input order (newest first) is kept inside every section; a group
 * filter narrows both parts to that group.
 */
export function focusSections<M extends TriageMessage>(messages: M[], group?: TriageGroup): FocusSections<M> {
  const important: M[] = [];
  const byGroup = new Map<TriageGroup, M[]>();
  for (const message of messages) {
    const t = triageOf(message);
    if (group && t.group !== group) continue;
    if (t.importance === "important") important.push(message);
    else byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), message]);
  }
  const groups = TRIAGE_GROUPS.filter((g) => byGroup.has(g.id)).map((g) => {
    const list = byGroup.get(g.id)!;
    return { id: g.id, label: g.label, messages: list, unread: list.filter((m) => !m.read).length };
  });
  return { important, groups };
}

/** Counts per group over the loaded messages, for the filter chips. */
export function groupCounts(messages: TriageMessage[]): { id: TriageGroup; label: string; count: number; unread: number }[] {
  const counts = new Map<TriageGroup, { count: number; unread: number }>();
  for (const message of messages) {
    const g = triageOf(message).group;
    const c = counts.get(g) ?? { count: 0, unread: 0 };
    c.count++;
    if (!message.read) c.unread++;
    counts.set(g, c);
  }
  return TRIAGE_GROUPS.filter((g) => counts.has(g.id)).map((g) => ({ ...g, ...counts.get(g.id)! }));
}

export function isTriageGroup(value: string | null): value is TriageGroup {
  return !!value && TRIAGE_GROUPS.some((g) => g.id === value);
}

/**
 * The rows as the list shows them, top to bottom: in Focus, Important then each
 * group that is open (every group when a group filter is on); in Newest, the input
 * order, narrowed to the group filter.
 */
export function displayOrder<M extends TriageMessage>(messages: M[], view: ListView, group: TriageGroup | undefined, open: Set<TriageGroup>): M[] {
  if (view === "newest") return group ? messages.filter((m) => triageOf(m).group === group) : messages;
  const { important, groups } = focusSections(messages, group);
  return [...important, ...groups.flatMap((g) => (group || open.has(g.id) ? g.messages : []))];
}

/** After a message leaves the list (archive, trash, move): the one below it, or above when it was last. */
export function nextAfter<M extends { id: string }>(order: M[], id: string): M | null {
  const i = order.findIndex((m) => m.id === id);
  if (i < 0) return null;
  return order[i + 1] ?? order[i - 1] ?? null;
}

/**
 * The opened message keeps the section it was opened in until another one is
 * opened: marking it read would otherwise move it out of Important into a closed
 * group, and the row under the pointer would vanish.
 */
export function pinTriage<M extends TriageMessage>(messages: M[], pinned: { id: string; triage: Triage } | null): M[] {
  if (!pinned) return messages;
  return messages.map((m) => (m.id === pinned.id ? { ...m, triage: pinned.triage } : m));
}

/** A row's date: the time for today, month and day this year, the year for older mail. */
export function listDate(value: string, now = new Date(), t: T = englishT): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return t("Unknown date");
  if (date.toDateString() === now.toDateString()) return t.time(date, { hour: "2-digit", minute: "2-digit" });
  return date.getFullYear() === now.getFullYear()
    ? t.date(date, { month: "short", day: "numeric" })
    : t.date(date, { month: "short", day: "numeric", year: "numeric" });
}
