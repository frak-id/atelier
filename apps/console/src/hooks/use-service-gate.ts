import type { SandboxUrl } from "@atelier/spec";
import { useEffect, useRef, useState } from "react";
import { useProcessAction } from "@/api/queries/sandboxes";

/** Grace period after every gating process reports ready: the readiness
 * probe fires before the ingress/endpoint has actually finished propagating,
 * so mounting the iframe immediately can still race a Bad Gateway. */
const READY_GRACE_MS = 500;

export type ServiceGateStatus =
  | "pass-through"
  | "stopped"
  | "starting"
  | "ready";

export interface ServiceGate {
  status: ServiceGateStatus;
  /** True once `status === "ready"` — the only time callers should mount the
   * iframe. Also true for "pass-through" (no gating processes declared). */
  canMount: boolean;
  /** Start every not-yet-running gating process. No-op when already
   * starting/ready or when there's nothing to gate. */
  start: () => void;
  starting: boolean;
}

/**
 * Gates an iframe behind the processes that must be running for its URL to
 * actually respond (design ui-evolution.md §4.2) — avoids landing on a blank
 * Bad Gateway for a lazy, not-yet-started service (vscode, browser, a
 * harness's web UI).
 *
 * `url.processes`/`url.ready` are recomputed by the server on every sandbox
 * poll (the caller's `sandboxDetailQuery`, which already refetches on an
 * interval); this hook just reacts to that data — it does not poll itself.
 */
export function useServiceGate(
  sandboxId: string,
  url: Pick<SandboxUrl, "url" | "processes" | "ready"> | undefined,
): ServiceGate {
  const processAction = useProcessAction(sandboxId);
  const gating = url?.processes ?? [];
  const ready = url?.ready ?? false;
  // Stable identity for the effect deps: react to *which* processes gate this
  // URL, not just how many (a same-length swap must still reset the grace).
  const gatingKey = gating.join(",");

  // "starting" is local UI intent (user clicked Start) — cleared once the
  // server confirms `ready`, so a stale click can't get stuck forever.
  const [starting, setStarting] = useState(false);
  const [graced, setGraced] = useState(false);
  const gracedForRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (gatingKey === "") return;
    if (!ready) {
      setGraced(false);
      gracedForRef.current = undefined;
      return;
    }
    if (gracedForRef.current === url?.url) return;
    gracedForRef.current = url?.url;
    const timer = setTimeout(() => {
      setGraced(true);
      setStarting(false);
    }, READY_GRACE_MS);
    return () => clearTimeout(timer);
  }, [ready, url?.url, gatingKey]);

  function start() {
    if (gating.length === 0 || ready || starting) return;
    setStarting(true);
    for (const name of gating) {
      processAction.mutate({ name, action: "start" });
    }
  }

  if (gating.length === 0) {
    return { status: "pass-through", canMount: true, start, starting: false };
  }
  if (ready && graced) {
    return { status: "ready", canMount: true, start, starting: false };
  }
  return {
    status: starting || (ready && !graced) ? "starting" : "stopped",
    canMount: false,
    start,
    starting: starting || (ready && !graced),
  };
}
