import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SidebarGroupProps {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  collapsed: boolean;
  children: ReactNode;
}

export function SidebarGroup({
  label,
  expanded,
  onToggle,
  collapsed,
  children,
}: SidebarGroupProps) {
  if (collapsed) {
    return (
      <div className="py-2">
        <div className="h-px bg-border mx-2" />
        <div className="mt-2 space-y-1">{children}</div>
      </div>
    );
  }

  return (
    <div className="py-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center justify-between w-full px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground uppercase tracking-wider transition-colors"
      >
        <span>{label}</span>
        <ChevronDown
          className={cn(
            "h-3 w-3 transition-transform duration-200",
            expanded && "rotate-180",
          )}
        />
      </button>
      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          expanded ? "max-h-96 opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="space-y-1 pt-1">{children}</div>
      </div>
    </div>
  );
}
