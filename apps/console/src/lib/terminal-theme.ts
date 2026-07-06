import type { ITheme } from "@xterm/xterm";
import type { Theme } from "@/providers/theme";

/**
 * xterm theme derived from the Graphite & Alabaster tokens (see
 * apps/console/design/theme-candidates.md — "Terminal Palette"). Keeps the
 * terminal visually part of the app in both light and dark mode, instead of
 * the previous hardcoded near-black chrome that clashed with a light app.
 */
const DARK_THEME: ITheme = {
  background: "#22201f", // --card
  foreground: "#ededec", // --foreground
  cursor: "#ededec",
  cursorAccent: "#141312",
  selectionBackground: "#2d2b2a", // --elevated
  black: "#2d2b2a",
  brightBlack: "#706d6b",
  red: "#c45a5a",
  brightRed: "#d77b7b",
  green: "#2d8a66",
  brightGreen: "#4ca882",
  yellow: "#d48d3a",
  brightYellow: "#e7ab62",
  blue: "#6b8bbe",
  brightBlue: "#8daadd",
  magenta: "#9d76b1",
  brightMagenta: "#bb98cd",
  cyan: "#599b9a",
  brightCyan: "#7abdbd",
  white: "#ededec",
  brightWhite: "#ffffff",
};

const LIGHT_THEME: ITheme = {
  background: "#fcfcfb", // --card
  foreground: "#141312", // --foreground
  cursor: "#141312",
  cursorAccent: "#fcfcfb",
  selectionBackground: "#f5f4f1",
  black: "#141312",
  brightBlack: "#706d6b",
  red: "#a64444",
  brightRed: "#c45a5a",
  green: "#287a5b",
  brightGreen: "#2d8a66",
  yellow: "#b5752e",
  brightYellow: "#d48d3a",
  blue: "#5072a8",
  brightBlue: "#6b8bbe",
  magenta: "#8a6499",
  brightMagenta: "#9d76b1",
  cyan: "#4a8483",
  brightCyan: "#599b9a",
  white: "#e5e3e0",
  brightWhite: "#ffffff",
};

export function terminalTheme(theme: Theme): ITheme {
  return theme === "light" ? LIGHT_THEME : DARK_THEME;
}
