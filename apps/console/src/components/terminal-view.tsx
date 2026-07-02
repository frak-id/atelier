import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { wsUrl } from "@/lib/api-base";

const THEME = {
  background: "#09090b",
  foreground: "#fafafa",
  cursor: "#fafafa",
  selectionBackground: "#27272a",
} as const;

/**
 * An xterm view bound to a server WS bridge. `readOnly` attaches to the
 * runtime's read-only fan-out (`?mode=ro`): it renders output and resizes for
 * display, but never forwards keystrokes. A read-write view (terminal service
 * PTY) wires stdin and resize control frames.
 */
export function TerminalView({
  wsPath,
  readOnly = false,
}: {
  wsPath: string;
  readOnly?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | null = null;
    let hasConnected = false;

    const terminal = new Terminal({
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000,
      theme: THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    function sendResize() {
      if (readOnly) return;
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
      ws = socket;

      socket.onopen = () => {
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
        terminal.writeln("\r\n\x1b[31mConnection closed.\x1b[0m");
      };
      socket.onerror = () => socket.close();
    }

    const dataDisposable = readOnly
      ? undefined
      : terminal.onData((data) => {
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
      ws?.close();
      terminal.dispose();
    };
  }, [wsPath, readOnly]);

  return <div ref={containerRef} className="h-72 w-full overflow-hidden" />;
}
