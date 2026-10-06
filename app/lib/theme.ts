/**
 * The light/dark theme, kept per device in local storage under the same key the inbox and the
 * root bootstrap read (app/root.tsx). Storage can be unavailable; the theme then lasts the session.
 */
export type Theme = "light" | "dark";
export const THEME_KEY = "fabric-inbox:theme";

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Applies the theme now and tries to keep it; returns false when it could not be kept. */
export function applyTheme(theme: Theme): boolean {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
    return true;
  } catch {
    return false;
  }
}
