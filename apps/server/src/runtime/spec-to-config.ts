/**
 * Translate a `SandboxSpec` into the in-pod `config.json` the guest agent
 * reads (the `SandboxConfig` wire contract in @frak/atelier-shared). This is
 * the mechanism replacement for v1's `buildSandboxConfig(workspace, …)`: no
 * Workspace, only the resolved spec.
 *
 * Note: the v2 agent line (atelier-v2 §6 phase 1) will consume `processes`
 * with `readiness`/`primary` natively. Until then we map `processes[]` onto
 * the existing `services` record so a v1 agent image can still boot a spec.
 *
 * Note: top-level `spec.env` is NOT mapped here — there is no pod-wide env
 * surface in `SandboxConfig` today, only per-service `env` (see
 * `processToService`, which already guards non-string/secret-ref values).
 * `spec.env` is currently write-only (stored on the record, merged by
 * `patchEnv`/resume) until the v2 agent gains a generic env surface;
 * `RuntimeService.create/resume/addProcess` all reject unresolved secret
 * refs on the full spec before it reaches this function regardless.
 */
import type { ProcessEntry, SandboxSpec } from "@atelier/spec";
import type {
  SandboxConfig,
  SandboxServiceEntry,
} from "@frak/atelier-shared/sandbox-config";
import { config } from "../shared/lib/config.ts";

function processToService(p: ProcessEntry): SandboxServiceEntry {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.env ?? {})) {
    // Secret refs must already be resolved before reaching the runtime.
    if (typeof v === "string") env[k] = v;
  }
  return {
    command: p.command,
    workdir: p.cwd,
    autoStart: p.lazy !== true,
    env: Object.keys(env).length > 0 ? env : undefined,
    port: p.readiness && "port" in p.readiness ? p.readiness.port : undefined,
    enabled: true,
  };
}

export function specToSandboxConfig(
  sandboxId: string,
  spec: SandboxSpec,
): SandboxConfig {
  const services: Record<string, SandboxServiceEntry> = {};
  for (const p of spec.processes ?? []) {
    services[p.name] = processToService(p);
  }

  return {
    sandboxId,
    workspaceId: spec.metadata?.workspace,
    workspaceName: spec.metadata?.workspace,
    repos: [],
    createdAt: new Date().toISOString(),
    network: {
      dashboardDomain: config.domain.dashboard || config.domain.baseDomain,
      managerInternalUrl: `${config.kubernetes.managerUrl}/internal`,
    },
    services,
  };
}
