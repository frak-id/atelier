import { Link } from "@tanstack/react-router";
import { LogOut, User } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SidebarFooterProps {
  collapsed: boolean;
  onLogout: () => void;
}

export function SidebarFooter({ collapsed, onLogout }: SidebarFooterProps) {
  return (
    <div className="p-2 border-t space-y-1">
      {collapsed ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/profile"
                className="flex items-center justify-center p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors [&.active]:bg-accent [&.active]:text-foreground"
                activeProps={{ className: "active" }}
              >
                <User className="h-5 w-5" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">Profile</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onLogout}
                className="flex items-center justify-center w-full p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <LogOut className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Sign out</TooltipContent>
          </Tooltip>
        </>
      ) : (
        <>
          <Link
            to="/profile"
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors [&.active]:bg-accent [&.active]:text-foreground"
            activeProps={{ className: "active" }}
          >
            <User className="h-4 w-4" />
            Profile
          </Link>
          <button
            type="button"
            onClick={onLogout}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
          <div className="px-3 py-2 text-xs text-muted-foreground">v0.2.0</div>
        </>
      )}
    </div>
  );
}
