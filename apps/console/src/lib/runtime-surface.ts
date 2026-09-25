/**
 * The visual model behind `RuntimeSurfaceField`: a `RuntimeSurface`
 * (`processes[]` + `ports[]`) read as *services* — a process and the port of
 * the same name it serves — plus the ports no same-name process owns (gated
 * by another process's `readiness.port`, e.g. the browser toolbox's
 * `browser` port behind `kasmvnc`).
 *
 * Every edit is applied in place to the two arrays (order and untouched keys
 * kept), so a visual round-trip never rewrites what it didn't show. Pure, so
 * the linking rules are testable without a DOM.
 */
import {
  gatingProcessNames,
  type PortEntry,
  type ProcessEntry,
  type Readiness,
  type RuntimeSurface,
} from "@atelier/spec";

export type ServiceRow = {
  kind: "service";
  processIndex: number;
  process: ProcessEntry;
  /** The port of the same name, when the process serves one. */
  portIndex?: number;
  port?: PortEntry;
};

export type PortRow = {
  kind: "port";
  portIndex: number;
  port: PortEntry;
  /** Processes whose readiness gates this port (the runtime's own rule). */
  gatedBy: string[];
};

export type SurfaceRow = ServiceRow | PortRow;

/** Processes in declaration order, each with its same-name port; then the
 * ports no process claims by name. A duplicate port name is left unlinked
 * (it shows as its own row, flagged). */
export function surfaceRows(surface: RuntimeSurface): SurfaceRow[] {
  const processes = surface.processes ?? [];
  const ports = surface.ports ?? [];
  const linked = new Set<number>();
  const rows: SurfaceRow[] = processes.map((process, processIndex) => {
    const portIndex = ports.findIndex(
      (port, i) => port.name === process.name && !linked.has(i),
    );
    if (portIndex === -1) return { kind: "service", processIndex, process };
    linked.add(portIndex);
    return {
      kind: "service",
      processIndex,
      process,
      portIndex,
      port: ports[portIndex],
    };
  });
  ports.forEach((port, portIndex) => {
    if (linked.has(portIndex)) return;
    rows.push({
      kind: "port",
      portIndex,
      port,
      gatedBy: gatingProcessNames(port, processes),
    });
  });
  return rows;
}

// ── exposure ────────────────────────────────────────────────────────────────

/** Who can reach a port: `private` (in-sandbox only, no URL), `login`
 * (public URL behind the operator's forward auth) or `open` (public URL,
 * no auth). */
export type Exposure = "private" | "login" | "open";

export function exposureOf(port: PortEntry): Exposure {
  if (!port.public) return "private";
  return port.auth === "forward" ? "login" : "open";
}

function withExposure(port: PortEntry, exposure: Exposure): PortEntry {
  const { public: _public, auth: _auth, ...rest } = port;
  if (exposure === "private") return rest;
  return {
    ...rest,
    public: true,
    auth: exposure === "login" ? "forward" : "none",
  };
}

// ── edits ───────────────────────────────────────────────────────────────────

/** Drop `undefined` keys so an edit never serializes `"key": undefined`
 * holes (and a cleared field disappears from the JSON). */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

/** Empty lists dropped: `{}` and `{ processes: [] }` are the same surface. */
function normalize(
  processes: ProcessEntry[],
  ports: PortEntry[],
): RuntimeSurface {
  return {
    processes: processes.length > 0 ? processes : undefined,
    ports: ports.length > 0 ? ports : undefined,
  };
}

function readinessPort(readiness?: Readiness): number | undefined {
  return readiness && "port" in readiness ? readiness.port : undefined;
}

/**
 * Patch one process. A rename carries its identity along: the same-name port
 * (the one this service serves) and every `after` reference to it follow.
 */
export function updateProcess(
  surface: RuntimeSurface,
  processIndex: number,
  patch: Partial<ProcessEntry>,
): RuntimeSurface {
  const processes = surface.processes ?? [];
  let ports = surface.ports ?? [];
  const current = processes[processIndex];
  if (!current) return surface;
  const next = compact({ ...current, ...patch });
  // Only a unique name is an identity worth carrying: while two processes
  // share one (a half-typed rename), references belong to the other one.
  const renamed =
    patch.name !== undefined &&
    patch.name !== current.name &&
    processes.filter((p) => p.name === current.name).length === 1;

  let nextProcesses = processes.map((p, i) => (i === processIndex ? next : p));
  if (renamed) {
    const row = surfaceRows(surface).find(
      (r): r is ServiceRow =>
        r.kind === "service" && r.processIndex === processIndex,
    );
    if (row?.portIndex !== undefined) {
      const linkedIndex = row.portIndex;
      ports = ports.map((port, i) =>
        i === linkedIndex ? { ...port, name: next.name } : port,
      );
    }
    nextProcesses = nextProcesses.map((p) =>
      p.after?.includes(current.name)
        ? {
            ...p,
            after: p.after.map((name) =>
              name === current.name ? next.name : name,
            ),
          }
        : p,
    );
  }
  return normalize(nextProcesses, ports);
}

/** Set who can reach a port (a whole-entry replace: `private` drops the
 * `public`/`auth` keys, which a patch can't express). */
export function setPortExposure(
  surface: RuntimeSurface,
  portIndex: number,
  exposure: Exposure,
): RuntimeSurface {
  const ports = (surface.ports ?? []).map((port, i) =>
    i === portIndex ? withExposure(port, exposure) : port,
  );
  return normalize(surface.processes ?? [], ports);
}

/** Patch one port entry (by its index in `ports[]`). */
export function updatePort(
  surface: RuntimeSurface,
  portIndex: number,
  patch: Partial<PortEntry>,
): RuntimeSurface {
  const ports = (surface.ports ?? []).map((port, i) =>
    i === portIndex ? compact({ ...port, ...patch }) : port,
  );
  return normalize(surface.processes ?? [], ports);
}

/**
 * Set (or clear, with `undefined`) the port a service serves. A new port
 * starts behind login; a readiness probe on the old port number follows the
 * new one (and goes with it on clear), and a process without any readiness
 * gets a port probe, so opening the URL waits for the server to listen.
 */
export function setServicePort(
  surface: RuntimeSurface,
  processIndex: number,
  portNumber: number | undefined,
): RuntimeSurface {
  const processes = surface.processes ?? [];
  const ports = surface.ports ?? [];
  const row = surfaceRows(surface).find(
    (r): r is ServiceRow =>
      r.kind === "service" && r.processIndex === processIndex,
  );
  if (!row) return surface;
  const { process } = row;
  const oldNumber = row.port?.port;
  const probesOld =
    oldNumber !== undefined && readinessPort(process.readiness) === oldNumber;

  let readiness = process.readiness;
  if (portNumber === undefined) {
    if (probesOld) readiness = undefined;
  } else if (probesOld || readiness === undefined) {
    readiness = { port: portNumber };
  }
  const nextProcesses = processes.map((p, i) =>
    i === processIndex ? compact({ ...p, readiness }) : p,
  );

  let nextPorts: PortEntry[];
  if (portNumber === undefined) {
    nextPorts = ports.filter((_, i) => i !== row.portIndex);
  } else if (row.portIndex !== undefined) {
    const linkedIndex = row.portIndex;
    nextPorts = ports.map((port, i) =>
      i === linkedIndex ? { ...port, port: portNumber } : port,
    );
  } else {
    nextPorts = [
      ...ports,
      { name: process.name, port: portNumber, public: true, auth: "forward" },
    ];
  }
  return normalize(nextProcesses, nextPorts);
}

/** Remove a service: its process, the port it serves, and every `after`
 * reference to it (a dangling `after` would wait forever). */
export function removeService(
  surface: RuntimeSurface,
  processIndex: number,
): RuntimeSurface {
  const row = surfaceRows(surface).find(
    (r): r is ServiceRow =>
      r.kind === "service" && r.processIndex === processIndex,
  );
  if (!row) return surface;
  const name = row.process.name;
  const processes = (surface.processes ?? [])
    .filter((_, i) => i !== processIndex)
    .map((p) => {
      if (!p.after?.includes(name)) return p;
      const after = p.after.filter((n) => n !== name);
      return compact({ ...p, after: after.length > 0 ? after : undefined });
    });
  const ports = (surface.ports ?? []).filter((_, i) => i !== row.portIndex);
  return normalize(processes, ports);
}

export function removePort(
  surface: RuntimeSurface,
  portIndex: number,
): RuntimeSurface {
  return normalize(
    surface.processes ?? [],
    (surface.ports ?? []).filter((_, i) => i !== portIndex),
  );
}

/** `base`, else `base-2`, `base-3`… — the first not in `taken`. */
function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function takenNames(surface: RuntimeSurface): string[] {
  return [
    ...(surface.processes ?? []).map((p) => p.name),
    ...(surface.ports ?? []).map((p) => p.name),
  ];
}

function freePort(surface: RuntimeSurface, from: number): number {
  const used = new Set((surface.ports ?? []).map((p) => p.port));
  let port = from;
  while (used.has(port)) port++;
  return port;
}

export interface ServiceDefaults {
  /** Base of the new name (made unique): `web`, `worker`… */
  name?: string;
  /** uid new processes run as (a prebuild's dev servers: `dev`). */
  user?: string;
  cwd?: string;
  /** Start on first open rather than at boot. */
  lazy?: boolean;
  /** Serve a port from the start (a dev server), or not (a watcher). */
  port?: number;
}

/** Append a service: a process, and (by default) the port it serves, behind
 * login, with a readiness probe on it. */
export function addService(
  surface: RuntimeSurface,
  defaults: ServiceDefaults = {},
): RuntimeSurface {
  const name = uniqueName(defaults.name ?? "web", takenNames(surface));
  const process: ProcessEntry = compact({
    name,
    command: "",
    cwd: defaults.cwd,
    user: defaults.user,
    lazy: defaults.lazy,
  });
  const withProcess = normalize(
    [...(surface.processes ?? []), process],
    surface.ports ?? [],
  );
  if (defaults.port === undefined) return withProcess;
  return setServicePort(
    withProcess,
    (withProcess.processes?.length ?? 1) - 1,
    freePort(surface, defaults.port),
  );
}

/** Append a bare port (served by something declared elsewhere, or gated by
 * a process's `readiness.port`). */
export function addPort(surface: RuntimeSurface): RuntimeSurface {
  const port: PortEntry = {
    name: uniqueName("port", takenNames(surface)),
    port: freePort(surface, 8080),
    public: true,
    auth: "forward",
  };
  return normalize(surface.processes ?? [], [...(surface.ports ?? []), port]);
}

/** Working directories worth offering: each repo's clone path, which is
 * relative to the `dev` home unless absolute. */
export function cloneCwds(
  repos: readonly { clonePath: string }[] = [],
): string[] {
  const cwds = repos
    .map((repo) => repo.clonePath.trim().replace(/\/+$/, ""))
    .filter((path) => path.length > 0)
    .map((path) => (path.startsWith("/") ? path : `/home/dev/${path}`));
  return [...new Set(cwds)];
}

// ── validation ──────────────────────────────────────────────────────────────

/** A port name is the leftmost label of its public hostname
 * (`{name}-{sandboxId}.{domain}`): lowercase letters, digits, dashes. */
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export interface ProcessIssues {
  name?: string;
  command?: string;
  env?: string;
  readiness?: string;
}

export interface PortIssues {
  name?: string;
  port?: string;
}

function portNumberIssue(port: number): string | undefined {
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "A port is a number from 1 to 65535.";
}

function portNameIssue(
  surface: RuntimeSurface,
  portIndex: number,
): string | undefined {
  const ports = surface.ports ?? [];
  const port = ports[portIndex];
  if (!port) return undefined;
  if (!port.name.trim()) return "Give it a name.";
  if (ports.some((p, i) => i !== portIndex && p.name === port.name)) {
    return `Another port is already named "${port.name}".`;
  }
  if (port.public && !DNS_LABEL_RE.test(port.name)) {
    return "Used in its URL: lowercase letters, digits and dashes only.";
  }
  return undefined;
}

/** Blocking problems with one process (and, for a service, the port it
 * serves shares its name, so a port-name problem shows on the name). */
export function processIssues(
  surface: RuntimeSurface,
  processIndex: number,
): ProcessIssues {
  const processes = surface.processes ?? [];
  const process = processes[processIndex];
  if (!process) return {};
  const issues: ProcessIssues = {};
  if (!process.name.trim()) {
    issues.name = "Give it a name.";
  } else if (
    processes.some((p, i) => i !== processIndex && p.name === process.name)
  ) {
    issues.name = `Another process is already named "${process.name}".`;
  } else {
    const row = surfaceRows(surface).find(
      (r): r is ServiceRow =>
        r.kind === "service" && r.processIndex === processIndex,
    );
    if (row?.portIndex !== undefined) {
      issues.name = portNameIssue(surface, row.portIndex);
    }
  }
  if (!process.command.trim()) issues.command = "What should it run?";
  if (process.env && "" in process.env) {
    issues.env = "Every variable needs a name.";
  }
  const readiness = process.readiness;
  if (readiness) {
    if ("port" in readiness) {
      const issue = portNumberIssue(readiness.port);
      if (issue) issues.readiness = issue;
    } else if ("http" in readiness) {
      const http = readiness.http.trim();
      // The agent resolves a bare path against the same-name port.
      const absolute = /^https?:\/\//.test(http);
      const served = (surface.ports ?? []).some((p) => p.name === process.name);
      if (!http) {
        issues.readiness = "Which URL answers when it's ready?";
      } else if (!absolute && !served) {
        issues.readiness =
          "A path is checked on the port this serves: add one, or use a full http:// URL.";
      }
    } else if ("cmd" in readiness && !readiness.cmd.trim()) {
      issues.readiness = "Which command succeeds when it's ready?";
    }
  }
  return compact(issues);
}

export function portIssues(
  surface: RuntimeSurface,
  portIndex: number,
): PortIssues {
  const port = surface.ports?.[portIndex];
  if (!port) return {};
  return compact({
    name: portNameIssue(surface, portIndex),
    port: portNumberIssue(port.port),
  });
}

/** Non-blocking hints: configurations that parse but likely don't do what
 * the author meant. */
export function processWarnings(
  surface: RuntimeSurface,
  processIndex: number,
): string[] {
  const processes = surface.processes ?? [];
  const process = processes[processIndex];
  if (!process) return [];
  const warnings: string[] = [];
  const row = surfaceRows(surface).find(
    (r): r is ServiceRow =>
      r.kind === "service" && r.processIndex === processIndex,
  );
  const probed = readinessPort(process.readiness);
  if (row?.port && probed !== undefined && probed !== row.port.port) {
    warnings.push(
      `Its readiness probes port ${probed}, not the ${row.port.port} it serves: opening it won't wait for (or start) this process.`,
    );
  }
  const names = new Set(processes.map((p) => p.name));
  const unknown = (process.after ?? []).filter((name) => !names.has(name));
  if (unknown.length > 0) {
    warnings.push(
      `Waits for ${unknown.map((n) => `"${n}"`).join(", ")}, not declared here: it must come from another toolbox or prebuild.`,
    );
  }
  return warnings;
}

/** Whether the surface can be saved (no blocking issue anywhere). */
export function surfaceValid(surface: RuntimeSurface): boolean {
  const processesOk = (surface.processes ?? []).every(
    (_, i) => Object.keys(processIssues(surface, i)).length === 0,
  );
  const portsOk = (surface.ports ?? []).every(
    (_, i) => Object.keys(portIssues(surface, i)).length === 0,
  );
  return processesOk && portsOk;
}
