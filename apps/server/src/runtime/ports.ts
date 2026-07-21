/**
 * Ingress construction from a spec's `ports[]`. Mechanism only: a port entry
 * becomes an Ingress routed at `{name}-{sandboxId}.{baseDomain}`. `auth:
 * "forward"` attaches the operator's forward-auth annotations. No service
 * types, no protocols, no LB config (atelier-v2 §2 "ports stay thin").
 */
import type { PortEntry, ProcessEntry } from "@atelier/spec";
import { config } from "../shared/lib/config.ts";
import {
  buildToolIngress,
  type KubeResource,
  toolHost,
  toolIngressName,
} from "./kube/index.ts";

function sandboxDomain(): string {
  return config.domain.baseDomain;
}

/** Forward-auth annotations mandated by the operator (reused from v1 config). */
function forwardAuthAnnotations(): Record<string, string> {
  return config.kubernetes.vsCodeIngressAnnotations ?? {};
}

/**
 * cert-manager annotations for per-host TLS via HTTP-01. Returns undefined
 * when no ClusterIssuer is configured (TLS disabled on tool ingresses).
 */
function certManagerAnnotations(): Record<string, string> | undefined {
  const issuer = config.kubernetes.toolIngressClusterIssuer;
  if (!issuer) return undefined;
  return {
    "cert-manager.io/cluster-issuer": issuer,
    "kubernetes.io/tls-acme": "true",
  };
}

export function buildPortIngresses(
  sandboxId: string,
  ports: PortEntry[] = [],
): KubeResource[] {
  const tlsAnnotations = certManagerAnnotations();
  return ports
    .filter((p) => p.public)
    .map((p) => {
      const annotations = {
        ...tlsAnnotations,
        ...(p.auth === "forward" ? forwardAuthAnnotations() : {}),
      };
      return buildToolIngress({
        sandboxId,
        subdomain: p.name,
        port: p.port,
        sandboxDomain: sandboxDomain(),
        ingressClassName: config.kubernetes.ingressClassName || undefined,
        annotations: Object.keys(annotations).length ? annotations : undefined,
        // Per-host cert secret (cert-manager fills it via the issuer above).
        tlsSecretName: tlsAnnotations
          ? `${toolIngressName(p.name, sandboxId)}-tls`
          : undefined,
      });
    });
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

/**
 * Which declared processes gate a port (design ui-evolution.md §4.1): every
 * process whose `readiness.port` targets this port, plus a same-name
 * fallback (covers processes without an explicit readiness probe) —
 * deduped. A URL can depend on more than one process (e.g. `browser` needs
 * kasmvnc + openbox + chromium).
 */
export function gatingProcessNames(
  port: PortEntry,
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

export function sshUrl(sandboxId: string): string {
  const sshHost =
    config.domain.ssh.hostname || `ssh.${config.domain.baseDomain}`;
  const sshPort = config.domain.ssh.port;
  return sshPort === 22
    ? `ssh ${sandboxId}@${sshHost}`
    : `ssh ${sandboxId}@${sshHost} -p ${sshPort}`;
}
