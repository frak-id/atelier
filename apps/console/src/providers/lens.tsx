import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * The Operator/Builder lens (IMPLEMENTATION_PLAN.md §2): a **display
 * preference over one data model**, never a gate. Advanced/technical surfaces
 * are hidden in Operator lens but nothing consequential (destructive actions,
 * permission decisions) is ever hidden in either lens.
 */
export type Lens = "operator" | "builder";

const STORAGE_KEY = "atelier.lens";

interface LensContextValue {
  lens: Lens;
  setLens: (lens: Lens) => void;
}

const LensContext = createContext<LensContextValue | null>(null);

function readStoredLens(): Lens {
  if (typeof window === "undefined") return "operator";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "builder" ? "builder" : "operator";
}

export function LensProvider({ children }: { children: ReactNode }) {
  const [lens, setLensState] = useState<Lens>(readStoredLens);

  const setLens = useCallback((next: Lens) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setLensState(next);
  }, []);

  const value = useMemo(() => ({ lens, setLens }), [lens, setLens]);

  return <LensContext.Provider value={value}>{children}</LensContext.Provider>;
}

export function useLens(): LensContextValue {
  const ctx = useContext(LensContext);
  if (!ctx) throw new Error("useLens must be used within a LensProvider");
  return ctx;
}
