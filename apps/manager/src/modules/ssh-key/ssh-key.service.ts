import { createHash } from "node:crypto";
import type { SshKey, SshKeyType } from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import type { SshKeyRepository } from "./ssh-key.repository.ts";

interface CreateOptions {
  userId: string;
  username: string;
  publicKey: string;
  name: string;
  type: SshKeyType;
  expiresAt?: string;
}

export class SshKeyService {
  constructor(private readonly sshKeyRepository: SshKeyRepository) {}

  listByUserId(userId: string): SshKey[] {
    return this.sshKeyRepository.listByUserId(userId);
  }

  getAllValidKeys(): SshKey[] {
    const now = new Date().toISOString();
    return this.sshKeyRepository
      .listAll()
      .filter((key) => !key.expiresAt || key.expiresAt > now);
  }

  getById(id: string): SshKey | undefined {
    return this.sshKeyRepository.getById(id);
  }

  create(options: CreateOptions): SshKey {
    if (!this.isValidPublicKey(options.publicKey)) {
      throw new Error("Invalid SSH public key format");
    }

    const fingerprint = this.computeFingerprint(options.publicKey);

    return this.sshKeyRepository.create({
      ...options,
      fingerprint,
    });
  }

  delete(id: string, userId: string): void {
    const existing = this.sshKeyRepository.getById(id);
    if (!existing) {
      throw new NotFoundError("SshKey", id);
    }
    if (existing.userId !== userId) {
      throw new Error("Cannot delete another user's SSH key");
    }
    this.sshKeyRepository.delete(id);
  }

  cleanupExpired(): number {
    return this.sshKeyRepository.deleteExpired();
  }

  hasKeysForUser(userId: string): boolean {
    return this.sshKeyRepository.listByUserId(userId).length > 0;
  }

  private isValidPublicKey(key: string): boolean {
    const trimmed = key.trim();
    return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+|ssh-dss)\s+\S+/.test(trimmed);
  }

  private computeFingerprint(publicKey: string): string {
    const parts = publicKey.trim().split(/\s+/);
    const keyDataBase64 = parts[1];
    if (!keyDataBase64) {
      throw new Error("Invalid public key format");
    }
    const keyData = Buffer.from(keyDataBase64, "base64");
    const hash = createHash("sha256").update(keyData).digest("base64");
    return `SHA256:${hash.replace(/=+$/, "")}`;
  }
}
