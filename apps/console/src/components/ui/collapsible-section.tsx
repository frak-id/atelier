import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A titled section whose body folds away behind its header, expanded by
 * default. Settings pages stack one per owner scope (personal, each org).
 *
 * The body stays mounted while collapsed (`hidden`), so folding a section
 * never drops in-progress edits or refetches its data on reopen. `actions`
 * sit outside the toggle button, so an "Add" button never also folds the
 * section.
 */
export function CollapsibleSection({
  title,
  meta,
  count,
  actions,
  defaultOpen = true,
  children,
  className,
}: {
  title: ReactNode;
  /** Inline extras after the title (badges, role). */
  meta?: ReactNode;
  /** Item count pill; omit while loading or where a count means nothing. */
  count?: number;
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex items-center gap-2 border-b pb-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((next) => !next)}
          className="-ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-90",
            )}
          />
          <span className="truncate text-sm font-semibold">{title}</span>
          {count !== undefined ? (
            <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
              {count}
            </span>
          ) : null}
          {meta ? (
            <span className="flex min-w-0 items-center gap-1.5">{meta}</span>
          ) : null}
        </button>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
