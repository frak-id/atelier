import type { SandboxStatus, SandboxUrl } from "@atelier/spec";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Play, TerminalSquare, X } from "lucide-react";
import { useState } from "react";
import { MultiTerminal } from "@/components/multi-terminal";
import { Button } from "@/components/ui/button";
import { useServiceGate } from "@/hooks/use-service-gate";
import {
  harnessFromAnnotations,
  sandboxNameFromAnnotations,
} from "@/lib/sandbox-status";
import { cn } from "@/lib/utils";

const TERMINAL_TAB = "__terminal__";

type ImmersiveSandbox = {
  id: string;
  status: SandboxStatus;
  urls: SandboxUrl[];
  annotations?: Record<string, string>;
};

/** "Open" prefers the harness's own web UI — the
 * url whose name matches the `atelier.dev/harness` annotation, by convention
 * (opencode/pi's composer names their web-UI port after the harness id).
 * Falls back to the terminal tab when the harness has no web UI (or the
 * sandbox has no harness at all). */
function preferredInitialTab(
  sandbox: ImmersiveSandbox,
  initialTab?: "terminal",
): string {
  if (initialTab === "terminal") return TERMINAL_TAB;
  const harness = harnessFromAnnotations(sandbox.annotations);
  if (harness && sandbox.urls.some((u) => u.name === harness)) return harness;
  return TERMINAL_TAB;
}

/**
 * Full-screen immersion: a maximized terminal plus every exposed URL as an
 * iframe tab. All panels stay mounted so switching tabs never drops a live
 * PTY or reloads an app. Extracted from the sandbox detail route so other
 * surfaces (e.g. a session's "Open" action) can deep-link straight into it.
 */
export function ImmersiveView({
  sandbox,
  initialTab,
  onClose,
}: {
  sandbox: ImmersiveSandbox;
  /** Open on the terminal instead of the harness's web UI. */
  initialTab?: "terminal";
  onClose: () => void;
}) {
  const [active, setActive] = useState<string>(() =>
    preferredInitialTab(sandbox, initialTab),
  );
  const name = sandboxNameFromAnnotations(sandbox.annotations);

  // A Radix Dialog gives the focus trap, Escape and focus return for free.
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
          // Escape typed in a terminal belongs to the app running there (vim,
          // pi, opencode...): only close when focus is outside the terminal.
          onEscapeKeyDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest(".xterm")
            ) {
              event.preventDefault();
            }
          }}
          className="fixed inset-0 z-50 flex flex-col bg-background pb-[env(safe-area-inset-bottom)] focus:outline-hidden"
        >
          <DialogPrimitive.Title className="sr-only">
            Sandbox {name ?? sandbox.id}
          </DialogPrimitive.Title>
          <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-card pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] box-content">
            {name ? (
              <span className="truncate text-sm font-medium" title={sandbox.id}>
                {name}
              </span>
            ) : (
              <span className="truncate font-mono text-sm">{sandbox.id}</span>
            )}
            <div
              role="tablist"
              aria-label="Sandbox views"
              className="ml-2 flex items-center gap-1 overflow-x-auto"
            >
              <button
                type="button"
                role="tab"
                aria-selected={active === TERMINAL_TAB}
                onClick={() => setActive(TERMINAL_TAB)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 h-10 text-sm sm:h-8 transition-colors duration-200",
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
                  role="tab"
                  aria-selected={active === url.name}
                  onClick={() => setActive(url.name)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 h-10 text-sm sm:h-8 transition-colors duration-200",
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
            <Button variant="ghost" size="touch" onClick={onClose}>
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
                status={sandbox.status}
                className="h-full rounded-none border-0"
              />
            </div>
            {sandbox.urls.map((url) => (
              <div
                key={url.name}
                className={cn(
                  "absolute inset-0",
                  active !== url.name && "hidden",
                )}
              >
                <GatedUrlPanel sandboxId={sandbox.id} url={url} />
              </div>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** One url tab's content: the iframe once its gating processes are ready, a
 * "start the service" panel otherwise — never mount the iframe early, which
 * is what produces a blank Bad Gateway for a lazy tool. */
function GatedUrlPanel({
  sandboxId,
  url,
}: {
  sandboxId: string;
  url: SandboxUrl;
}) {
  const gate = useServiceGate(sandboxId, url);

  if (!gate.canMount) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/30 text-center">
        <p className="text-sm text-muted-foreground">
          {gate.starting
            ? `Starting ${url.name}\u2026`
            : `${url.name} isn't running.`}
        </p>
        <Button size="sm" loading={gate.starting} onClick={() => gate.start()}>
          <Play />
          Start service
        </Button>
      </div>
    );
  }

  return (
    <iframe
      src={url.url}
      title={url.name}
      allow="clipboard-read; clipboard-write"
      className="h-full w-full border-0"
    />
  );
}
