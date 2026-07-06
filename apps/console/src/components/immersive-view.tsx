import type { SandboxUrl } from "@atelier/spec";
import { TerminalSquare, X } from "lucide-react";
import { useEffect, useState } from "react";
import { MultiTerminal } from "@/components/multi-terminal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const TERMINAL_TAB = "__terminal__";

/**
 * Full-screen immersion: a maximized terminal plus every exposed URL as an
 * iframe tab. All panels stay mounted so switching tabs never drops a live
 * PTY or reloads an app. Extracted from the sandbox detail route so other
 * surfaces (e.g. a session's "Open" action) can deep-link straight into it —
 * "Open" is terminal-only for now (see IMPLEMENTATION_PLAN.md §1.3); a
 * per-harness web UI iframe is a later TODO.
 *
 * TODO(review): this full-screen overlay lacks a focus trap — keyboard/screen
 * reader users can still tab to elements behind it. Adopt a focus trap (or a
 * Radix Dialog base) when hardening a11y.
 */
export function ImmersiveView({
  sandbox,
  onClose,
}: {
  sandbox: { id: string; urls: SandboxUrl[] };
  onClose: () => void;
}) {
  const [active, setActive] = useState<string>(TERMINAL_TAB);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3">
        <span className="truncate font-mono text-sm">{sandbox.id}</span>
        <div className="ml-2 flex items-center gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActive(TERMINAL_TAB)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 h-8 text-sm transition-colors duration-200",
              active === TERMINAL_TAB
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <TerminalSquare className="size-4" />
            Terminal
          </button>
          {sandbox.urls.map((url) => (
            <button
              key={url.name}
              type="button"
              onClick={() => setActive(url.name)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 h-8 text-sm transition-colors duration-200",
                active === url.name
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {url.name}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X />
          Close
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          className={cn(
            "absolute inset-0",
            active !== TERMINAL_TAB && "hidden",
          )}
        >
          <MultiTerminal
            sandboxId={sandbox.id}
            className="h-full rounded-none border-0"
          />
        </div>
        {sandbox.urls.map((url) => (
          <iframe
            key={url.name}
            src={url.url}
            title={url.name}
            allow="clipboard-read; clipboard-write"
            className={cn(
              "absolute inset-0 h-full w-full border-0",
              active !== url.name && "hidden",
            )}
          />
        ))}
      </div>
    </div>
  );
}
