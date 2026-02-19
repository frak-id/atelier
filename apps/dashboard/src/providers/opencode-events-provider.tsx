import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo } from "react";
import { registerOpencodePassword } from "@/api/opencode";
import { sandboxListQuery } from "@/api/queries";
import { syncOpencodeSubscriptions } from "@/lib/opencode-events";

interface OpencodeEventsProviderProps {
  children: ReactNode;
}

export function OpencodeEventsProvider({
  children,
}: OpencodeEventsProviderProps) {
  const queryClient = useQueryClient();

  const { data: sandboxes } = useQuery({
    ...sandboxListQuery(),
    select: (sandboxes) =>
      (sandboxes ?? []).filter((s) => s.status === "running"),
  });

  useEffect(() => {
    for (const s of sandboxes ?? []) {
      if (s.runtime.opencodePassword) {
        registerOpencodePassword(
          s.runtime.urls.opencode,
          s.runtime.opencodePassword,
        );
      }
    }
  }, [sandboxes]);

  const runningSandboxUrls = useMemo(
    () => (sandboxes ?? []).map((s) => s.runtime.urls.opencode).sort(),
    [sandboxes],
  );

  useEffect(() => {
    syncOpencodeSubscriptions(runningSandboxUrls, queryClient);
  }, [runningSandboxUrls, queryClient]);

  return children;
}
