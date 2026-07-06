import type { QueryClient } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useRouter,
} from "@tanstack/react-router";
import { Boxes, LogOut, Moon, Rocket, Settings, Sun } from "lucide-react";
import { Toaster } from "sonner";
import { api } from "@/api/client";
import { currentUserQuery } from "@/api/queries/auth";
import { LoginPage } from "@/components/login-page";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useLens } from "@/providers/lens";
import { useTheme } from "@/providers/theme";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootLayout,
});

const NAV_ITEMS = [
  { to: "/", label: "Sandboxes", icon: Boxes, exact: true },
  { to: "/spawn", label: "Spawn", icon: Rocket, exact: true },
  { to: "/settings", label: "Settings", icon: Settings, exact: false },
] as const;

function RootLayout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: user, isPending } = useQuery(currentUserQuery());
  const { theme, toggle } = useTheme();
  const { lens, setLens } = useLens();

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <LoginPage />
        <Toaster richColors position="top-right" />
      </>
    );
  }

  async function handleLogout() {
    try {
      await api.auth.logout.post();
    } finally {
      queryClient.clear();
      await router.invalidate();
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/95 px-4 py-3 backdrop-blur">
        <nav className="flex items-center gap-1">
          <span className="mr-3 font-semibold">Atelier</span>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:px-3 [&.active]:bg-muted [&.active]:text-foreground"
              activeOptions={{ exact: item.exact }}
              title={item.label}
            >
              <item.icon className="size-4 shrink-0" />
              <span className="hidden sm:inline">{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <SegmentedControl
            options={[
              { value: "operator", label: "Overview" },
              { value: "builder", label: "Developer" },
            ]}
            value={lens}
            onChange={setLens}
            className="hidden sm:inline-flex"
          />
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {user.username}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          >
            {theme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>
          <Button variant="ghost" size="icon" onClick={handleLogout}>
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>
      <main className="flex-1 p-4">
        <Outlet />
      </main>
      <Toaster richColors position="top-right" />
    </div>
  );
}
