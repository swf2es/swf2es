// The app's light or dark look: View › Theme, kept in the settings, or
// --theme=system|light|dark for one run. Electron's nativeTheme.themeSource
// takes it, which every window's prefers-color-scheme follows (the pages,
// the element's meter and context menu, the URL dialog), and the native
// title bar and menus where the platform lets it. A SWF's stage keeps its
// own background, which no scheme touches.
import type { MenuItemConstructorOptions } from "electron";

/** nativeTheme.themeSource's values: "system" follows the system's light or dark setting. */
export type Theme = "system" | "light" | "dark";

const THEMES: readonly Theme[] = ["system", "light", "dark"];
const LABELS: Record<Theme, string> = { system: "&System", light: "&Light", dark: "&Dark" };

export function isTheme(value: unknown): value is Theme {
  return THEMES.includes(value as Theme);
}

/**
 * --theme's value from `argv`, the last given winning, or null for none; an error for one that
 * does not read.
 */
export function themeArgument(
  argv: readonly string[],
): { theme: Theme | null } | { error: string } {
  let theme: Theme | null = null;
  for (const arg of argv) {
    const match = /^--theme(=(.*))?$/i.exec(arg);
    if (!match) {
      continue;
    }

    const value = (match[2] ?? "").trim().toLowerCase();
    if (!isTheme(value)) {
      return {
        error: `--theme takes system, light or dark, as --theme=dark, not ${JSON.stringify(match[2] ?? "")}`,
      };
    }

    theme = value;
  }

  return { theme };
}

/** What stderr says of --theme as the app starts: for this run, the settings' choice kept. */
export function themeNotice(override: Theme, saved: Theme): string {
  const name = (theme: Theme) => (theme === "system" ? "the system's" : theme);
  return `swf2es: --theme: ${name(override)} theme for this run; the saved theme (${name(saved)}) is kept for the next run`;
}

/** The View menu's Theme submenu: `current` checked, `choose` given the one picked. */
export function themeMenu(
  current: Theme,
  choose: (theme: Theme) => void,
): MenuItemConstructorOptions {
  return {
    id: "theme",
    label: "&Theme",
    submenu: THEMES.map((theme) => ({
      id: `theme-${theme}`,
      label: LABELS[theme],
      type: "radio" as const,
      checked: theme === current,
      click: () => choose(theme),
    })),
  };
}

/**
 * What a window shows before its page draws: the page's own Canvas colour, Chromium's for the
 * scheme, so a dark window does not flash white as it opens.
 */
export function windowBackground(dark: boolean): string {
  return dark ? "#121212" : "#ffffff";
}
