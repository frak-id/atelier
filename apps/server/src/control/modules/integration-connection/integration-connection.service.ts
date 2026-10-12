/**
 * A person's connections to the compiled-in integrations. The credential is
 * the person's key at the integration's service: encrypted at rest, and the
 * only place it leaves is `connectionsOf` (for the permission hub).
 */
import type {
  PermissionConnection,
  PermissionRisk,
} from "@frak/atelier-shared";
import { SandboxError } from "../../../shared/errors.ts";
import { isProduction } from "../../../shared/lib/config.ts";
import { safeNanoid } from "../../../shared/lib/id.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import { decryptSecretValue, encryptSecretValue } from "../secret/crypto.ts";
import type { IntegrationConnectionRepository } from "./integration-connection.repository.ts";

const log = createChildLogger("integration-connection");

/** A connection without its credential. */
interface Connection {
  id: string;
  userId: string;
  integrationId: string;
  hasCredential: boolean;
  enabled: boolean;
  minRisk: PermissionRisk;
  delaySeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionChange {
  /** A new credential; `null` clears it; `undefined` keeps it. */
  credential?: string | null;
  enabled?: boolean;
  minRisk?: PermissionRisk;
  delaySeconds?: number;
}

export class IntegrationConnectionService {
  constructor(
    private readonly repository: IntegrationConnectionRepository,
    private readonly deps = {
      isProduction,
      secretsKey: () => process.env.SANDBOX_SECRETS_KEY,
    },
  ) {}

  get(userId: string, integrationId: string): Connection | undefined {
    const row = this.repository.get(userId, integrationId);
    return row && toConnection(row);
  }

  /** Create the connection or change the given fields of the existing one. */
  async upsert(
    userId: string,
    integrationId: string,
    change: ConnectionChange,
  ): Promise<Connection> {
    // Without SANDBOX_SECRETS_KEY the crypto falls back to a public default
    // key: in production that would store the credential as good as plain.
    if (
      typeof change.credential === "string" &&
      this.deps.isProduction() &&
      !this.deps.secretsKey()
    ) {
      throw new SandboxError(
        "Cannot store an integration credential: the operator must set SANDBOX_SECRETS_KEY",
        "CONFIGURATION_ERROR",
        500,
      );
    }
    const now = new Date().toISOString();
    const existing = this.repository.get(userId, integrationId);
    const credential =
      change.credential === undefined
        ? (existing?.credential ?? null)
        : change.credential === null
          ? null
          : await encryptSecretValue(change.credential);
    const row = {
      id: existing?.id ?? safeNanoid(),
      userId,
      integrationId,
      credential,
      enabled: change.enabled ?? existing?.enabled ?? true,
      minRisk: change.minRisk ?? existing?.minRisk ?? "high",
      delaySeconds: change.delaySeconds ?? existing?.delaySeconds ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.repository.upsert(row);
    return toConnection(row);
  }

  delete(userId: string, integrationId: string): void {
    this.repository.delete(userId, integrationId);
  }

  /** The person's enabled connections, credentials decrypted — for the
   * permission hub only. */
  async connectionsOf(userId: string): Promise<PermissionConnection[]> {
    const rows = this.repository.listByUser(userId).filter((r) => r.enabled);
    const connections = await Promise.all(
      rows.map(async (row) => {
        try {
          return {
            integrationId: row.integrationId,
            credential: row.credential
              ? await decryptSecretValue(row.credential)
              : undefined,
            minRisk: row.minRisk,
            delaySeconds: row.delaySeconds,
          };
        } catch {
          // One unreadable credential (rotated key, corrupt row) must not
          // silence the person's other integrations. Never log the value.
          log.warn(
            { integrationId: row.integrationId },
            "Cannot decrypt the integration credential; skipping the connection",
          );
          return undefined;
        }
      }),
    );
    return connections.filter((c) => c !== undefined);
  }
}

function toConnection(row: {
  id: string;
  userId: string;
  integrationId: string;
  credential: string | null;
  enabled: boolean;
  minRisk: PermissionRisk;
  delaySeconds: number;
  createdAt: string;
  updatedAt: string;
}): Connection {
  const { credential, ...rest } = row;
  return { ...rest, hasCredential: credential !== null };
}
