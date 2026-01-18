import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("secrets");

const ENCRYPTION_PREFIX = "enc:";

export const SecretsService = {
  async encryptSecrets(
    secrets: Record<string, string>,
  ): Promise<Record<string, string>> {
    const encrypted: Record<string, string> = {};

    for (const [key, value] of Object.entries(secrets)) {
      encrypted[key] = await this.encrypt(value);
    }

    return encrypted;
  },

  async decryptSecrets(
    encrypted: Record<string, string>,
  ): Promise<Record<string, string>> {
    const decrypted: Record<string, string> = {};

    for (const [key, value] of Object.entries(encrypted)) {
      decrypted[key] = await this.decrypt(value);
    }

    return decrypted;
  },

  async encrypt(value: string): Promise<string> {
    if (config.isMock()) {
      return `${ENCRYPTION_PREFIX}${Buffer.from(value).toString("base64")}`;
    }

    const key = await this.getEncryptionKey();
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
  },

  async decrypt(encrypted: string): Promise<string> {
    if (!encrypted.startsWith(ENCRYPTION_PREFIX)) {
      log.warn("Attempted to decrypt non-encrypted value");
      return encrypted;
    }

    const data = encrypted.slice(ENCRYPTION_PREFIX.length);

    if (config.isMock()) {
      return Buffer.from(data, "base64").toString("utf-8");
    }

    const key = await this.getEncryptionKey();
    const combined = Buffer.from(data, "base64");

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );

    return new TextDecoder().decode(decrypted);
  },

  async getEncryptionKey(): Promise<CryptoKey> {
    const keyMaterial = await this.getKeyMaterial();

    return crypto.subtle.importKey(
      "raw",
      keyMaterial,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  },

  async getKeyMaterial(): Promise<ArrayBuffer> {
    const secretKey =
      process.env.SANDBOX_SECRETS_KEY || "default-dev-key-change-in-production";

    if (
      secretKey === "default-dev-key-change-in-production" &&
      !config.isMock()
    ) {
      log.warn(
        "Using default secrets key - set SANDBOX_SECRETS_KEY in production!",
      );
    }

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secretKey);

    const hash = await crypto.subtle.digest("SHA-256", keyData);
    return hash;
  },

  generateEnvFile(secrets: Record<string, string>): string {
    const lines: string[] = [];

    for (const [key, value] of Object.entries(secrets)) {
      const escapedValue = value.replace(/"/g, '\\"');
      lines.push(`export ${key}="${escapedValue}"`);
    }

    return lines.join("\n");
  },
};
