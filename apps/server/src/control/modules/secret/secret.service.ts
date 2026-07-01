/**
 * The control secrets store (atelier-v2 §3, §7). Values, never at rest in a
 * spec — specs hold `{"$secret": name}` references only. `resolve()` is the
 * only path that returns a plaintext value, and it's called exactly once, at
 * the seam (`enrichment.ts`).
 */
import { NotFoundError } from "../../../shared/errors.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import type { Secret } from "../../types.ts";
import { decryptSecretValue, encryptSecretValue } from "./crypto.ts";
import type { SecretRepository } from "./secret.repository.ts";

export class SecretService {
  constructor(private readonly secretRepository: SecretRepository) {}

  /** Names only — never returns values. */
  list(orgId?: string): Secret[] {
    return this.secretRepository.list(orgId).map((row) => ({
      id: row.id,
      orgId: row.orgId ?? undefined,
      name: row.name,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async set(
    orgId: string | undefined,
    name: string,
    value: string,
  ): Promise<Secret> {
    const now = new Date().toISOString();
    const existing = this.secretRepository.getByName(orgId, name);
    const row = {
      id: existing?.id ?? safeNanoid(),
      orgId: orgId ?? null,
      name,
      encryptedValue: await encryptSecretValue(value),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.secretRepository.upsert(row);
    return {
      id: row.id,
      orgId: orgId,
      name,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Resolve a `{"$secret": name}` reference to its plaintext value. */
  async resolve(orgId: string | undefined, name: string): Promise<string> {
    const row = this.secretRepository.getByName(orgId, name);
    if (!row) throw new NotFoundError("Secret", name);
    return decryptSecretValue(row.encryptedValue);
  }

  delete(id: string): void {
    if (!this.secretRepository.delete(id)) {
      throw new NotFoundError("Secret", id);
    }
  }
}
