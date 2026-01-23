import { Link } from "@tanstack/react-router";
import {
  Box,
  Boxes,
  ChevronLeft,
  ChevronRight,
  FolderGit2,
  HardDrive,
  Home,
  Kanban,
  MessageSquare,
  Server,
  Settings,
} from "lucide-react";
import { Suspense, useState } from "react";
import { GitHubStatus } from "@/components/github-status";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SidebarFooter } from "./sidebar-footer";
import { SidebarGroup } from "./sidebar-group";
import { NavItem, NavSection } from "./sidebar-nav";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onLogout: () => void;
  attentionCount?: number;
}

export function Sidebar({
  collapsed,
  onToggle,
  onLogout,
  attentionCount = 0,
}: SidebarProps) {
  const [devToolsExpanded, setDevToolsExpanded] = useState(true);
  const [adminExpanded, setAdminExpanded] = useState(false);

  return (
    <aside
      className={cn(
        "hidden md:flex border-r bg-card flex-col transition-all duration-200",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <div
        className={cn(
          "border-b flex items-center justify-between",
          collapsed ? "p-3" : "p-4",
        )}
      >
        <Link to="/" className="flex items-center gap-2">
          <Box
            className={cn(
              "text-primary shrink-0",
              collapsed ? "h-7 w-7" : "h-6 w-6",
            )}
          />
          {!collapsed && (
            <span className="font-bold text-lg">Frak Sandbox</span>
          )}
        </Link>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggle}
                className="h-7 w-7 p-0"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand sidebar</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
            className="h-7 w-7 p-0"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        <NavSection>
          <NavItem to="/" icon={Home} label="Home" collapsed={collapsed} />
          <NavItem
            to="/tasks"
            icon={Kanban}
            label="Tasks"
            collapsed={collapsed}
            badge={attentionCount}
          />
          <NavItem
            to="/sessions"
            icon={MessageSquare}
            label="Sessions"
            collapsed={collapsed}
          />
        </NavSection>

        <SidebarGroup
          label="Dev Tools"
          expanded={devToolsExpanded}
          onToggle={() => setDevToolsExpanded(!devToolsExpanded)}
          collapsed={collapsed}
        >
          <NavItem
            to="/sandboxes"
            icon={Boxes}
            label="Sandboxes"
            collapsed={collapsed}
          />
          <NavItem
            to="/workspaces"
            icon={FolderGit2}
            label="Workspaces"
            collapsed={collapsed}
          />
        </SidebarGroup>

        <SidebarGroup
          label="Admin"
          expanded={adminExpanded}
          onToggle={() => setAdminExpanded(!adminExpanded)}
          collapsed={collapsed}
        >
          <NavItem
            to="/admin/system"
            icon={Server}
            label="System"
            collapsed={collapsed}
          />
          <NavItem
            to="/admin/images"
            icon={HardDrive}
            label="Images"
            collapsed={collapsed}
          />
          <NavItem
            to="/admin/config"
            icon={Settings}
            label="Config"
            collapsed={collapsed}
          />
        </SidebarGroup>
      </nav>

      {!collapsed && (
        <div className="px-4 py-2 border-t">
          <Suspense fallback={null}>
            <GitHubStatus />
          </Suspense>
        </div>
      )}

      <SidebarFooter collapsed={collapsed} onLogout={onLogout} />
    </aside>
  );
}
