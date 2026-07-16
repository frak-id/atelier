/**
 * The in-server SSH gateway module. Composition-root concern: it wires the
 * ssh2 proxy (runtime-neutral networking) to the control SSH keys + host-key
 * store and the runtime's upstream-key + endpoint resolution. Lives OUTSIDE
 * `runtime/` because it needs `control/` (host key, dev keys) — the boundary
 * check forbids that inside `runtime/`.
 */
import type { ServerContainer } from "../api/container.ts";
import {
  ensureSharedSshPipeKey,
  getSharedSshPipeKeyOpenSSH,
} from "../runtime/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { ensureInServerHostKey } from "./host-key.ts";
import {
  type InServerSshGateway,
  startInServerSshGateway,
  type UpstreamTarget,
} from "./proxy.ts";

export type { InServerSshGateway } from "./proxy.ts";
export { startInServerSshGateway } from "./proxy.ts";

const log = createChildLogger("ssh-gateway");

/**
 * Boot the in-server ssh2 gateway from the composition root. No-op-returns
 * `null` for any strategy other than `in-server`. Requires the shared ssh-pipe
 * key to exist (the caller ensures it before this on non-`none` strategies).
 */
export async function startSshGateway(
  container: ServerContainer,
): Promise<InServerSshGateway | null> {
  if (config.domain.ssh.gateway !== "in-server") return null;

  // The pod trusts the shared key's public half; the proxy dials the pod with
  // its private half. Ensure it exists, then read its OpenSSH material.
  await ensureSharedSshPipeKey();
  const upstreamPrivateKey = await getSharedSshPipeKeyOpenSSH();
  const hostKey = await ensureInServerHostKey(container.control.secretService);

  const namespace = config.kubernetes.namespace;
  const resolveUpstream = (sandboxId: string): UpstreamTarget | null => {
    // Dial the sandbox's Service DNS on port 22 — the same target the sshpiper
    // `Pipe` used (stable across pod restarts, no pod-IP race).
    if (!/^[a-z0-9-]+$/i.test(sandboxId)) return null;
    return { host: `sandbox-${sandboxId}.${namespace}.svc`, port: 22 };
  };

  const gateway = await startInServerSshGateway({
    listenPort: config.domain.ssh.listenPort,
    hostKey,
    upstreamUser: config.domain.ssh.upstreamUser,
    upstreamPrivateKey,
    authorizedKeys: () => container.control.sshKeyService.getValidPublicKeys(),
    resolveUpstream,
  });
  log.info(
    { port: gateway.port, listenPort: config.domain.ssh.listenPort },
    "in-server ssh gateway started",
  );
  return gateway;
}
