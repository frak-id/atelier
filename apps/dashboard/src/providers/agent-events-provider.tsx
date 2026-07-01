import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo } from "react";
import { sandboxListQuery } from "@/api/queries";
import { syncAgentSubscriptions } from "@/lib/agent-events";

interface AgentEventsProviderProps {
  children: ReactNode;
}

export function AgentEventsProvider({ children }: AgentEventsProviderProps) {
  const queryClient = useQueryClient();

  const { data: sandboxes } = useQuery({
    ...sandboxListQuery(),
    select: (sandboxes) =>
      (sandboxes ?? []).filter((s) => s.status === "running"),
  });

  const runningSandboxIds = useMemo(
    () => (sandboxes ?? []).map((s) => s.id).sort(),
    [sandboxes],
  );

  useEffect(() => {
    syncAgentSubscriptions(runningSandboxIds, queryClient);
  }, [runningSandboxIds, queryClient]);

  return children;
}
