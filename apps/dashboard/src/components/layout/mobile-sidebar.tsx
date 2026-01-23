import { Link } from "@tanstack/react-router";
import {
  Boxes,
  ChevronDown,
  FolderGit2,
  HardDrive,
  Home,
  Kanban,
  LogOut,
  MessageSquare,
  Server,
  Settings,
  User,
} from "lucide-react";
import { Suspense, useState } from "react";
import { GitHubStatus } from "@/components/github-status";
import { cn } from "@/lib/utils";

interface MobileSidebarProps {
  onLogout: () => void;
  onClose: () => void;
}

export function MobileSidebar({ onLogout, onClose }: MobileSidebarProps) {
  const [adminExpanded, setAdminExpanded] = useState(false);

  return (
    <div className="flex flex-col h-full">
      <nav className="flex-1 p-4 space-y-1">
        <MobileNavLink to="/" icon={Home} onClick={onClose}>
          Home
        </MobileNavLink>
        <MobileNavLink to="/tasks" icon={Kanban} onClick={onClose}>
          Tasks
        </MobileNavLink>
        <MobileNavLink to="/sessions" icon={MessageSquare} onClick={onClose}>
          Sessions
        </MobileNavLink>
        <MobileNavLink to="/sandboxes" icon={Boxes} onClick={onClose}>
          Sandboxes
        </MobileNavLink>
        <MobileNavLink to="/workspaces" icon={FolderGit2} onClick={onClose}>
          Workspaces
        </MobileNavLink>

        <div className="pt-4">
          <button
            type="button"
            onClick={() => setAdminExpanded(!adminExpanded)}
            className="flex items-center justify-between w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <span>Admin</span>
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                adminExpanded && "rotate-180",
              )}
            />
          </button>
          {adminExpanded && (
            <div className="mt-1 space-y-1 pl-2">
              <MobileNavLink
                to="/admin/images"
                icon={HardDrive}
                onClick={onClose}
              >
                Images
              </MobileNavLink>
              <MobileNavLink to="/admin/system" icon={Server} onClick={onClose}>
                System
              </MobileNavLink>
              <MobileNavLink
                to="/admin/config"
                icon={Settings}
                onClick={onClose}
              >
                Config
              </MobileNavLink>
            </div>
          )}
        </div>
      </nav>

      <div className="p-4 border-t space-y-3">
        <Suspense fallback={null}>
          <GitHubStatus />
        </Suspense>
        <MobileNavLink to="/profile" icon={User} onClick={onClose}>
          Profile
        </MobileNavLink>
        <button
          type="button"
          onClick={() => {
            onLogout();
            onClose();
          }}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-accent"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
        <div className="text-xs text-muted-foreground px-3">v0.2.0</div>
      </div>
    </div>
  );
}

function MobileNavLink({
  to,
  icon: Icon,
  children,
  onClick,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors [&.active]:bg-accent [&.active]:text-foreground"
      activeProps={{ className: "active" }}
    >
      <Icon className="h-4 w-4" />
      {children}
    </Link>
  );
}
