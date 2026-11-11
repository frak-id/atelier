import { asc, eq } from "drizzle-orm";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import { getDatabase } from "../../db/client.ts";
import {
  apiKeys,
  orgMembers,
  serviceAccounts,
  users,
} from "../../db/schema.ts";
import type {
  ManagedBy,
  ServiceAccount,
  ServiceAccountGitHub,
  ServiceAccountGitHubSummary,
} from "../../types.ts";
import {
  decryptSecretValueSync,
  encryptSecretValueSync,
} from "../secret/crypto.ts";

const log = createChildLogger("service-account-repository");

type Tx = Parameters<
  Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]
>[0];

type Row = typeof serviceAccounts.$inferSelect;

/** The git name/email of a static token, the ids of an App: never a secret. */
function summaryOf(row: Row): ServiceAccountGitHubSummary {
  const c = row.githubConfig ?? {};
  if (row.githubKind === "app") {
    return {
      kind: "app",
      appId: String(c.appId ?? ""),
      installationId: String(c.installationId ?? ""),
      ...(Array.isArray(c.repositories)
        ? { repositories: c.repositories as string[] }
        : {}),
      ...(c.permissions && typeof c.permissions === "object"
        ? {
            permissions: c.permissions as Record<string, "read" | "write">,
          }
        : {}),
    };
  }
  if (row.githubKind === "token") {
    return {
      kind: "token",
      gitName: String(c.gitName ?? ""),
      gitEmail: String(c.gitEmail ?? ""),
    };
  }
  return { kind: "none" };
}

function rowToServiceAccount(
  row: Row,
  username: string | undefined,
): ServiceAccount {
  return {
    id: row.userId,
    name: row.name,
    username: username ?? `${row.name}[bot]`,
    description: row.description,
    orgId: row.orgId,
    github: summaryOf(row),
    managedBy: row.managedBy,
    ...(row.createdBy ? { createdBy: row.createdBy } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The non-secret half of a credential, as `github_config` stores it. */
function configOf(github: ServiceAccountGitHub): Record<string, unknown> {
  if (github.kind === "app") {
    return {
      appId: github.appId,
      installationId: github.installationId,
      ...(github.repositories ? { repositories: github.repositories } : {}),
      ...(github.permissions ? { permissions: github.permissions } : {}),
    };
  }
  return { gitName: github.gitName, gitEmail: github.gitEmail };
}

function secretOf(github: ServiceAccountGitHub): string {
  return github.kind === "app" ? github.privateKey : github.token;
}

/** What `getGitHub` returns: a credential, or `unreadable` when a secret is
 * stored but can't be decrypted (not the same as none). */
export type StoredGitHub = ServiceAccountGitHub | { kind: "unreadable" };

export interface NewServiceAccount {
  id: string;
  name: string;
  username: string;
  email: string;
  description: string;
  orgId: string;
  managedBy: ManagedBy;
  createdBy?: string;
  github?: ServiceAccountGitHub;
}

/**
 * Service accounts: a `users` row of kind `service` plus its
 * `service_accounts` row, always written together. The GitHub secret (an
 * App private key or a static token) is stored encrypted and only
 * `getGitHub` ever returns it.
 */
export class ServiceAccountRepository {
  private outer?: Tx;

  /** Run `fn` in one SQLite transaction. Every statement on the shared
   * connection (other repositories' included) joins it, and the writes
   * below nest as savepoints. Synchronous only. */
  transaction<T>(fn: () => T): T {
    return getDatabase().transaction((tx) => {
      this.outer = tx;
      try {
        return fn();
      } finally {
        this.outer = undefined;
      }
    });
  }

  private atomic<T>(fn: (tx: Tx) => T): T {
    return this.outer
      ? this.outer.transaction(fn)
      : getDatabase().transaction(fn);
  }

  list(): ServiceAccount[] {
    return getDatabase()
      .select({ sa: serviceAccounts, username: users.username })
      .from(serviceAccounts)
      .leftJoin(users, eq(users.id, serviceAccounts.userId))
      .orderBy(asc(serviceAccounts.createdAt))
      .all()
      .map((r) => rowToServiceAccount(r.sa, r.username ?? undefined));
  }

  getById(id: string): ServiceAccount | undefined {
    const r = getDatabase()
      .select({ sa: serviceAccounts, username: users.username })
      .from(serviceAccounts)
      .leftJoin(users, eq(users.id, serviceAccounts.userId))
      .where(eq(serviceAccounts.userId, id))
      .get();
    return r ? rowToServiceAccount(r.sa, r.username ?? undefined) : undefined;
  }

  getByName(name: string): ServiceAccount | undefined {
    const r = getDatabase()
      .select({ sa: serviceAccounts, username: users.username })
      .from(serviceAccounts)
      .leftJoin(users, eq(users.id, serviceAccounts.userId))
      .where(eq(serviceAccounts.name, name))
      .get();
    return r ? rowToServiceAccount(r.sa, r.username ?? undefined) : undefined;
  }

  /**
   * The decrypted GitHub credential, `undefined` when none is configured, or
   * `{ kind: "unreadable" }` when the secret can't be decrypted (a wrong
   * `SANDBOX_SECRETS_KEY`: logged; callers must not read it as "none").
   */
  getGitHub(id: string): StoredGitHub | undefined {
    const row = getDatabase()
      .select()
      .from(serviceAccounts)
      .where(eq(serviceAccounts.userId, id))
      .get();
    if (!row || row.githubKind === "none" || !row.githubSecret) {
      return undefined;
    }
    let secret: string;
    try {
      secret = decryptSecretValueSync(row.githubSecret);
    } catch (err) {
      log.warn(
        { err, serviceAccountId: id },
        "stored service-account GitHub secret can't be decrypted",
      );
      return { kind: "unreadable" };
    }
    const summary = summaryOf(row);
    if (summary.kind === "app") return { ...summary, privateKey: secret };
    if (summary.kind === "token") return { ...summary, token: secret };
    return undefined;
  }

  /** Insert the `users` row and the `service_accounts` row atomically. */
  create(sa: NewServiceAccount): ServiceAccount {
    const now = new Date().toISOString();
    this.atomic((tx) => {
      tx.insert(users)
        .values({
          id: sa.id,
          kind: "service",
          username: sa.username,
          email: sa.email,
          createdAt: now,
          lastLoginAt: now,
        })
        .run();
      tx.insert(serviceAccounts)
        .values({
          userId: sa.id,
          name: sa.name,
          description: sa.description,
          orgId: sa.orgId,
          githubKind: sa.github?.kind ?? "none",
          githubConfig: sa.github ? configOf(sa.github) : null,
          githubSecret: sa.github
            ? encryptSecretValueSync(secretOf(sa.github))
            : null,
          managedBy: sa.managedBy,
          createdBy: sa.createdBy ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
    const created = this.getById(sa.id);
    if (!created) throw new Error("Failed to create service account");
    return created;
  }

  update(
    id: string,
    patch: {
      description?: string;
      orgId?: string;
      managedBy?: ManagedBy;
      email?: string;
    },
  ): void {
    const now = new Date().toISOString();
    const { email, ...rest } = patch;
    this.atomic((tx) => {
      tx.update(serviceAccounts)
        .set({ ...rest, updatedAt: now })
        .where(eq(serviceAccounts.userId, id))
        .run();
      if (email !== undefined) {
        tx.update(users).set({ email }).where(eq(users.id, id)).run();
      }
    });
  }

  /** Replace the GitHub credential (`null` removes it). */
  setGitHub(id: string, github: ServiceAccountGitHub | null): void {
    getDatabase()
      .update(serviceAccounts)
      .set({
        githubKind: github?.kind ?? "none",
        githubConfig: github ? configOf(github) : null,
        githubSecret: github ? encryptSecretValueSync(secretOf(github)) : null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(serviceAccounts.userId, id))
      .run();
  }

  /** Delete the account with its API keys and memberships, atomically. */
  delete(id: string): void {
    this.atomic((tx) => {
      tx.delete(apiKeys).where(eq(apiKeys.userId, id)).run();
      tx.delete(orgMembers).where(eq(orgMembers.userId, id)).run();
      tx.delete(serviceAccounts).where(eq(serviceAccounts.userId, id)).run();
      tx.delete(users).where(eq(users.id, id)).run();
    });
  }
}
