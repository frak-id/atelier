import { useQuery } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Loader2, Plus, RotateCcw, X } from "lucide-react";
import {
  type TerminalSession,
  terminalSessionsQuery,
  useCreateTerminalSession,
  useDeleteTerminalSession,
} from "@/api/queries";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MultiTerminalProps {
  sandboxId: string;
  className?: string;
}

export function MultiTerminal({ sandboxId, className }: MultiTerminalProps) {
  const { data: sessions = [], isLoading } = useQuery(
    terminalSessionsQuery(sandboxId),
  );
  const createMutation = useCreateTerminalSession(sandboxId);
  const deleteMutation = useDeleteTerminalSession(sandboxId);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (sessions.length > 0 && !activeSessionId) {
      setActiveSessionId(sessions[0]?.id ?? null);
    } else if (sessions.length > 0 && activeSessionId) {
      const exists = sessions.find((s) => s.id === activeSessionId);
      if (!exists) {
        setActiveSessionId(sessions[0]?.id ?? null);
      }
    } else if (sessions.length === 0) {
      setActiveSessionId(null);
    }
  }, [sessions, activeSessionId]);

  const handleCreateSession = useCallback(async () => {
    const session = await createMutation.mutateAsync(undefined);
    setActiveSessionId(session.id);
  }, [createMutation]);

  const handleCloseSession = useCallback(
    async (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      await deleteMutation.mutateAsync(sessionId);
    },
    [deleteMutation],
  );

  if (isLoading) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-[#09090b]",
          className,
        )}
      >
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col bg-[#09090b]", className)}>
      <div className="flex items-center border-b border-zinc-800 bg-zinc-900/50 overflow-x-auto">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => setActiveSessionId(session.id)}
            className={cn(
              "group flex items-center gap-2 px-3 py-1.5 text-sm border-r border-zinc-800 transition-colors shrink-0",
              activeSessionId === session.id
                ? "bg-[#09090b] text-white"
                : "text-zinc-400 hover:text-white hover:bg-zinc-800/50",
            )}
          >
            <span className="truncate max-w-[120px]">{session.title}</span>
            <button
              type="button"
              onClick={(e) => handleCloseSession(session.id, e)}
              className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCreateSession}
          disabled={createMutation.isPending}
          className="h-8 px-2 text-zinc-400 hover:text-white shrink-0"
        >
          {createMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
        </Button>
      </div>

      <div className="flex-1 relative min-h-0">
        {sessions.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500">
            <p className="text-sm mb-3">No terminal sessions</p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCreateSession}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              New Terminal
            </Button>
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                "absolute inset-0",
                activeSessionId !== session.id && "hidden",
              )}
            >
              <TerminalPane
                sandboxId={sandboxId}
                session={session}
                isActive={activeSessionId === session.id}
                onReconnect={() => {}}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface TerminalPaneProps {
  sandboxId: string;
  session: TerminalSession;
  isActive: boolean;
  onReconnect: () => void;
}

function TerminalPane({ sandboxId, session, isActive }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mountedRef = useRef(true);
  const hasConnectedRef = useRef(false);
  const [isExited, setIsExited] = useState(session.status === "exited");

  const getWsUrl = useCallback(() => {
    const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.host;
    return `${wsProto}://${host}/api/sandboxes/${sandboxId}/terminal/sessions/${session.id}/ws`;
  }, [sandboxId, session.id]);

  const reconnect = useCallback(() => {
    setIsExited(false);
    hasConnectedRef.current = false;
    clearTimeout(reconnectTimerRef.current);
    wsRef.current?.close();
  }, []);

  useEffect(() => {
    if (session.status === "exited") {
      setIsExited(true);
    }
  }, [session.status]);

  useEffect(() => {
    if (isActive && fitAddonRef.current && terminalRef.current) {
      const timer = setTimeout(() => {
        fitAddonRef.current?.fit();
        const ws = wsRef.current;
        const terminal = terminalRef.current;
        if (ws?.readyState === WebSocket.OPEN && terminal) {
          const { cols, rows } = terminal;
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isActive]);

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
    fitAddon.fit();

    function connect() {
      if (!mountedRef.current) return;
      const ws = new WebSocket(getWsUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        hasConnectedRef.current = true;
        fitAddon.fit();
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

        if (!hasConnectedRef.current) {
          terminal.writeln("\r\n\x1b[33mConnection failed. Retrying...\x1b[0m");
          reconnectTimerRef.current = setTimeout(connect, 2000);
          return;
        }

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

    if (session.status !== "exited") {
      connect();
    }

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
  }, [getWsUrl, session.status]);

  return (
    <div className="absolute inset-0">
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ background: "#09090b" }}
      />
      {isExited && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#09090b]/90">
          <Button onClick={reconnect} variant="outline" className="gap-2">
            <RotateCcw className="h-4 w-4" />
            Reconnect
          </Button>
        </div>
      )}
    </div>
  );
}
