/**
 * Control's domain types. Plain TypeScript — control has no HTTP-framework
 * dependency; `api/` defines its own validation schemas that mirror these.
 */

/** `human`: a GitHub login. `service`: a service account (see
 * `ServiceAccount`). */
export type UserKind = "human" | "service";

export interface User {
  id: string;
  kind: UserKind;
  username: string;
  email: string;
  avatarUrl?: string;
  githubAccessToken?: string;
  personalOrgId?: string;
  createdAt: string;
  lastLoginAt: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  avatarUrl?: string;
  personal: boolean;
  createdAt: string;
  updatedAt: string;
}

type OrgMemberRole = "owner" | "member";

export interface OrgMember {
  id: string;
  orgId: string;
  userId: string;
  username: string;
  avatarUrl?: string;
  role: OrgMemberRole;
  joinedAt: string;
}

export interface OrganizationWithRole extends Organization {
  role: OrgMemberRole;
}

/**
 * A user as the directory (`GET /api/users`) exposes them: identity + their
 * memberships, never the stored GitHub token.
 */
export interface DirectoryUser {
  id: string;
  kind: UserKind;
  username: string;
  email: string;
  avatarUrl?: string;
  personalOrgId?: string;
  createdAt: string;
  lastLoginAt: string;
  organizations: {
    id: string;
    name: string;
    slug: string;
    personal: boolean;
    role: OrgMemberRole;
  }[];
}

/** `full`: every authenticated route. `mcp`: the sandbox MCP (`/mcp`)
 * only, never `/mcp/admin` or an HTTP route. */
export type ApiKeyScope = "full" | "mcp";

/** `config`: declared in `serviceAccounts` and reconciled at boot; the API
 * refuses to change or delete it. */
export type ManagedBy = "console" | "config";

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  scope: ApiKeyScope;
  managedBy: ManagedBy;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export type SshKeyType = "generated" | "uploaded";

export interface SshKey {
  id: string;
  userId: string;
  username: string;
  publicKey: string;
  fingerprint: string;
  name: string;
  type: SshKeyType;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A service account's GitHub credential, decrypted (control-internal: never
 * returned by a route).
 *  - `app`: a GitHub App installation. Atelier mints one-hour installation
 *    tokens with the App's private key; commits are authored as the App's
 *    bot user. `repositories` (names in the installation's account) and
 *    `permissions` narrow every minted token.
 *  - `token`: a static token (e.g. a machine account's fine-grained PAT)
 *    with the git identity to commit as.
 */
export type ServiceAccountGitHub =
  | {
      kind: "app";
      appId: string;
      installationId: string;
      privateKey: string;
      repositories?: string[];
      permissions?: Record<string, "read" | "write">;
    }
  | {
      kind: "token";
      token: string;
      gitName: string;
      gitEmail: string;
    };

/** `ServiceAccountGitHub` without its secret, as routes return it. */
export type ServiceAccountGitHubSummary =
  | { kind: "none" }
  | {
      kind: "app";
      appId: string;
      installationId: string;
      repositories?: string[];
      permissions?: Record<string, "read" | "write">;
    }
  | { kind: "token"; gitName: string; gitEmail: string };

/** A service account: a `users` row of kind `service` plus its details. */
export interface ServiceAccount {
  /** The `users.id` (`sa_…`). */
  id: string;
  /** The name it was created with (`coding-agent`). */
  name: string;
  /** `users.username`: `<name>[bot]`, never a valid GitHub login. */
  username: string;
  description: string;
  /** Its one org. Its role there is its `org_members` row. */
  orgId: string;
  github: ServiceAccountGitHubSummary;
  managedBy: ManagedBy;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Secret {
  id: string;
  orgId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
