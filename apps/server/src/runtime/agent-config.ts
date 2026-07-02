/**
 * Project a resolved `SandboxSpec` onto the v2 guest agent's pushed config
 * (`apps/agent-v2` `AgentConfig`, config.rs). This is the seam artifact: a thin
 * projection, never a reshape. The runtime pushes this via `PUT /config`; it is
 * never ConfigMap-mounted, because per-process `env` may carry resolved secret
 * values that must not land in etcd or a pause snapshot.
 *
 * What crosses into the guest: `sandboxId`, `env`, `processes[]`, `ports[]`,
 * `hooks`. What never crosses (and why): `source`/`resources` (the runtime
 * already picked the image and Kata enforces resources), `caches` (PVC mounts),
 * `files[]` (pushed separately via `files/write` — contents never persist in
 * config), `metadata`/`annotations` (runtime-side observability),
 * `timeoutSeconds` (runtime lifecycle). The Rust side is
 * `deny_unknown_fields`, so any drift fails loudly at `PUT /config`.
 *
 * Mirrors v1's lossy `specToSandboxConfig` (which collapsed a process to a
 * `services` entry keeping only `readiness.port`); the v2 projection is
 * lossless across the full process model.
 */
import {
  type Hooks,
  isSecretRef,
  type MaybeSecretString,
  type PortEntry,
  type ProcessEntry,
  type Readiness,
  type RestartPolicy,
  type SandboxSpec,
  type StdioMode,
} from "@atelier/spec";

/** The guest-agent view of a process (spec `ProcessEntry` with `env` resolved
 * to plain strings). Field set is identical so the projection is lossless. */
export interface AgentProcess {
  name: string;
  command: string;
  cwd?: string;
  user?: string;
  env?: Record<string, string>;
  primary?: boolean;
  stdio?: StdioMode;
  pty?: boolean;
  readiness?: Readiness;
  after?: string[];
  restart?: RestartPolicy;
  lazy?: boolean;
}

/** The forwarder subset of a port — `public`/`auth` are ingress concerns and
 * never reach the guest. */
export interface AgentPort {
  name: string;
  port: number;
}

/** The full pushed config, mirroring `apps/agent-v2` config.rs `AgentConfig`. */
export interface AgentConfig {
  sandboxId: string;
  env?: Record<string, string>;
  processes?: AgentProcess[];
  ports?: AgentPort[];
  hooks?: Hooks;
}

export function specToAgentConfig(
  sandboxId: string,
  spec: SandboxSpec,
): AgentConfig {
  const config: AgentConfig = { sandboxId };
  const env = resolveEnv(spec.env);
  if (env) config.env = env;
  if (spec.processes && spec.processes.length > 0) {
    config.processes = spec.processes.map(projectProcess);
  }
  if (spec.ports && spec.ports.length > 0) {
    config.ports = spec.ports.map((p: PortEntry) => ({
      name: p.name,
      port: p.port,
    }));
  }
  if (spec.hooks) config.hooks = spec.hooks;
  return config;
}

function projectProcess(p: ProcessEntry): AgentProcess {
  const out: AgentProcess = { name: p.name, command: p.command };
  if (p.cwd !== undefined) out.cwd = p.cwd;
  if (p.user !== undefined) out.user = p.user;
  const env = resolveEnv(p.env);
  if (env) out.env = env;
  if (p.primary !== undefined) out.primary = p.primary;
  if (p.stdio !== undefined) out.stdio = p.stdio;
  if (p.pty !== undefined) out.pty = p.pty;
  if (p.readiness !== undefined) out.readiness = p.readiness;
  if (p.after !== undefined) out.after = p.after;
  if (p.restart !== undefined) out.restart = p.restart;
  if (p.lazy !== undefined) out.lazy = p.lazy;
  return out;
}

/**
 * Resolve a spec env map to plain strings. Secret refs must already be
 * substituted by control before the spec crosses the seam
 * (`RuntimeService.rejectUnresolvedSecrets`); a ref reaching here is a bug, so
 * fail loudly rather than silently drop the value.
 */
function resolveEnv(
  env?: Record<string, MaybeSecretString>,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (isSecretRef(v)) {
      throw new Error(
        `specToAgentConfig: unresolved secret ref in env.${k}; secrets must be resolved before the seam`,
      );
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
