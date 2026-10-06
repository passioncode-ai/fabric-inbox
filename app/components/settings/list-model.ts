/**
 * The list half of every Settings section, as plain functions: what a search keeps, which group a
 * row sits in, and where the arrow keys go. The audit behind it (2026-10-06) found the page jumping
 * because rows moved between groups when their state changed; here a row keeps the group it was
 * first shown in for as long as the section is open, and only its badge says what changed.
 *
 * Plain module, no `~/` imports: the tests load it directly.
 */

export interface ListEntry {
  /** Stable identity: the selection in the address bar. */
  key: string;
  /** The group the row belongs to by its current state. */
  group: string;
  /** Text a search looks in (lower-cased here). */
  text: string;
}

export interface ListGroup<T extends ListEntry> {
  id: string;
  label: string;
  rows: T[];
}

/** Every word of the query must appear somewhere in the row; an empty query keeps everything. */
export function matches(entry: Pick<ListEntry, "text">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = entry.text.toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * The group each row is shown in: the one it had when the section first showed it. `seen` is
 * updated in place with every row seen for the first time, so it lives in a ref for the section's
 * lifetime. A row that left and came back keeps its first group too.
 */
export function stableGroup<T extends ListEntry>(seen: Map<string, string>, entries: readonly T[]): T[] {
  return entries.map((entry) => {
    const first = seen.get(entry.key);
    if (first === undefined) {
      seen.set(entry.key, entry.group);
      return entry;
    }
    return first === entry.group ? entry : { ...entry, group: first };
  });
}

/**
 * Rows in the order of `groups`, each group keeping the rows' own order; empty groups are left
 * out. A row whose group is not named goes into the last group rather than disappearing.
 */
export function groupRows<T extends ListEntry>(entries: readonly T[], groups: readonly { id: string; label: string }[]): ListGroup<T>[] {
  if (!groups.length) return [];
  const known = new Set(groups.map((g) => g.id));
  const last = groups[groups.length - 1]!.id;
  return groups
    .map((g) => ({ id: g.id, label: g.label, rows: entries.filter((e) => (known.has(e.group) ? e.group : last) === g.id) }))
    .filter((g) => g.rows.length > 0);
}

/**
 * A search never hides the selected row: it stays in its place, so the panel beside it and the
 * row the person is working on never disappear while they type.
 */
export function visibleRows<T extends ListEntry>(entries: readonly T[], query: string, selected: string | null): T[] {
  return entries.filter((e) => e.key === selected || matches(e, query));
}

export type ListKey = "ArrowDown" | "ArrowUp" | "Home" | "End";
export const LIST_KEYS: readonly string[] = ["ArrowDown", "ArrowUp", "Home", "End"];

/** Where focus goes in a list of `length` rows; it stops at either end rather than wrapping. */
export function nextIndex(current: number, key: ListKey, length: number): number {
  if (length <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (current < 0) return key === "ArrowUp" ? length - 1 : 0;
  return key === "ArrowDown" ? Math.min(length - 1, current + 1) : Math.max(0, current - 1);
}

/** "3 addresses", "1 address": counts are written out, never "address(es)". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
