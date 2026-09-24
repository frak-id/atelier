/**
 * A runtime surface: the processes a sandbox runs and the ports it serves.
 * One scheme wherever it's declared — a toolbox (its tool: code-server,
 * pi-web, the browser stack) or a prebuild (its projects' dev servers) —
 * merged by name into the sandbox spec at spawn (the api/ seam). A `lazy`
 * process starts on first access to a port it gates.
 */
import { Type } from "@sinclair/typebox";
import {
  type PortEntry,
  PortSchema,
  type ProcessEntry,
  ProcessSchema,
} from "./sandbox-spec.ts";

/** The processes one toolbox or prebuild declares (bounded per declarer). */
export const SurfaceProcessesSchema = Type.Array(ProcessSchema, {
  maxItems: 50,
});
/** The ports one toolbox or prebuild declares (bounded per declarer). */
export const SurfacePortsSchema = Type.Array(PortSchema, { maxItems: 50 });

export interface RuntimeSurface {
  processes?: ProcessEntry[];
  ports?: PortEntry[];
}

/**
 * Just the surface of anything carrying one (a toolbox, a prebuild or a
 * sandbox spec), empty lists dropped: `{}` and `{ processes: [] }` are the
 * same surface, and compare equal through `canonicalJson`.
 */
export function runtimeSurfaceOf(from: RuntimeSurface): RuntimeSurface {
  return {
    ...(from.processes?.length ? { processes: from.processes } : {}),
    ...(from.ports?.length ? { ports: from.ports } : {}),
  };
}

/**
 * Which declared processes gate a port (design ui-evolution.md §4.1): every
 * process whose `readiness.port` targets this port, plus a same-name
 * fallback (covers processes without an explicit readiness probe) —
 * deduped. A URL can depend on more than one process (e.g. `browser` needs
 * kasmvnc + openbox + chromium).
 */
export function gatingProcessNames(
  port: Pick<PortEntry, "name" | "port">,
  processes: ProcessEntry[] = [],
): string[] {
  const names = new Set<string>();
  for (const p of processes) {
    const probesThisPort =
      p.readiness && "port" in p.readiness && p.readiness.port === port.port;
    // Same-name fallback covers a process with no port readiness probe, but
    // must NOT pull in a process that explicitly probes a *different* port
    // (its readiness says nothing about this one).
    const probesOtherPort =
      p.readiness && "port" in p.readiness && p.readiness.port !== port.port;
    if (probesThisPort || (p.name === port.name && !probesOtherPort)) {
      names.add(p.name);
    }
  }
  return [...names];
}
