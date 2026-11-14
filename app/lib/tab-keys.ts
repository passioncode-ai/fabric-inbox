/**
 * The keys of a horizontal tab list (WAI-ARIA Authoring Practices, Tabs): Left and Right move to
 * the previous and next tab and wrap at either end, Home and End go to the first and the last.
 * Answers the tab to select and focus, or null when the key moves nothing.
 */
export function tabAfterKey<T extends string>(tabs: readonly T[], current: T, key: string): T | null {
  const at = tabs.indexOf(current);
  if (at < 0 || tabs.length === 0) return null;
  switch (key) {
    case "ArrowRight": return tabs[(at + 1) % tabs.length];
    case "ArrowLeft": return tabs[(at - 1 + tabs.length) % tabs.length];
    case "Home": return tabs[0];
    case "End": return tabs[tabs.length - 1];
    default: return null;
  }
}
