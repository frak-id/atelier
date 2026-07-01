import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { sandboxListQuery } from "@/api/queries";
import { SandboxDrawer } from "@/components/sandbox-drawer";

type DrawerContextValue = {
  openSandbox: (id: string) => void;
};

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function useDrawer() {
  const ctx = useContext(DrawerContext);
  if (!ctx) throw new Error("useDrawer must be used within DrawerProvider");
  return ctx;
}

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [sandboxId, setSandboxId] = useState<string | null>(null);

  const openSandbox = useCallback((id: string) => setSandboxId(id), []);

  const { data: sandboxes } = useQuery({
    ...sandboxListQuery(),
    enabled: !!sandboxId,
  });

  // Auto-close drawer when entity disappears from list
  useEffect(() => {
    if (!sandboxId || !sandboxes) return;
    if (!sandboxes.some((s) => s.id === sandboxId)) {
      setSandboxId(null);
    }
  }, [sandboxId, sandboxes]);

  return (
    <DrawerContext.Provider value={{ openSandbox }}>
      {children}
      <SandboxDrawer sandboxId={sandboxId} onClose={() => setSandboxId(null)} />
    </DrawerContext.Provider>
  );
}
