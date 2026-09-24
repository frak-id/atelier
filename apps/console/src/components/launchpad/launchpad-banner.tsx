import { Link } from "@tanstack/react-router";
import { ArrowRight, Sparkles } from "lucide-react";

/**
 * The front door for everyone who isn't a developer: a big, unmissable
 * banner on the console home that says "not your page, go here". Kept
 * deliberately free of technical words.
 */
export function LaunchpadBanner() {
  return (
    <Link
      to="/launchpad"
      className="group relative flex flex-col gap-4 overflow-hidden rounded-2xl border bg-gradient-to-br from-muted via-card to-card p-6 shadow-xs transition-colors hover:border-foreground/25 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between sm:p-8"
    >
      <div className="flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-foreground text-background">
          <Sparkles className="size-6" />
        </span>
        <div className="space-y-1">
          <p className="text-xl font-semibold tracking-tight sm:text-2xl">
            Not a developer? Start here.
          </p>
          <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
            The Launchpad has ready-to-use workspaces prepared by your tech
            team. Pick what you're working on and get going in one click.
          </p>
        </div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-2 self-start rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-transform group-hover:translate-x-0.5 sm:self-center">
        Open the Launchpad
        <ArrowRight className="size-4" />
      </span>
    </Link>
  );
}
