import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { sandboxListQuery } from "@/api/queries";
import { syncOpencodeSubscriptions } from "@/lib/opencode-events";

interface OpencodeEventsProviderProps {
  children: ReactNode;
}

export function OpencodeEventsProvider({
  children,
}: OpencodeEventsProviderProps) {
  const queryClient = useQueryClient();

  const { data: runningSandboxUrls } = useQuery({
    ...sandboxListQuery(),
    select: (sandboxes) =>
      (sandboxes ?? [])
        .filter((s) => s.status === "running")
        .map((s) => s.runtime.urls.opencode)
        .sort(),
  });

  useEffect(() => {
    syncOpencodeSubscriptions(runningSandboxUrls ?? [], queryClient);
  }, [runningSandboxUrls, queryClient]);

  return children;
}
