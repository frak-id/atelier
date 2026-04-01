import type { ApiKey } from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { safeNanoid } from "../../shared/lib/id.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ApiKeyRepository } from "./api-key.repository.ts";

const log = createChildLogger("api-key-service");

const TOUCH_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

function hashKey(rawKey: string): string {
  return new Bun.CryptoHasher("sha256").update(rawKey).digest("hex");
}

export class ApiKeyService {
  constructor(private readonly apiKeyRepository: ApiKeyRepository) {}

  listByUser(userId: string): ApiKey[] {
    return this.apiKeyRepository.getByUserId(userId);
  }

  create(
    userId: string,
    name: string,
    expiresAt?: string,
  ): { apiKey: ApiKey; rawKey: string } {
    const rawKey = `atl_${safeNanoid(40)}`;
    const keyHash = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 8);
    const now = new Date().toISOString();

    const apiKey = this.apiKeyRepository.create({
      id: safeNanoid(),
      userId,
      name,
      keyPrefix,
      keyHash,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: expiresAt ?? null,
    });

    log.info({ userId, name }, "API key created");
    return { apiKey, rawKey };
  }

  delete(id: string, userId: string): void {
    const deleted = this.apiKeyRepository.delete(id, userId);
    if (!deleted) {
      throw new NotFoundError("ApiKey", id);
    }
  }

  validateKey(rawKey: string): { userId: string; apiKeyId: string } | null {
    const keyHash = hashKey(rawKey);
    const apiKey = this.apiKeyRepository.getByKeyHash(keyHash);

    if (!apiKey) {
      return null;
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date().toISOString()) {
      log.info({ id: apiKey.id }, "API key expired");
      return null;
    }

    // Throttle lastUsedAt writes to reduce SQLite write pressure
    const shouldTouch =
      !apiKey.lastUsedAt ||
      Date.now() - new Date(apiKey.lastUsedAt).getTime() > TOUCH_THROTTLE_MS;
    if (shouldTouch) {
      this.apiKeyRepository.touchLastUsed(apiKey.id);
    }
    return { userId: apiKey.userId, apiKeyId: apiKey.id };
  }
}
