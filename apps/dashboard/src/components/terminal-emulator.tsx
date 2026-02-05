import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  const hasConnectedRef = useRef(false);
  const [isExited, setIsExited] = useState(false);

  const getWsUrl = useCallback(() => {
    const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.host;
    return `${wsProto}://${host}/api/sandboxes/${sandboxId}/terminal/ws`;
  }, [sandboxId]);

  const reconnect = useCallback(() => {
    setIsExited(false);
    hasConnectedRef.current = false;
    // Clear reconnect timer and trigger a fresh connection
    clearTimeout(reconnectTimerRef.current);
    wsRef.current?.close();
    // connect() will be called by useEffect when state changes
  }, []);

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

    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    function connect() {
      if (!mountedRef.current) return;
      const ws = new WebSocket(getWsUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        hasConnectedRef.current = true;
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

        // If we never connected successfully, retry
        if (!hasConnectedRef.current) {
          terminal.writeln("\r\n\x1b[33mConnection failed. Retrying...\x1b[0m");
          reconnectTimerRef.current = setTimeout(connect, 2000);
          return;
        }

        // We were connected but now closed - session ended (exit command)
        setIsExited(true);
        terminal.writeln("\r\n\x1b[31mSession ended.\x1b[0m");
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

    let resizeTimer: ReturnType<typeof setTimeout>;
    const onWindowResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
      }, 100);
    };
    window.addEventListener("resize", onWindowResize);

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
    <div className={`relative ${className}`}>
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ background: "#09090b" }}
      />
      {isExited && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#09090b]/90">
          <Button onClick={reconnect} variant="outline" className="gap-2">
            <RotateCcw className="h-4 w-4" />
            Reconnect Terminal
          </Button>
        </div>
      )}
    </div>
  );
}
