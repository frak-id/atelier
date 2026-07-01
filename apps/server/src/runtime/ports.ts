/**
 * Ingress construction from a spec's `ports[]`. Mechanism only: a port entry
 * becomes an Ingress routed at `{name}-{sandboxId}.{baseDomain}`. `auth:
 * "forward"` attaches the operator's forward-auth annotations. No service
 * types, no protocols, no LB config (atelier-v2 §2 "ports stay thin").
 */
import type { PortEntry } from "@atelier/spec";
import { config } from "../shared/lib/config.ts";
import { buildToolIngress, type KubeResource, toolHost } from "./kube/index.ts";

function sandboxDomain(): string {
  return config.domain.baseDomain;
}

/** Forward-auth annotations mandated by the operator (reused from v1 config). */
function forwardAuthAnnotations(): Record<string, string> {
  return config.kubernetes.vsCodeIngressAnnotations ?? {};
}

export function buildPortIngresses(
  sandboxId: string,
  ports: PortEntry[] = [],
): KubeResource[] {
  return ports
    .filter((p) => p.public)
    .map((p) =>
      buildToolIngress({
        sandboxId,
        subdomain: p.name,
        port: p.port,
        sandboxDomain: sandboxDomain(),
        ingressClassName: config.kubernetes.ingressClassName || undefined,
        annotations:
          p.auth === "forward" ? forwardAuthAnnotations() : undefined,
      }),
    );
}

/** Public URLs for a spec's declared ports. */
export function buildPortUrls(
  sandboxId: string,
  ports: PortEntry[] = [],
): { name: string; url: string }[] {
  const scheme = config.domain.baseDomain.includes("localhost")
    ? "http"
    : "https";
  return ports
    .filter((p) => p.public)
    .map((p) => ({
      name: p.name,
      url: `${scheme}://${toolHost(p.name, sandboxId, sandboxDomain())}`,
    }));
}

export function sshUrl(sandboxId: string): string {
  const sshHost =
    config.domain.ssh.hostname || `ssh.${config.domain.baseDomain}`;
  const sshPort = config.domain.ssh.port;
  return sshPort === 22
    ? `ssh ${sandboxId}@${sshHost}`
    : `ssh ${sandboxId}@${sshHost} -p ${sshPort}`;
}
