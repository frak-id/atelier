import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { startManagerEvents, stopManagerEvents } from "@/lib/manager-events";

interface ManagerEventsProviderProps {
  children: ReactNode;
}

export function ManagerEventsProvider({
  children,
}: ManagerEventsProviderProps) {
  const queryClient = useQueryClient();

  useEffect(() => {
    startManagerEvents(queryClient);
    return () => stopManagerEvents();
  }, [queryClient]);

  return children;
}
