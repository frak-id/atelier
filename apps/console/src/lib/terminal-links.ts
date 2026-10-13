const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/**
 * Whether a click on a terminal link should open it. Like iTerm2, Ghostty
 * and VS Code, a plain click is not enough: it belongs to text selection
 * and, in fullscreen TUIs, to the app (pi turns a drag into a selection).
 * Cmd on macOS, Ctrl elsewhere.
 */
function isOpenLinkClick(event: MouseEvent, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/** The URL to open, or `null` for anything but http(s). */
function webUrl(uri: string): string | null {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Satisfies both xterm's `ILinkHandler` (OSC 8) and the `WebLinksAddon`
 * callback + options, whose signatures differ only by trailing arguments.
 */
interface TerminalLinkHandler {
  activate(event: MouseEvent, uri: string): void;
  hover(event: MouseEvent, uri: string): void;
  leave(): void;
}

/**
 * One handler for both link sources: plain-text URLs (`WebLinksAddon`) and
 * OSC 8 hyperlinks (xterm's `linkHandler` option). Hovering shows the target
 * as a tooltip on `element`, since an OSC 8 link's text need not be its URL.
 */
export function createTerminalLinkHandler(
  element: HTMLElement,
  open: (url: string) => void = (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  mac = IS_MAC,
): TerminalLinkHandler {
  const hint = mac ? "⌘-click to open" : "Ctrl-click to open";
  return {
    activate(event, uri) {
      if (!isOpenLinkClick(event, mac)) return;
      const url = webUrl(uri);
      if (url) open(url);
    },
    hover(_event, uri) {
      element.title = `${uri}\n${hint}`;
    },
    leave() {
      element.removeAttribute("title");
    },
  };
}
