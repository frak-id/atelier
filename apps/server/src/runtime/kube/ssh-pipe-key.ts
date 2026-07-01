import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { kubeClient } from "./index.ts";
import { KubeApiError } from "./kube.client.ts";

const log = createChildLogger("ssh-pipe-key");

const SECRET_NAME = "atelier-ssh-pipe-key";

type SharedSshPipeKey = {
  secretName: string;
  publicKeyOpenSSH: string;
};

let cached: SharedSshPipeKey | null = null;

function generateEd25519KeyPair(): {
  privateKeyPem: string;
  publicKeyOpenSSH: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;

  const publicKeyDer = publicKey.export({
    type: "spki",
    format: "der",
  }) as Buffer;
  const rawPubKey = publicKeyDer.subarray(publicKeyDer.length - 32);

  const keyType = "ssh-ed25519";
  const keyTypeBytes = Buffer.from(keyType);
  const blob = Buffer.alloc(4 + keyTypeBytes.length + 4 + rawPubKey.length);
  blob.writeUInt32BE(keyTypeBytes.length, 0);
  keyTypeBytes.copy(blob, 4);
  blob.writeUInt32BE(rawPubKey.length, 4 + keyTypeBytes.length);
  rawPubKey.copy(blob, 4 + keyTypeBytes.length + 4);

  const publicKeyOpenSSH = `ssh-ed25519 ${blob.toString("base64")} atelier-sshpiper`;
  return { privateKeyPem, publicKeyOpenSSH };
}

export async function ensureSharedSshPipeKey(): Promise<SharedSshPipeKey> {
  if (cached) return cached;

  const namespace = config.kubernetes.namespace;
  const path = `/api/v1/namespaces/${namespace}/secrets/${SECRET_NAME}`;

  try {
    const existing = await kubeClient.get<{
      data?: Record<string, string>;
    }>(path);

    const pubKeyB64 = existing.data?.["ssh-publickey"];
    if (pubKeyB64) {
      cached = {
        secretName: SECRET_NAME,
        publicKeyOpenSSH: Buffer.from(pubKeyB64, "base64").toString("utf-8"),
      };
      log.info("Loaded existing shared SSH pipe key");
      return cached;
    }
  } catch {}

  log.info("Generating new shared SSH pipe key");
  const { privateKeyPem, publicKeyOpenSSH } = generateEd25519KeyPair();

  try {
    await kubeClient.createResource({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: SECRET_NAME,
        namespace,
        labels: {
          "atelier.dev/component": "ssh-pipe-key-shared",
        },
      },
      type: "Opaque",
      data: {
        "ssh-privatekey": Buffer.from(privateKeyPem).toString("base64"),
        "ssh-publickey": Buffer.from(publicKeyOpenSSH).toString("base64"),
      },
    });
  } catch (err) {
    if (err instanceof KubeApiError && err.status === 409) {
      log.info("Shared SSH pipe key created by concurrent request, loading");
      const existing = await kubeClient.get<{
        data?: Record<string, string>;
      }>(path);
      const pubKeyB64 = existing.data?.["ssh-publickey"];
      if (pubKeyB64) {
        cached = {
          secretName: SECRET_NAME,
          publicKeyOpenSSH: Buffer.from(pubKeyB64, "base64").toString("utf-8"),
        };
        return cached;
      }
    }
    throw err;
  }

  cached = { secretName: SECRET_NAME, publicKeyOpenSSH };
  return cached;
}
