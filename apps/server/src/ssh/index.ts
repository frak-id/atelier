/**
 * The in-server SSH gateway module. Composition-root concern: it wires the
 * ssh2 proxy (runtime-neutral networking) to the control SSH keys + host-key
 * store and the runtime's upstream-key + endpoint resolution. Lives OUTSIDE
 * `runtime/` because it needs `control/` (host key, dev keys) — the boundary
 * check forbids that inside `runtime/`.
 */
import type { ServerContainer } from "../api/container.ts";
import { ensureResuming, isResuming, waitForRunning } from "../api/wake.ts";
import {
  ensureSharedSshPipeKey,
  getSharedSshPipeKeyOpenSSH,
  resourceName,
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

const log = createChildLogger("ssh-gateway");

/** How long an SSH connection to a paused sandbox waits for its resume. */
const WAKE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Boot the in-server ssh2 gateway from the composition root (production mode
 * only; local mode has no SSH gateway).
 */
export async function startSshGateway(
  container: ServerContainer,
): Promise<InServerSshGateway> {
  // The pod trusts the shared key's public half; the proxy dials the pod with
  // its private half. Ensure it exists, then read its OpenSSH material.
  await ensureSharedSshPipeKey();
  const upstreamPrivateKey = await getSharedSshPipeKeyOpenSSH();
  const hostKey = await ensureInServerHostKey(container.control.secretService);

  const namespace = config.kubernetes.namespace;
  const resolveUpstream = async (
    sandboxId: string,
  ): Promise<UpstreamTarget | null> => {
    // Dial the sandbox's Service DNS on port 22 (stable across pod restarts,
    // no pod-IP race).
    if (!/^[a-z0-9-]+$/i.test(sandboxId)) return null;
    // A paused sandbox is resumed on connect, and the connection waits for
    // it (bounded; past that the connection is closed).
    if (container.runtime.getStatus(sandboxId) === "paused") {
      log.info({ sandboxId }, "ssh to a paused sandbox; resuming it");
      ensureResuming(container, sandboxId);
      const running = await waitForRunning(
        () => container.runtime.getStatus(sandboxId),
        {
          waking: () => isResuming(container, sandboxId),
          timeoutMs: WAKE_TIMEOUT_MS,
        },
      );
      if (!running) return null;
    }
    return {
      host: `${resourceName(sandboxId)}.${namespace}.svc`,
      port: 22,
      // Pin against the sshd host key the agent reported at this sandbox's
      // last boot/resume, when known (a cheap in-memory store read, see
      // RuntimeService.getSshHostKeys). Unknown keys make the proxy refuse
      // the upstream (see buildHostVerifier).
      hostKeys: container.runtime.getSshHostKeys(sandboxId),
    };
  };

  const gateway = await startInServerSshGateway({
    listenPort: config.domain.ssh.listenPort,
    hostKey,
    upstreamUser: config.domain.ssh.upstreamUser,
    upstreamPrivateKey,
    // Only keys whose owner may access the sandbox (its creator or a member
    // of its org); an unknown sandbox admits no key.
    authorizedKeys: (sandboxId) => {
      const labels = container.runtime.getLabels(sandboxId);
      return labels ? container.control.sandboxSshKeys(labels) : [];
    },
    resolveUpstream,
    onActivity: (sandboxId) => container.runtime.touch(sandboxId, "ssh"),
  });
  log.info(
    { port: gateway.port, listenPort: config.domain.ssh.listenPort },
    "in-server ssh gateway started",
  );
  return gateway;
}
