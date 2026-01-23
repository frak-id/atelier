import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
} from "@tanstack/react-router";
import { Box, Menu } from "lucide-react";
import { Suspense, useState } from "react";
import { clearAuthToken, getAuthToken } from "@/api/client";
import { MobileSidebar } from "@/components/layout/mobile-sidebar";
import { Sidebar } from "@/components/layout/sidebar";
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
import { useSidebarState } from "@/hooks/use-sidebar-state";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    component: RootLayout,
  },
);

function RootLayout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { collapsed, toggle } = useSidebarState();
  const [isAuthenticated, setIsAuthenticated] = useState(
    () => !!getAuthToken(),
  );

  const handleLogout = () => {
    clearAuthToken();
    setIsAuthenticated(false);
  };

  if (!isAuthenticated) {
    return <LoginPage onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background">
        <Sidebar
          collapsed={collapsed}
          onToggle={toggle}
          onLogout={handleLogout}
          attentionCount={0}
        />

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
            <MobileSidebar
              onLogout={handleLogout}
              onClose={() => setMobileMenuOpen(false)}
            />
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
