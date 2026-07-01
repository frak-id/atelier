/**
 * AES-256-GCM secret-value encryption. Ported from v1
 * `infrastructure/secrets/secrets.service.ts`. Free-floating crypto util —
 * only `secret.service.ts` should call this.
 */
import { isMock } from "../../../shared/lib/config.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";

const log = createChildLogger("secret-crypto");
const ENCRYPTION_PREFIX = "enc:";

async function getEncryptionKey(): Promise<CryptoKey> {
  const secretKey =
    process.env.SANDBOX_SECRETS_KEY || "default-dev-key-change-in-production";
  if (secretKey === "default-dev-key-change-in-production" && !isMock()) {
    log.warn(
      "Using default secrets key - set SANDBOX_SECRETS_KEY in production!",
    );
  }
  const keyData = new TextEncoder().encode(secretKey);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecretValue(value: string): Promise<string> {
  if (isMock()) {
    return `${ENCRYPTION_PREFIX}${Buffer.from(value).toString("base64")}`;
  }
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
  if (isMock()) {
    return Buffer.from(data, "base64").toString("utf-8");
  }
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
