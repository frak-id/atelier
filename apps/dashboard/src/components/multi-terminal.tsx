import { useQuery } from "@tanstack/react-query";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
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

  const createMutationRef = useRef(createMutation);
  createMutationRef.current = createMutation;
  const deleteMutationRef = useRef(deleteMutation);
  deleteMutationRef.current = deleteMutation;

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    setActiveSessionId((current) => {
      if (sessions.length === 0) return null;
      if (!current) return sessions[0]?.id ?? null;
      const exists = sessions.find((s) => s.id === current);
      if (!exists) return sessions[0]?.id ?? null;
      return current;
    });
  }, [sessions]);

  const handleCreateSession = useCallback(async () => {
    const session = await createMutationRef.current.mutateAsync(undefined);
    setActiveSessionId(session.id);
  }, []);

  const handleCloseSession = useCallback(
    async (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      await deleteMutationRef.current.mutateAsync(sessionId);
    },
    [],
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
}

const TerminalPane = memo(
  function TerminalPane({ sandboxId, session, isActive }: TerminalPaneProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const mountedRef = useRef(true);
    const hasConnectedRef = useRef(false);
    const reconnectFnRef = useRef<(() => void) | null>(null);

    const [isExited, setIsExited] = useState(false);

    const [showSearch, setShowSearch] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");

    const getWsUrl = useCallback(() => {
      const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
      const host = window.location.host;
      return `${wsProto}://${host}/api/sandboxes/${sandboxId}/terminal/sessions/${session.id}/ws`;
    }, [sandboxId, session.id]);

    const reconnect = useCallback(() => {
      setIsExited(false);
      reconnectFnRef.current?.();
    }, []);

    useEffect(() => {
      if (isActive && fitAddonRef.current && terminalRef.current) {
        const rafId = requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
          const ws = wsRef.current;
          const terminal = terminalRef.current;
          if (ws?.readyState === WebSocket.OPEN && terminal) {
            const { cols, rows } = terminal;
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        });
        return () => cancelAnimationFrame(rafId);
      }
    }, [isActive]);

    useEffect(() => {
      if (!isActive) return;

      const handleKeyDown = (e: KeyboardEvent) => {
        if (
          (e.ctrlKey || e.metaKey) &&
          e.shiftKey &&
          e.key.toLowerCase() === "f"
        ) {
          e.preventDefault();
          setShowSearch((s) => !s);
        }
        if (e.key === "Escape" && showSearch) {
          setShowSearch(false);
          setSearchQuery("");
          searchAddonRef.current?.clearDecorations();
          terminalRef.current?.focus();
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isActive, showSearch]);

    useEffect(() => {
      mountedRef.current = true;
      const container = containerRef.current;
      if (!container) return;

      const terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        scrollback: 10_000,
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
      terminal.loadAddon(new ClipboardAddon());

      const unicode11 = new Unicode11Addon();
      terminal.loadAddon(unicode11);
      terminal.unicode.activeVersion = "11";

      const searchAddon = new SearchAddon();
      searchAddonRef.current = searchAddon;
      terminal.loadAddon(searchAddon);

      terminal.open(container);

      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => webglAddon.dispose());
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL2 unavailable — DOM renderer fallback
      }

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
            terminal.writeln(
              "\r\n\x1b[33mConnection failed. Retrying...\x1b[0m",
            );
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

      reconnectFnRef.current = () => {
        hasConnectedRef.current = false;
        clearTimeout(reconnectTimerRef.current);
        wsRef.current?.close();
        connect();
      };

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
        mountedRef.current = false;
        reconnectFnRef.current = null;
        clearTimeout(reconnectTimerRef.current);
        if (rafId !== null) cancelAnimationFrame(rafId);
        observer.disconnect();
        dataDisposable.dispose();
        resizeDisposable.dispose();
        wsRef.current?.close();
        terminal.dispose();
      };
    }, [getWsUrl]);

    const handleSearchInput = useCallback((value: string) => {
      setSearchQuery(value);
      if (value) {
        searchAddonRef.current?.findNext(value, {
          incremental: true,
        });
      } else {
        searchAddonRef.current?.clearDecorations();
      }
    }, []);

    const handleSearchNext = useCallback(() => {
      if (searchQuery) {
        searchAddonRef.current?.findNext(searchQuery);
      }
    }, [searchQuery]);

    const handleSearchPrevious = useCallback(() => {
      if (searchQuery) {
        searchAddonRef.current?.findPrevious(searchQuery);
      }
    }, [searchQuery]);

    const handleSearchClose = useCallback(() => {
      setShowSearch(false);
      setSearchQuery("");
      searchAddonRef.current?.clearDecorations();
      terminalRef.current?.focus();
    }, []);

    return (
      <div className="absolute inset-0">
        <div
          ref={containerRef}
          className="absolute inset-0"
          style={{ background: "#09090b" }}
        />

        {showSearch && (
          <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 shadow-lg">
            <Search className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <input
              ref={(el) => el?.focus()}
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) {
                    handleSearchPrevious();
                  } else {
                    handleSearchNext();
                  }
                }
                if (e.key === "Escape") {
                  handleSearchClose();
                }
              }}
              placeholder="Search..."
              className="h-6 w-48 bg-transparent text-sm text-white placeholder-zinc-500 outline-none"
            />
            <button
              type="button"
              onClick={handleSearchPrevious}
              className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              title="Previous (Shift+Enter)"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleSearchNext}
              className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              title="Next (Enter)"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleSearchClose}
              className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              title="Close (Escape)"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {isExited && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#09090b]/90">
            <Button onClick={reconnect} variant="outline" className="gap-2 z-10">
              <RotateCcw className="h-4 w-4" />
              Reconnect
            </Button>
          </div>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.sandboxId === next.sandboxId &&
    prev.session.id === next.session.id &&
    prev.isActive === next.isActive,
);
