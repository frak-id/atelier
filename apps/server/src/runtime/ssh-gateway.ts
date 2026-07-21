/**
 * SSH gateway strategy for boot — the mechanism that makes sshpiper optional
 * (docs/proposals/portable-runtime-backends.md §5). Given a sandbox's
 * authorized keys, it resolves WHAT SSH resources a boot emits and WHICH secret
 * the pod mounts as its `authorized_keys`, driven by `config.domain.ssh.gateway`:
 *
 *   - `sshpiper` (default): pod trusts the shared key; emit a per-sandbox `Pipe`
 *     CRD carrying the dev's keys — today's behavior, verbatim.
 *   - `none`: no central gateway; the pod trusts the dev's OWN keys (mounted via
 *     a per-sandbox Secret) so an operator can `kubectl port-forward` + SSH
 *     directly. No Pipe, no shared key.
 *   - `in-server`: pod trusts the shared key (the in-server proxy does the hop);
 *     no Pipe. The proxy LISTENER itself is not yet wired (see the step-2
 *     short-circuit in the implementation log) — selecting it prepares the pod
 *     side but SSH is inert until the listener lands.
 *
 * This lives in `runtime/` (boot-side resource emission only). The eventual
 * in-server listener is a composition-root concern (it needs the control DB
 * host key), kept out of here to respect the runtime/→control/ boundary.
 */
import { Buffer } from "node:buffer";
import { config } from "../shared/lib/config.ts";
import {
  buildSshPipe,
  ensureSharedSshPipeKey,
  type KubeResource,
} from "./kube/index.ts";

export interface SshGatewayBoot {
  /** Secret to mount at `/etc/sandbox/ssh` as the pod's `authorized_keys`
   * source, or undefined when the sandbox exposes no SSH. */
  podAuthKeysSecret?: string;
  /** Extra resources to create in the boot batch (a `Pipe`, or the per-sandbox
   * authorized-keys Secret for `none`). */
  resources: KubeResource[];
}

/** Per-sandbox Secret holding the dev's own authorized keys (the `none`
 * strategy). Restartable: recreated on every boot, deleted on pause/rollback. */
export function sshAuthKeysSecretName(sandboxId: string): string {
  return `sandbox-${sandboxId}-ssh-authkeys`;
}

export type SshGatewayStrategy = (typeof config.domain.ssh)["gateway"];

export async function resolveSshGatewayBoot(
  sandboxId: string,
  authorizedKeys: string[] | undefined,
  strategy: SshGatewayStrategy = config.domain.ssh.gateway,
): Promise<SshGatewayBoot> {
  const authorizedKeysData = encodeAuthorizedKeys(authorizedKeys);

  if (strategy === "none") {
    // No proxy holds a shared key, so the pod must trust the dev's own keys for
    // a port-forwarding operator to authenticate. No keys ⇒ SSH simply off.
    if (!authorizedKeysData) return { resources: [] };
    const secretName = sshAuthKeysSecretName(sandboxId);
    return {
      podAuthKeysSecret: secretName,
      resources: [
        buildAuthKeysSecret(sandboxId, secretName, authorizedKeysData),
      ],
    };
  }

  // `sshpiper` and `in-server` both keep the pod trusting the shared key (the
  // proxy does the hop); `sshpiper` additionally emits the routing Pipe.
  const sharedKey = await ensureSharedSshPipeKey();
  const resources: KubeResource[] = [];
  if (strategy === "sshpiper") {
    resources.push(
      buildSshPipe({
        sandboxId,
        targetHost: `sandbox-${sandboxId}.${config.kubernetes.namespace}.svc`,
        authorizedKeysData,
        privateKeySecretName: sharedKey.secretName,
      }),
    );
  }
  return { podAuthKeysSecret: sharedKey.secretName, resources };
}

function encodeAuthorizedKeys(publicKeys?: string[]): string | undefined {
  if (!publicKeys || publicKeys.length === 0) return undefined;
  const authorizedKeys = publicKeys.map((key) => key.trim()).join("\n");
  return Buffer.from(authorizedKeys).toString("base64");
}

/** `data.ssh-publickey` holds base64(authorized_keys); the pod volume maps that
 * item to the file `authorized_keys` (same shape the shared-key Secret uses). */
function buildAuthKeysSecret(
  sandboxId: string,
  name: string,
  authorizedKeysData: string,
): KubeResource {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name,
      namespace: config.kubernetes.namespace,
      labels: {
        "atelier.dev/component": "sandbox",
        "atelier.dev/sandbox": sandboxId,
      },
    },
    type: "Opaque",
    data: { "ssh-publickey": authorizedKeysData },
  };
}
