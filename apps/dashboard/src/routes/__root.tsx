import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
} from "@tanstack/react-router";
import {
  Box,
  Boxes,
  FolderGit2,
  HardDrive,
  LayoutDashboard,
  Settings,
} from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    component: RootLayout,
  },
);

function RootLayout() {
  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background">
        <aside className="w-64 border-r bg-card flex flex-col">
          <div className="p-6 border-b">
            <Link to="/" className="flex items-center gap-2">
              <Box className="h-6 w-6 text-primary" />
              <span className="font-bold text-lg">Frak Sandbox</span>
            </Link>
          </div>
          <nav className="flex-1 p-4 space-y-1">
            <NavLink to="/" icon={LayoutDashboard}>
              Dashboard
            </NavLink>
            <NavLink to="/sandboxes" icon={Boxes}>
              Sandboxes
            </NavLink>
            <NavLink to="/projects" icon={FolderGit2}>
              Projects
            </NavLink>
            <NavLink to="/images" icon={HardDrive}>
              Images
            </NavLink>
            <NavLink to="/system" icon={Settings}>
              System
            </NavLink>
          </nav>
          <div className="p-4 border-t text-xs text-muted-foreground">
            v0.1.0
          </div>
        </aside>
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </TooltipProvider>
  );
}

function NavLink({
  to,
  icon: Icon,
  children,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors [&.active]:bg-accent [&.active]:text-foreground"
      activeProps={{ className: "active" }}
    >
      <Icon className="h-4 w-4" />
      {children}
    </Link>
  );
}
