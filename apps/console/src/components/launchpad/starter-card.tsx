import { AppWindow, ArrowRight, Loader2 } from "lucide-react";
import type { CatalogStarter } from "@/api/queries/launchpad";
import { LaunchpadIconView } from "@/lib/launchpad";
import { cn } from "@/lib/utils";

/**
 * One "What are you working on?" option: a big, friendly, single-click tile.
 * The whole card is the button; `launching` swaps the arrow for a spinner so
 * the click visibly "took".
 */
export function StarterCard({
  starter,
  onLaunch,
  launching,
  disabled,
}: {
  starter: CatalogStarter;
  onLaunch: () => void;
  launching: boolean;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onLaunch}
      disabled={disabled}
      className={cn(
        "group flex h-full flex-col gap-4 rounded-xl border bg-card p-5 text-left shadow-xs transition-all duration-200",
        "hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-md",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:pointer-events-none",
        disabled && !launching && "opacity-60",
        launching && "border-foreground/40",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-foreground">
          <LaunchpadIconView icon={starter.icon} className="size-5.5" />
        </span>
        <span className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
          {launching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowRight className="size-4" />
          )}
        </span>
      </div>
      <div className="flex-1 space-y-1.5">
        <h3 className="text-base font-semibold leading-snug">
          {starter.title}
        </h3>
        {starter.description ? (
          <p className="text-sm text-muted-foreground">{starter.description}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {starter.services.slice(0, 4).map((service, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat; the list is static per render
            key={index}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >
            <LaunchpadIconView
              icon={service.icon}
              fallback={AppWindow}
              className="size-3"
            />
            {service.label}
          </span>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {starter.ownerLabel}
        </span>
      </div>
    </button>
  );
}
