import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { wsUrl } from "@/lib/api-base";
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
 */
export const TerminalView = forwardRef<
  TerminalViewHandle,
  {
    wsPath: string;
    readOnly?: boolean;
    active?: boolean;
    className?: string;
  }
>(function TerminalView(
  { wsPath, readOnly = false, active = true, className },
  handleRef,
) {
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

    const terminal = new Terminal({
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontSize: 13,
      fontFamily: '"Geist Mono", Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000,
      theme: terminalTheme(theme),
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
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
