import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { type IProgressState, ProgressAddon } from "@xterm/addon-progress";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { wsUrl } from "@/lib/api-base";
import { createTerminalLinkHandler } from "@/lib/terminal-links";
import { terminalTheme } from "@/lib/terminal-theme";
import { cn } from "@/lib/utils";
import { useTheme } from "@/providers/theme";

/**
 * Writes a labeled divider line into the terminal's own scrollback — a real,
 * honest "block" boundary rather than a guessed one. There is no
 * command/output boundary signal anywhere in this stack (no OSC 133 shell
 * integration, no structured server event; see IMPLEMENTATION_PLAN.md §5.3),
 * so this deliberately does NOT try to detect commands by regex-guessing
 * prompts on raw output — that would misfire constantly and undermine the
 * calm, audit-trail feel it's meant to convey. Markers are either explicit
 * (the caller's "Mark" action, via the imperative handle below) or tied to a
 * real lifecycle event (reconnect).
 */
function writeMarker(terminal: Terminal, label: string) {
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  terminal.writeln(`\r\n\x1b[2m── ${label} · ${time} ──\x1b[0m`);
}

export interface TerminalViewHandle {
  /** Insert a labeled divider at the current scrollback position. */
  mark: () => void;
}

/** Progress an app reports with OSC 9;4 (`state` 0 = none, 1 = percent,
 * 2 = error, 3 = indeterminate, 4 = paused; `value` 0-100). */
export type TerminalProgress = IProgressState;

const NO_PROGRESS: TerminalProgress = { state: 0, value: 0 };

/**
 * An xterm view bound to a server WS bridge. `readOnly` attaches to the
 * runtime's read-only fan-out (`?mode=ro`): it renders output and resizes for
 * display, but never forwards keystrokes. A read-write view (terminal service
 * PTY) wires stdin and resize control frames.
 *
 * `active` lets the view live inside a tab stack: an inactive (hidden) xterm
 * measures 0 cols, so its fit is deferred until it becomes visible again. The
 * WebSocket and scrollback are preserved across tab switches (the view stays
 * mounted), so switching tabs never drops or reloads a session.
 *
 * `onProgress` reports OSC 9;4 progress (e.g. pi with
 * `terminal.showTerminalProgress`), deduplicated and reset to none when the
 * connection closes so a dead session never shows as busy.
 */
export const TerminalView = forwardRef<
  TerminalViewHandle,
  {
    wsPath: string;
    readOnly?: boolean;
    active?: boolean;
    className?: string;
    onProgress?: (progress: TerminalProgress) => void;
  }
>(function TerminalView(
  { wsPath, readOnly = false, active = true, className, onProgress },
  handleRef,
) {
  // Read through a ref so a new callback identity never reconnects.
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const { theme } = useTheme();

  useImperativeHandle(
    handleRef,
    () => ({
      mark: () => {
        const terminal = terminalRef.current;
        if (terminal) writeMarker(terminal, "Marked");
      },
    }),
    [],
  );

  // `theme` is read here only to seed the terminal's *initial* theme; it's
  // intentionally excluded from the deps below so toggling light/dark
  // doesn't tear down the socket/scrollback — live restyling happens in the
  // separate effect further down instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme applied live below, not via reconnect
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let hasConnected = false;

    // Plain-text URLs (WebLinksAddon below) and OSC 8 hyperlinks share one
    // handler: Cmd/Ctrl+click opens http(s), hovering shows the target.
    const links = createTerminalLinkHandler(container);
    const terminal = new Terminal({
      linkHandler: links,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontSize: 13,
      fontFamily: '"Geist Mono", Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000,
      theme: terminalTheme(theme),
      // Fullscreen TUIs (pi, vim, htop…) capture the mouse, so a plain drag
      // goes to the app. Holding a modifier forces xterm's own selection
      // (then Cmd/Ctrl+C copies it): Shift by default, Option on macOS only
      // with this flag.
      macOptionClickForcesSelection: true,
      // `terminal.unicode` (Unicode 11 widths below) is a proposed API.
      allowProposedApi: true,
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    // Emoji are 2 cells wide in modern terminals and in TUIs' own layout
    // math (pi, Ink, ratatui); xterm's default Unicode 6 table counts them
    // as 1, which shifts the rest of the row in fullscreen apps.
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    // OSC 52: apps in the sandbox have no system clipboard, so they copy
    // through the terminal (pi's fullscreen selection does). Only for a pane
    // the user drives, so a read-only fan-out never touches their clipboard.
    if (!readOnly) terminal.loadAddon(new ClipboardAddon());
    terminal.loadAddon(new WebLinksAddon(links.activate, links));
    // Inline images: iTerm2 protocol (what pi emits with
    // PI_IMAGE_PROTOCOL=iterm2, set by the agent for console terminals) and
    // SIXEL. Several panes stay mounted at once, so cap each one's decoded
    // image cache well below the addon's 128 MB default.
    terminal.loadAddon(new ImageAddon({ storageLimit: 32 }));
    const progressAddon = new ProgressAddon();
    terminal.loadAddon(progressAddon);
    let lastProgress = NO_PROGRESS;
    // pi re-sends its progress as a keepalive; only report changes.
    const progressDisposable = progressAddon.onChange((progress) => {
      if (
        progress.state === lastProgress.state &&
        progress.value === lastProgress.value
      ) {
        return;
      }
      lastProgress = progress;
      onProgressRef.current?.(progress);
    });
    terminal.open(container);
    fitAddon.fit();

    function sendResize() {
      if (readOnly) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    }

    function connect() {
      if (disposed) return;
      const socket = new WebSocket(wsUrl(wsPath));
      socket.binaryType = "arraybuffer";
      wsRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        hasConnected = true;
        fitAddon.fit();
        sendResize();
      };
      socket.onmessage = (event) => {
        if (disposed) return;
        if (event.data instanceof ArrayBuffer) {
          terminal.write(new Uint8Array(event.data));
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        if (!hasConnected) {
          reconnectTimer = setTimeout(connect, 500);
          return;
        }
        // Nothing can clear a progress the app set before the link died.
        progressAddon.progress = NO_PROGRESS;
        writeMarker(terminal, "Connection closed");
      };
      socket.onerror = () => socket.close();
    }

    const dataDisposable = readOnly
      ? undefined
      : terminal.onData((data) => {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode(data));
          }
        });
    const resizeDisposable = terminal.onResize(sendResize);

    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        fitAddon.fit();
        rafId = null;
      });
    });
    observer.observe(container);

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      dataDisposable?.dispose();
      resizeDisposable.dispose();
      progressDisposable.dispose();
      wsRef.current?.close();
      wsRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [wsPath, readOnly]);

  // Live-restyle on theme toggle without tearing down the socket/scrollback.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = terminalTheme(theme);
  }, [theme]);

  // Refit (and focus a writable pane) when this view becomes visible again,
  // e.g. after its tab is selected. Deferred to the next frame so layout has
  // settled and the container has non-zero size.
  useEffect(() => {
    if (!active) return;
    const rafId = requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      if (!terminal || !fit) return;
      fit.fit();
      const ws = wsRef.current;
      if (!readOnly && ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
        terminal.focus();
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [active, readOnly]);

  return (
    <div
      ref={containerRef}
      className={cn("h-72 w-full overflow-hidden", className)}
    />
  );
});
