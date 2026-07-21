/**
 * Control's domain types. Plain TypeScript — control has no HTTP-framework
 * dependency; `api/` defines its own validation schemas that mirror these.
 */

export interface User {
  id: string;
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

export type OrgMemberRole = "owner" | "admin" | "member" | "viewer";

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

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
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

export interface Secret {
  id: string;
  orgId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
