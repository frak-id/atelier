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
  buildKnownHostsData,
  buildSshPipe,
  ensureSharedSshPipeKey,
  type KubeResource,
  kubeClient,
} from "./kube/index.ts";

export interface SshGatewayBoot {
  /** Secret to mount at `/etc/sandbox/ssh` as the pod's `authorized_keys`
   * source, or undefined when the sandbox exposes no SSH. */
  podAuthKeysSecret?: string;
  /** Extra resources to create in the boot batch (a `Pipe`, or the per-sandbox
   * authorized-keys Secret for `none`). */
  resources: KubeResource[];
  /**
   * Pin the sandbox's real sshd host key(s) onto the Pipe this boot created,
   * once the agent reports them (`GET /ssh/host-keys` — the Pipe is created
   * up front on the unpinned fallback so boot never blocks on the agent for
   * SSH to work). A no-op for `none`/`in-server` (no Pipe to patch — the
   * in-server proxy pins from `SandboxRecord.generated.sshHostKeys` instead,
   * see runtime.service.ts + ssh/proxy.ts). Called fresh on every boot AND
   * resume: host keys regenerate every boot (sandbox-boot.sh), so a stale
   * pin from a prior boot must be overwritten, not just set once.
   */
  pinHostKey: (hostKeys: string[]) => Promise<void>;
}

const noopPin: SshGatewayBoot["pinHostKey"] = async () => {};

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
    if (!authorizedKeysData) return { resources: [], pinHostKey: noopPin };
    const secretName = sshAuthKeysSecretName(sandboxId);
    return {
      podAuthKeysSecret: secretName,
      resources: [
        buildAuthKeysSecret(sandboxId, secretName, authorizedKeysData),
      ],
      pinHostKey: noopPin,
    };
  }

  // `sshpiper` and `in-server` both keep the pod trusting the shared key (the
  // proxy does the hop); `sshpiper` additionally emits the routing Pipe.
  const sharedKey = await ensureSharedSshPipeKey();
  const resources: KubeResource[] = [];
  let pinHostKey = noopPin;
  if (strategy === "sshpiper") {
    const targetHost = `sandbox-${sandboxId}.${config.kubernetes.namespace}.svc`;
    resources.push(
      buildSshPipe({
        sandboxId,
        targetHost,
        authorizedKeysData,
        privateKeySecretName: sharedKey.secretName,
      }),
    );
    pinHostKey = (hostKeys) =>
      pinSshPipeHostKey(sandboxId, targetHost, hostKeys);
  }
  return { podAuthKeysSecret: sharedKey.secretName, resources, pinHostKey };
}

/**
 * PATCH the Pipe's `to` with the sandbox's real sshd host key(s) — pinning
 * verification (`known_hosts_data` set, `ignore_hostkey: false`). A JSON
 * merge-patch scoped to `spec.to` so `spec.from` (the dev's authorized_keys)
 * is left untouched. `known_hosts_data` from an empty `hostKeys` is
 * impossible here (the caller only invokes `pinHostKey` with a non-empty
 * list — see boot.ts), but `buildKnownHostsData` returning `undefined` is
 * still handled defensively by skipping the patch rather than pinning an
 * empty/broken value.
 */
async function pinSshPipeHostKey(
  sandboxId: string,
  targetHost: string,
  hostKeys: string[],
): Promise<void> {
  const knownHostsData = buildKnownHostsData(targetHost, 22, hostKeys);
  if (!knownHostsData) return;
  // `Pipe` is a CRD: strategic-merge is rejected (415), so JSON merge-patch.
  // `known_hosts_data` must also be declared in the chart's Pipe CRD schema,
  // or the API server prunes it on write (charts/.../sshpiper-crd.yaml).
  await kubeClient.patchResource(
    "Pipe",
    `ssh-${sandboxId}`,
    {
      spec: {
        to: { known_hosts_data: knownHostsData, ignore_hostkey: false },
      },
    },
    undefined,
    "merge",
  );
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
