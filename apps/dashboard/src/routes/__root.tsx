import type { QueryClient } from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import {
  AlertTriangle,
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
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  Shield,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { checkAuth, logout } from "@/api/client";
import { GitHubStatus } from "@/components/github-status";
import { LoginPage } from "@/components/login-page";
import { SystemStatusFooter } from "@/components/system-status-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAttentionCount } from "@/hooks/use-attention-count";
import { DrawerProvider } from "@/providers/drawer-provider";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootLayout,
  errorComponent: RootErrorFallback,
});

function RootErrorFallback({ error, reset }: ErrorComponentProps) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-md border-destructive/50">
        <CardHeader>
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <CardTitle>Critical Error</CardTitle>
          </div>
          <CardDescription>
            The application encountered a critical error and cannot continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md font-mono break-all">
            {error instanceof Error ? error.message : "Unknown error"}
          </div>
        </CardContent>
        <CardFooter className="flex justify-between gap-4">
          <Button variant="outline" asChild>
            <Link to="/">Go home</Link>
          </Button>
          <Button onClick={reset}>Try again</Button>
        </CardFooter>
      </Card>
    </div>
  );
}

const ADMIN_ROUTES = ["/workspaces", "/images", "/system", "/settings"];

function useCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("sidebar-collapsed", String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };
  return [collapsed, toggle] as const;
}

function NavLink({
  to,
  icon: Icon,
  badge,
  collapsed,
  children,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
  collapsed?: boolean;
  children: React.ReactNode;
}) {
  const link = (
    <Link
      to={to}
      className={`flex items-center gap-3 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors [&.active]:bg-accent [&.active]:text-foreground ${collapsed ? "justify-center px-2 py-2" : "px-3 py-2"}`}
      activeProps={{ className: "active" }}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1">{children}</span>
          {badge !== undefined && badge > 0 && (
            <Badge
              variant="destructive"
              className="ml-auto px-1.5 py-0 h-5 min-w-[1.25rem] justify-center text-[10px]"
            >
              {badge}
            </Badge>
          )}
        </>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{children}</TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

function SidebarContent({
  attentionCount,
  collapsed,
}: {
  attentionCount: number;
  collapsed?: boolean;
}) {
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  const isAdminRoute = ADMIN_ROUTES.some((r) => pathname.startsWith(r));
  const [adminOpen, setAdminOpen] = useState(isAdminRoute);

  return (
    <nav className={`flex-1 space-y-1 ${collapsed ? "p-2" : "p-4"}`}>
      <NavLink to="/" icon={Home} badge={attentionCount} collapsed={collapsed}>
        Home
      </NavLink>
      <NavLink to="/tasks" icon={Kanban} collapsed={collapsed}>
        Tasks
      </NavLink>
      <NavLink to="/sandboxes" icon={Boxes} collapsed={collapsed}>
        Sandboxes
      </NavLink>

      {collapsed ? (
        <div className="pt-4 space-y-1">
          <div className="flex justify-center py-1">
            <Shield className="h-3.5 w-3.5 text-muted-foreground/50" />
          </div>
          <NavLink to="/workspaces" icon={FolderGit2} collapsed>
            Workspaces
          </NavLink>
          <NavLink to="/images" icon={HardDrive} collapsed>
            Images
          </NavLink>
          <NavLink to="/system" icon={Server} collapsed>
            System
          </NavLink>
          <NavLink to="/settings" icon={Settings} collapsed>
            Settings
          </NavLink>
        </div>
      ) : (
        <div className="pt-4">
          <Collapsible open={adminOpen} onOpenChange={setAdminOpen}>
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
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </nav>
  );
}

function SidebarFooter({
  collapsed,
  onLogout,
}: {
  collapsed: boolean;
  onLogout: () => void;
}) {
  return (
    <div className={`border-t space-y-3 ${collapsed ? "p-2" : "p-4"}`}>
      {!collapsed && (
        <Suspense fallback={null}>
          <GitHubStatus />
        </Suspense>
      )}
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center justify-center w-full px-2 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-accent"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Sign out</TooltipContent>
        </Tooltip>
      ) : (
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-accent"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      )}
      {!collapsed && (
        <div className="text-xs text-muted-foreground">v0.1.0</div>
      )}
    </div>
  );
}

function RootLayout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const attentionCount = useAttentionCount();
  const [collapsed, toggleCollapsed] = useCollapsed();

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

  return (
    <TooltipProvider>
      <DrawerProvider>
        <Toaster position="bottom-right" richColors />
        <div className="flex h-screen bg-background">
          <aside
            className={`hidden md:flex border-r bg-card flex-col transition-all duration-200 ${collapsed ? "w-14" : "w-64"}`}
          >
            <div
              className={`border-b flex items-center justify-between ${collapsed ? "p-3" : "px-6 py-4"}`}
            >
              <Link to="/" className="flex items-center gap-2">
                <Box className="h-6 w-6 text-primary shrink-0" />
                {!collapsed && (
                  <span className="font-bold text-lg">L'atelier</span>
                )}
              </Link>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleCollapsed}
                    className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    {collapsed ? (
                      <PanelLeftOpen className="h-4 w-4" />
                    ) : (
                      <PanelLeftClose className="h-4 w-4" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {collapsed ? "Expand" : "Collapse"}
                </TooltipContent>
              </Tooltip>
            </div>
            <SidebarContent
              attentionCount={attentionCount}
              collapsed={collapsed}
            />
            <SidebarFooter collapsed={collapsed} onLogout={handleLogout} />
          </aside>

          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetContent side="left" className="w-64 p-0">
              <SheetHeader className="p-6 border-b">
                <SheetTitle>
                  <Link to="/" className="flex items-center gap-2">
                    <Box className="h-6 w-6 text-primary" />
                    <span className="font-bold text-lg">L'atelier</span>
                  </Link>
                </SheetTitle>
              </SheetHeader>
              <SidebarContent attentionCount={attentionCount} />
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
                <span className="font-bold">L'atelier</span>
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
