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
  Kanban,
  Loader2,
  LogOut,
  Menu,
  MessageSquare,
  Plug,
  Server,
  Settings,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { checkAuth, logout } from "@/api/client";
import { GitHubStatus } from "@/components/github-status";
import { LoginPage } from "@/components/login-page";
import { SystemStatusFooter } from "@/components/system-status-footer";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DrawerProvider } from "@/providers/drawer-provider";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    component: RootLayout,
  },
);

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useAttentionCount } from "@/hooks/use-attention-count";

function RootLayout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const attentionCount = useAttentionCount();

  useEffect(() => {
    checkAuth()
      .then((user) => {
        if (user) setIsAuthenticated(true);
      })
      .finally(() => setIsCheckingAuth(false));
  }, []);

  const handleLogout = async () => {
    await logout();
    setIsAuthenticated(false);
  };

  if (isCheckingAuth) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  const SidebarContent = () => (
    <nav className="flex-1 p-4 space-y-1">
      <NavLink to="/" icon={Home} badge={attentionCount}>
        Home
      </NavLink>
      <NavLink to="/tasks" icon={Kanban}>
        Tasks
      </NavLink>
      <NavLink to="/threads" icon={MessageSquare}>
        Threads
      </NavLink>
      <NavLink to="/sandboxes" icon={Boxes}>
        Sandboxes
      </NavLink>

      <div className="pt-4">
        <Collapsible>
          <CollapsibleTrigger className="flex items-center justify-between w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors group">
            <span>Admin</span>
            <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 space-y-1 pl-2">
            <NavLink to="/workspaces" icon={FolderGit2}>
              Workspaces
            </NavLink>
            <NavLink to="/images" icon={HardDrive}>
              Images
            </NavLink>
            <NavLink to="/system" icon={Server}>
              System
            </NavLink>
            <NavLink to="/settings" icon={Settings}>
              Settings
            </NavLink>
            <NavLink to="/integrations" icon={Plug}>
              Integrations
            </NavLink>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </nav>
  );

  return (
    <TooltipProvider>
      <DrawerProvider>
        <Toaster position="bottom-right" richColors />
        <div className="flex h-screen bg-background">
          <aside className="hidden md:flex w-64 border-r bg-card flex-col">
            <div className="p-6 border-b">
              <Link to="/" className="flex items-center gap-2">
                <Box className="h-6 w-6 text-primary" />
                <span className="font-bold text-lg">Frak Sandbox</span>
              </Link>
            </div>
            <SidebarContent />
            <div className="p-4 border-t space-y-3">
              <Suspense fallback={null}>
                <GitHubStatus />
              </Suspense>
              <button
                type="button"
                onClick={handleLogout}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-accent"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
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
              <SidebarContent />
              <div className="p-4 border-t space-y-3">
                <Suspense fallback={null}>
                  <GitHubStatus />
                </Suspense>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-accent"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
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
      </DrawerProvider>
    </TooltipProvider>
  );
}

function NavLink({
  to,
  icon: Icon,
  badge,
  children,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors [&.active]:bg-accent [&.active]:text-foreground"
      activeProps={{ className: "active" }}
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1">{children}</span>
      {badge !== undefined && badge > 0 && (
        <Badge
          variant="destructive"
          className="ml-auto px-1.5 py-0 h-5 min-w-[1.25rem] justify-center text-[10px]"
        >
          {badge}
        </Badge>
      )}
    </Link>
  );
}
