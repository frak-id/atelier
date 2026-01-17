import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Loader2, TerminalIcon, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";

interface TerminalProps {
  terminalUrl: string;
}

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

export function SandboxTerminal({ terminalUrl }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const wsUrl = `${terminalUrl.replace(/^https?:/, "wss:")}/ws`;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setConnectionState("connecting");
    setErrorMessage(null);

    if (terminalRef.current) {
      terminalRef.current.clear();
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      setConnectionState("connected");

      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = terminalRef.current;
        ws.send(`2${JSON.stringify({ columns: cols, rows })}`);
      }
    };

    ws.onmessage = (event) => {
      const data =
        event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : event.data;

      if (data.length > 0) {
        const cmd = data[0];
        const payload = data.slice(1);

        if (cmd === "1") {
          terminalRef.current?.write(payload);
        }
      }
    };

    ws.onclose = () => {
      setConnectionState("disconnected");
    };

    ws.onerror = () => {
      setConnectionState("error");
      setErrorMessage("Failed to connect to terminal");
    };
  }, [wsUrl]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionState("disconnected");
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#1a1a1a",
        foreground: "#f0f0f0",
        cursor: "#f0f0f0",
        selectionBackground: "#404040",
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    setTimeout(() => fitAddon.fit(), 0);

    terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(`0${data}`);
      }
    });

    terminal.onResize(({ cols, rows }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(`2${JSON.stringify({ columns: cols, rows })}`);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      setTimeout(() => fitAddon.fit(), 0);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 bg-[#1a1a1a] border-b border-zinc-800 rounded-t-lg">
        <div className="flex items-center gap-2 text-zinc-400 text-sm">
          <TerminalIcon className="h-4 w-4" />
          <span>Terminal</span>
          {connectionState === "connecting" && (
            <Loader2 className="h-3 w-3 animate-spin" />
          )}
          {connectionState === "connected" && (
            <span className="h-2 w-2 rounded-full bg-green-500" />
          )}
          {connectionState === "error" && (
            <span className="h-2 w-2 rounded-full bg-red-500" />
          )}
          {connectionState === "disconnected" && (
            <span className="h-2 w-2 rounded-full bg-zinc-500" />
          )}
        </div>
        <div className="flex items-center gap-2">
          {connectionState === "disconnected" || connectionState === "error" ? (
            <Button variant="ghost" size="sm" onClick={connect}>
              Reconnect
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={disconnect}>
              <XCircle className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {errorMessage && (
        <div className="px-3 py-2 bg-red-900/20 border-b border-red-900/50 text-red-400 text-sm">
          {errorMessage}
        </div>
      )}

      <div
        ref={containerRef}
        className="flex-1 bg-[#1a1a1a] rounded-b-lg overflow-hidden"
        style={{ minHeight: "400px" }}
      />
    </div>
  );
}
