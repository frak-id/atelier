import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { sandboxListQuery, workspaceListQuery } from "@/api/queries";
import { RecentSessionsCard } from "@/components/recent-sessions-card";
import { RunningSandboxesCard } from "@/components/running-sandboxes-card";
import { StartSessionCard } from "@/components/start-session-card";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/")({
  component: HomePage,
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(workspaceListQuery());
    context.queryClient.ensureQueryData(sandboxListQuery());
  },
  pendingComponent: HomeSkeleton,
});

function HomePage() {
  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Welcome back</h1>
        <p className="text-muted-foreground">
          Start a new session or continue where you left off
        </p>
      </div>

      <Suspense fallback={<Skeleton className="h-[200px]" />}>
        <StartSessionCard />
      </Suspense>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Suspense fallback={<Skeleton className="h-[300px]" />}>
          <RecentSessionsCard />
        </Suspense>

        <Suspense fallback={<Skeleton className="h-[300px]" />}>
          <RunningSandboxesCard />
        </Suspense>
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-4 w-64 mt-2" />
      </div>
      <Skeleton className="h-[200px]" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Skeleton className="h-[300px]" />
        <Skeleton className="h-[300px]" />
      </div>
    </div>
  );
}
