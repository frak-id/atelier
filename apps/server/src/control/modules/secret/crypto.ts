/**
 * AES-256-GCM secret-value encryption. Free-floating crypto util — called
 * by `secret.service.ts` (encrypts a write-only value at rest).
 */
import { isProduction } from "../../../shared/lib/config.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";

const log = createChildLogger("secret-crypto");
const ENCRYPTION_PREFIX = "enc:";
/** Local-mode fallback only: production refuses to start without a key
 * (`assertSecretsKeyConfigured`), so this public value never encrypts a
 * production secret. */
const DEV_SECRETS_KEY = "default-dev-key-change-in-production";

/**
 * Fail fast at server startup when production has no `SANDBOX_SECRETS_KEY`:
 * every stored secret would otherwise be encrypted with a key published in
 * this repository. Local mode keeps the dev default (with a warning).
 */
export function assertSecretsKeyConfigured(): void {
  if (process.env.SANDBOX_SECRETS_KEY) return;
  if (isProduction()) {
    throw new Error(
      "SANDBOX_SECRETS_KEY is required in production mode (it encrypts " +
        "stored secrets at rest)",
    );
  }
  log.warn("SANDBOX_SECRETS_KEY is unset; using the public dev key");
}

async function getEncryptionKey(): Promise<CryptoKey> {
  const secretKey = process.env.SANDBOX_SECRETS_KEY || DEV_SECRETS_KEY;
  const keyData = new TextEncoder().encode(secretKey);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecretValue(value: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return `${ENCRYPTION_PREFIX}${Buffer.from(combined).toString("base64")}`;
}

export async function decryptSecretValue(encrypted: string): Promise<string> {
  if (!encrypted.startsWith(ENCRYPTION_PREFIX)) {
    log.warn("Attempted to decrypt non-encrypted value");
    return encrypted;
  }
  const data = encrypted.slice(ENCRYPTION_PREFIX.length);
  const key = await getEncryptionKey();
  const combined = Buffer.from(data, "base64");
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(decrypted);
}
