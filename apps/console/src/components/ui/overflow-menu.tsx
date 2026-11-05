import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface OverflowMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  onSelect: () => void;
}

/**
 * A compact "⋯" menu: a button that opens a short list of actions, closed by
 * an outside tap, Escape or picking an item. Touch-sized rows.
 */
export function OverflowMenu({
  items,
  label = "More actions",
}: {
  items: OverflowMenuItem[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div ref={root} className="relative">
      <Button
        variant="outline"
        size="touch"
        className="px-3"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={cn(
                "flex min-h-11 w-full items-center gap-2 rounded-sm px-3 text-left text-sm hover:bg-accent active:bg-accent/70 sm:min-h-9 [&_svg]:size-4 [&_svg]:shrink-0",
                item.destructive && "text-destructive",
              )}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
