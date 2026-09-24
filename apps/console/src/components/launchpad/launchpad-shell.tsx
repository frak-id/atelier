import { Link } from "@tanstack/react-router";
import { Sparkles, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { AccountControls } from "@/components/account-controls";
import { Button } from "@/components/ui/button";

/**
 * The Launchpad's own chrome: a wordmark, a quiet way out to the developer
 * console, and the account controls. No job queue, no developer nav: the
 * people here never need them.
 */
export function LaunchpadShell({
  username,
  onLogout,
  children,
}: {
  username: string;
  onLogout: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between border-b bg-background/95 px-4 backdrop-blur">
        <Link
          to="/launchpad"
          className="flex items-center gap-2 rounded-md px-1 font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-7 items-center justify-center rounded-md bg-foreground text-background">
            <Sparkles className="size-4" />
          </span>
          <span>Launchpad</span>
        </Link>
        <div className="flex items-center gap-1 sm:gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/" title="The developer console">
              <SquareTerminal />
              <span className="hidden sm:inline">Developer console</span>
            </Link>
          </Button>
          <AccountControls username={username} onLogout={onLogout} />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
