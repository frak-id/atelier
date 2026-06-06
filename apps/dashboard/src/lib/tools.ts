import { Bot, Globe, type LucideIcon, Monitor, Terminal } from "lucide-react";

export type ToolTab = "opencode" | "vscode" | "terminal" | "web";

export interface ToolUi {
  icon: LucideIcon;
  tab: ToolTab;
  urlSuffix?: string;
}

const TOOL_UI: Record<string, ToolUi> = {
  opencode: { icon: Bot, tab: "opencode" },
  vscode: { icon: Monitor, tab: "vscode" },
  terminal: { icon: Terminal, tab: "terminal" },
  browser: {
    icon: Globe,
    tab: "web",
    urlSuffix: "/?autoconnect=true&resize=remote",
  },
};

const TOOL_ORDER = ["opencode", "vscode", "terminal", "browser"];

export function toolUiFor(slug: string): ToolUi {
  return TOOL_UI[slug] ?? { icon: Globe, tab: "web" };
}

export function sortToolsForDisplay<T extends { slug: string }>(
  tools: T[],
): T[] {
  const index = (slug: string) => {
    const i = TOOL_ORDER.indexOf(slug);
    return i === -1 ? TOOL_ORDER.length : i;
  };
  return [...tools].sort((a, b) => index(a.slug) - index(b.slug));
}
