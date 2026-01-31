import { createContext, useCallback, useContext, useState } from "react";
import { SandboxDrawer } from "@/components/sandbox-drawer";
import { TaskDrawer } from "@/components/task-drawer";

type DrawerContextValue = {
  openTask: (id: string) => void;
  openSandbox: (id: string) => void;
};

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function useDrawer() {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error("useDrawer must be used within DrawerProvider");
  return ctx;
}

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);

  const openTask = useCallback((id: string) => setTaskId(id), []);
  const openSandbox = useCallback((id: string) => setSandboxId(id), []);

  return (
    <DrawerContext.Provider value={{ openTask, openSandbox }}>
      {children}
      <TaskDrawer
        taskId={taskId}
        onClose={() => setTaskId(null)}
        onOpenSandbox={(id) => {
          setTaskId(null);
          setSandboxId(id);
        }}
      />
      <SandboxDrawer
        sandboxId={sandboxId}
        onClose={() => setSandboxId(null)}
        onOpenTask={(id) => {
          setSandboxId(null);
          setTaskId(id);
        }}
      />
    </DrawerContext.Provider>
  );
}
