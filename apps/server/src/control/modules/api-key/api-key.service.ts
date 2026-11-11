import { NotFoundError, ValidationError } from "../../../shared/errors.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { ApiKey, ApiKeyScope } from "../../types.ts";
import type { ApiKeyRepository } from "./api-key.repository.ts";

const log = createChildLogger("api-key-service");

const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

function hashKey(rawKey: string): string {
  return new Bun.CryptoHasher("sha256").update(rawKey).digest("hex");
}

/** The stored form of a raw key (also what a config-declared key is matched
 * by): its sha256, never the key. */
export function hashApiKey(rawKey: string): string {
  return hashKey(rawKey);
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
    scope: ApiKeyScope = "full",
  ): { apiKey: ApiKey; rawKey: string } {
    // Validation compares the stored string with an ISO date: normalize.
    const at = expiresAt === undefined ? undefined : Date.parse(expiresAt);
    if (at !== undefined && Number.isNaN(at)) {
      throw new ValidationError("expiresAt must be a valid date");
    }
    const rawKey = `atl_${safeNanoid(40)}`;
    const keyHash = hashKey(rawKey);
    const apiKey = this.apiKeyRepository.create({
      id: safeNanoid(),
      userId,
      name,
      keyPrefix: rawKey.slice(0, 8),
      keyHash,
      scope,
      managedBy: "console",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      expiresAt: at === undefined ? null : new Date(at).toISOString(),
    });
    log.info({ userId, name }, "API key created");
    return { apiKey, rawKey };
  }

  /**
   * Register a key whose raw value comes from outside (a config-declared
   * service-account key): only its hash is stored. `managedBy: "config"` keys
   * are the reconcile's, the API refuses to revoke them.
   */
  createFromRawKey(
    userId: string,
    name: string,
    rawKey: string,
    scope: ApiKeyScope,
  ): ApiKey {
    const apiKey = this.apiKeyRepository.create({
      id: safeNanoid(),
      userId,
      name,
      keyPrefix: rawKey.slice(0, 8),
      keyHash: hashKey(rawKey),
      scope,
      managedBy: "config",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      expiresAt: null,
    });
    log.info({ userId, name }, "Config-managed API key registered");
    return apiKey;
  }

  /** The stored key with this raw value, if any (no expiry check). */
  findByRawKey(rawKey: string): ApiKey | undefined {
    return this.apiKeyRepository.getByKeyHash(hashKey(rawKey));
  }

  delete(id: string, userId: string): void {
    const deleted = this.apiKeyRepository.delete(id, userId);
    if (!deleted) throw new NotFoundError("ApiKey", id);
  }

  validateKey(
    rawKey: string,
  ): { userId: string; apiKeyId: string; scope: ApiKeyScope } | null {
    const apiKey = this.apiKeyRepository.getByKeyHash(hashKey(rawKey));
    if (!apiKey) return null;
    if (apiKey.expiresAt && apiKey.expiresAt < new Date().toISOString()) {
      return null;
    }
    const shouldTouch =
      !apiKey.lastUsedAt ||
      Date.now() - new Date(apiKey.lastUsedAt).getTime() > TOUCH_THROTTLE_MS;
    if (shouldTouch) this.apiKeyRepository.touchLastUsed(apiKey.id);
    return {
      userId: apiKey.userId,
      apiKeyId: apiKey.id,
      scope: apiKey.scope,
    };
  }
}
