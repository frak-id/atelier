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
  url: (Pick<SandboxUrl, "processes" | "ready"> & { url?: string }) | undefined,
  options: {
    /** Replace the default start (the developer-console process action,
     * which toasts per process) — e.g. the Launchpad's quiet start. A
     * rejected promise re-enables `start` (the start failed). */
    startProcesses?: (names: string[]) => Promise<unknown>;
    /** Opening the service IS its first access (a lazy process's trigger):
     * start it on mount instead of waiting for a click. Tried once per
     * service; if that start fails, `start` is the retry. The Launchpad,
     * whose users shouldn't have to find a Start button. */
    startOnOpen?: boolean;
  } = {},
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
  const openedForRef = useRef<string | undefined>(undefined);

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
    if (options.startProcesses) {
      options.startProcesses(gating).catch(() => setStarting(false));
      return;
    }
    for (const name of gating) {
      processAction.mutate({ name, action: "start" });
    }
  }

  // Start-on-open: once per service (keyed by its url), never in a loop.
  const openKey = `${url?.url ?? ""}|${gatingKey}`;
  const opening =
    options.startOnOpen === true &&
    gating.length > 0 &&
    !ready &&
    openedForRef.current !== openKey;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `start` is recreated every render; keyed on the service instead
  useEffect(() => {
    // The ref, not the render-time flag: a re-run (StrictMode's double
    // effect in dev) must not start twice.
    if (!opening || openedForRef.current === openKey) return;
    openedForRef.current = openKey;
    start();
  }, [opening, openKey]);

  if (gating.length === 0) {
    return { status: "pass-through", canMount: true, start, starting: false };
  }
  if (ready && graced) {
    return { status: "ready", canMount: true, start, starting: false };
  }
  // About to start on open counts as starting: no Start-button flash.
  const busy = starting || opening || (ready && !graced);
  return {
    status: busy ? "starting" : "stopped",
    canMount: false,
    start,
    starting: busy,
  };
}
