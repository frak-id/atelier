/**
 * The in-server ssh2 proxy's persistent host key. Generated once (lazily, on
 * first gateway start) and kept in the control DB secrets store — NOT a k8s
 * Secret (absent on Docker/local) and NOT a disk file (ephemeral without a
 * mounted volume). The DB is backend-agnostic and multi-replica safe: every
 * replica reads the same row → the same host key → no client MITM warnings
 * behind a load balancer (docs/proposals/portable-runtime-backends.md §5).
 *
 * The value is stored AES-256-GCM at rest by `SecretService` (keyed by
 * `SANDBOX_SECRETS_KEY`); rotating that key regenerates the host key, a
 * one-time client warning.
 */
import type { SecretService } from "../control/index.ts";
import { generateOpenSSHEd25519 } from "../shared/lib/ssh-key-openssh.ts";

/** Global (org-less) secret name for the proxy host key. */
export const SSH_HOST_KEY_SECRET = "atelier.ssh.hostkey.openssh";

/**
 * Return the proxy's OpenSSH-format host key, generating + persisting it on
 * first call. Concurrent first-starts are tolerated: a racing writer's value
 * simply wins (both are valid keys; the winner is stable thereafter).
 */
export async function ensureInServerHostKey(
  secrets: SecretService,
): Promise<string> {
  try {
    return await secrets.resolve(undefined, SSH_HOST_KEY_SECRET);
  } catch {
    // Not set yet — generate and persist.
  }
  const { privateKeyOpenSSH } = generateOpenSSHEd25519("atelier-ssh-gateway");
  await secrets.set(undefined, SSH_HOST_KEY_SECRET, privateKeyOpenSSH);
  // Re-resolve so a concurrent writer's row (if it won the upsert) is honored.
  return secrets.resolve(undefined, SSH_HOST_KEY_SECRET);
}
