import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

interface TerminalEmulatorProps {
  sandboxId: string;
  className?: string;
}

export function TerminalEmulator({
  sandboxId,
  className,
}: TerminalEmulatorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mountedRef = useRef(true);

  const getWsUrl = useCallback(() => {
    const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.host;
    return `${wsProto}://${host}/api/sandboxes/${sandboxId}/terminal/ws`;
  }, [sandboxId]);

  useEffect(() => {
    mountedRef.current = true;
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#09090b",
        foreground: "#fafafa",
        cursor: "#fafafa",
        selectionBackground: "#27272a",
      },
    });
    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);

    // Initial fit after a frame
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    function connect() {
      if (!mountedRef.current) return;
      const ws = new WebSocket(getWsUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        // Send initial resize
        const { cols, rows } = terminal;
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      };

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          terminal.write(new Uint8Array(e.data));
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        terminal.writeln("\r\n\x1b[33mDisconnected. Reconnecting...\x1b[0m");
        reconnectTimerRef.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    const dataDisposable = terminal.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    // Throttled fit on window resize
    let resizeTimer: ReturnType<typeof setTimeout>;
    const onWindowResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
      }, 100);
    };
    window.addEventListener("resize", onWindowResize);

    // ResizeObserver for container
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
      }, 100);
    });
    observer.observe(container);

    connect();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimerRef.current);
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onWindowResize);
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      wsRef.current?.close();
      terminal.dispose();
    };
  }, [getWsUrl]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
