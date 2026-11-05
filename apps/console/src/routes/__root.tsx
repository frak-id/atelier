import type { QueryClient } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useRouter,
} from "@tanstack/react-router";
import { Boxes, Library, Rocket, Settings } from "lucide-react";
import { Toaster } from "sonner";
import { api } from "@/api/client";
import { currentUserQuery } from "@/api/queries/auth";
import { AccountControls } from "@/components/account-controls";
import { JobsIndicator } from "@/components/jobs-indicator";
import { LoginPage } from "@/components/login-page";
import { TaskInboxEffects } from "@/components/task-inbox/inbox-effects";
import { useJobEvents } from "@/hooks/use-job-events";
import { useTaskInbox } from "@/hooks/use-task-inbox";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootLayout,
});

const NAV_ITEMS = [
  { to: "/", label: "Sandboxes", icon: Boxes, exact: true },
  { to: "/spawn", label: "Spawn", icon: Rocket, exact: true },
  { to: "/library", label: "Library", icon: Library, exact: false },
  { to: "/settings", label: "Settings", icon: Settings, exact: false },
] as const;

/** Count of tasks waiting on the user (finished unseen + failed unseen). */
function TaskBadge() {
  const { attention } = useTaskInbox();
  if (attention === 0) return null;
  return (
    <span
      className="min-w-5 rounded-full bg-primary px-1.5 text-center text-xs font-medium text-primary-foreground"
      role="status"
      aria-label={`${attention} tasks need attention`}
    >
      {attention > 99 ? "99+" : attention}
    </span>
  );
}

function RootLayout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: user, isPending } = useQuery(currentUserQuery());
  // Global job-queue SSE — only connects once authenticated (the feed is
  // behind auth). Called unconditionally to satisfy the rules of hooks.
  useJobEvents(!!user);

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
      <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/95 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] backdrop-blur">
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
              {item.to === "/" ? <TaskBadge /> : null}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <JobsIndicator />
          <AccountControls username={user.username} onLogout={handleLogout} />
        </div>
      </header>
      <TaskInboxEffects />
      <main className="flex-1 p-4 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]">
        <Outlet />
      </main>
      <Toaster richColors position="top-right" />
    </div>
  );
}
