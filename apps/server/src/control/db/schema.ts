/**
 * Control's tables. Per atelier-v2 §3.1: "everything identity-shaped lives
 * here and ONLY here". No FK to runtime's `sandboxes`/`snapshots` tables —
 * control treats the runtime as an authenticated principal talks to, not a
 * database it joins against.
 *
 * `Workspace` dies as a concept, survives as data: `savedSpecs` is
 * `{name, orgId, spec, policyRefs}` — a named, shared, spawnable spec
 * template (proposal §3.1 table).
 */

import type { SandboxSpec } from "@atelier/spec";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  avatarUrl: text("avatar_url"),
  personal: text("personal").notNull().default("false"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email").notNull(),
  avatarUrl: text("avatar_url"),
  githubAccessToken: text("github_access_token"),
  personalOrgId: text("personal_org_id"),
  createdAt: text("created_at").notNull(),
  lastLoginAt: text("last_login_at").notNull(),
});

const orgMemberRoleValues = ["owner", "admin", "member", "viewer"] as const;
export type OrgMemberRole = (typeof orgMemberRoleValues)[number];

export const orgMembers = sqliteTable(
  "org_members",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: orgMemberRoleValues }).notNull(),
    joinedAt: text("joined_at").notNull(),
  },
  (t) => [
    index("idx_org_members_org_id").on(t.orgId),
    index("idx_org_members_user_id").on(t.userId),
    uniqueIndex("idx_org_members_org_user").on(t.orgId, t.userId),
  ],
);

/**
 * The workspace replacement: a named, shared, spawnable `SandboxSpec`
 * template. "Workspace definition" = editing a saved spec (§3.1 table).
 * `spec` may still contain `{"$secret": name}` references — those resolve at
 * the seam, not at rest here.
 */
export const savedSpecs = sqliteTable(
  "saved_specs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id"),
    name: text("name").notNull(),
    spec: text("spec", { mode: "json" }).notNull().$type<SandboxSpec>(),
    /** ids of org policy specs applied at enrichment, for audit/display. */
    policyRefs: text("policy_refs", { mode: "json" })
      .notNull()
      .$type<string[]>()
      .default([]),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_saved_specs_org_id").on(t.orgId)],
);

/**
 * Operator-mandated spec fragment appended at every seam crossing for an org
 * (an audit process, a compliance file — §3.2 "org-policy injection"). A
 * dev hand-crafting a spec against the raw API still gets these, because
 * enrichment happens server-side on every crossing.
 */
export const orgPolicySpecs = sqliteTable("org_policy_specs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().unique(),
  /** A `Partial<SandboxSpec>` fragment, merged via @atelier/compose rules. */
  fragment: text("fragment", { mode: "json" })
    .notNull()
    .$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * The control secrets store. Values, not references — specs at rest hold
 * `{"$secret": name}` only. Resolution happens at the seam; values exist only
 * in the ConfigMap/env of a booted sandbox (proposal §7 non-goals).
 */
export const secrets = sqliteTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id"),
    name: text("name").notNull(),
    /** `enc:` + base64(iv + AES-256-GCM ciphertext). */
    encryptedValue: text("encrypted_value").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_secrets_org_id").on(t.orgId),
    uniqueIndex("idx_secrets_org_name").on(t.orgId, t.name),
  ],
);

const sshKeyTypeValues = ["generated", "uploaded"] as const;
export type SshKeyType = (typeof sshKeyTypeValues)[number];

export const sshKeys = sqliteTable(
  "ssh_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    username: text("username").notNull(),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: sshKeyTypeValues }).notNull(),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_ssh_keys_user_id").on(t.userId)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
  },
  (t) => [
    index("idx_api_keys_user_id").on(t.userId),
    uniqueIndex("idx_api_keys_key_hash").on(t.keyHash),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});
