import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
} from "@tanstack/react-router";
import {
  Box,
  Boxes,
  ChevronDown,
  FolderGit2,
  HardDrive,
  Home,
  Menu,
  Server,
  Settings,
} from "lucide-react";
import { Suspense, useState } from "react";
import { GitHubStatus } from "@/components/github-status";
import { SystemStatusFooter } from "@/components/system-status-footer";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    component: RootLayout,
  },
);

function RootLayout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [adminExpanded, setAdminExpanded] = useState(false);

  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background">
        <aside className="hidden md:flex w-64 border-r bg-card flex-col">
          <div className="p-6 border-b">
            <Link to="/" className="flex items-center gap-2">
              <Box className="h-6 w-6 text-primary" />
              <span className="font-bold text-lg">Frak Sandbox</span>
            </Link>
          </div>
          <nav className="flex-1 p-4 space-y-1">
            <NavLink to="/" icon={Home}>
              Home
            </NavLink>
            <NavLink to="/workspaces" icon={FolderGit2}>
              Workspaces
            </NavLink>
            <NavLink to="/sandboxes" icon={Boxes}>
              Sandboxes
            </NavLink>

            <div className="pt-4">
              <button
                type="button"
                onClick={() => setAdminExpanded(!adminExpanded)}
                className="flex items-center justify-between w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <span>Admin</span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${adminExpanded ? "rotate-180" : ""}`}
                />
              </button>
              {adminExpanded && (
                <div className="mt-1 space-y-1 pl-2">
                  <NavLink to="/images" icon={HardDrive}>
                    Images
                  </NavLink>
                  <NavLink to="/system" icon={Server}>
                    System
                  </NavLink>
                  <NavLink to="/settings" icon={Settings}>
                    Settings
                  </NavLink>
                </div>
              )}
            </div>
          </nav>
          <div className="p-4 border-t space-y-3">
            <Suspense fallback={null}>
              <GitHubStatus />
            </Suspense>
            <div className="text-xs text-muted-foreground">v0.1.0</div>
          </div>
        </aside>

        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetContent side="left" className="w-64 p-0">
            <SheetHeader className="p-6 border-b">
              <SheetTitle>
                <Link to="/" className="flex items-center gap-2">
                  <Box className="h-6 w-6 text-primary" />
                  <span className="font-bold text-lg">Frak Sandbox</span>
                </Link>
              </SheetTitle>
            </SheetHeader>
            <nav className="flex-1 p-4 space-y-1">
              <NavLink to="/" icon={Home}>
                Home
              </NavLink>
              <NavLink to="/workspaces" icon={FolderGit2}>
                Workspaces
              </NavLink>
              <NavLink to="/sandboxes" icon={Boxes}>
                Sandboxes
              </NavLink>

              <div className="pt-4">
                <button
                  type="button"
                  onClick={() => setAdminExpanded(!adminExpanded)}
                  className="flex items-center justify-between w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span>Admin</span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${adminExpanded ? "rotate-180" : ""}`}
                  />
                </button>
                {adminExpanded && (
                  <div className="mt-1 space-y-1 pl-2">
                    <NavLink to="/images" icon={HardDrive}>
                      Images
                    </NavLink>
                    <NavLink to="/system" icon={Server}>
                      System
                    </NavLink>
                    <NavLink to="/settings" icon={Settings}>
                      Settings
                    </NavLink>
                  </div>
                )}
              </div>
            </nav>
            <div className="p-4 border-t space-y-3">
              <Suspense fallback={null}>
                <GitHubStatus />
              </Suspense>
              <div className="text-xs text-muted-foreground">v0.1.0</div>
            </div>
          </SheetContent>
        </Sheet>

        <div className="flex-1 flex flex-col overflow-hidden">
          <header className="md:hidden flex items-center gap-4 p-4 border-b bg-card">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileMenuOpen(true)}
            >
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open menu</span>
            </Button>
            <Link to="/" className="flex items-center gap-2">
              <Box className="h-5 w-5 text-primary" />
              <span className="font-bold">Frak Sandbox</span>
            </Link>
          </header>

          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>

          <Suspense fallback={null}>
            <SystemStatusFooter />
          </Suspense>
        </div>
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
