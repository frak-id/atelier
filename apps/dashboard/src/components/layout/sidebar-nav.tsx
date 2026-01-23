import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface NavItemProps {
  to: string;
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
  badge?: number;
}

export function NavItem({
  to,
  icon: Icon,
  label,
  collapsed,
  badge,
}: NavItemProps) {
  const content = (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-3 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors [&.active]:bg-accent [&.active]:text-foreground relative",
        collapsed ? "justify-center p-2" : "px-3 py-2",
      )}
      activeProps={{ className: "active" }}
    >
      <Icon className={cn("shrink-0", collapsed ? "h-5 w-5" : "h-4 w-4")} />
      {!collapsed && <span>{label}</span>}
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            "flex items-center justify-center text-xs font-medium bg-red-500 text-white rounded-full",
            collapsed
              ? "absolute -top-1 -right-1 h-4 w-4 text-[10px]"
              : "ml-auto h-5 min-w-5 px-1",
          )}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-2">
          {label}
          {badge !== undefined && badge > 0 && (
            <span className="bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5">
              {badge}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
}

interface NavSectionProps {
  children: React.ReactNode;
  className?: string;
}

export function NavSection({ children, className }: NavSectionProps) {
  return <div className={cn("space-y-1", className)}>{children}</div>;
}
