import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  SandboxRuntime,
  TaskData,
  WorkspaceConfig,
} from "../../schemas/index.ts";

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  avatarUrl: text("avatar_url"),
  /** "true"/"false" text — marks auto-created personal orgs (one per user) */
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

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id"),
    name: text("name").notNull(),
    config: text("config", { mode: "json" }).notNull().$type<WorkspaceConfig>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_workspaces_org_id").on(t.orgId)],
);

const sandboxStatusValues = [
  "creating",
  "running",
  "stopped",
  "error",
] as const;
export type SandboxStatus = (typeof sandboxStatusValues)[number];

export const sandboxes = sqliteTable(
  "sandboxes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id"),
    workspaceId: text("workspace_id"),
    createdBy: text("created_by"),
    status: text("status", { enum: sandboxStatusValues }).notNull(),
    runtime: text("runtime", { mode: "json" })
      .notNull()
      .$type<SandboxRuntime>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_sandboxes_org_id").on(t.orgId),
    index("idx_sandboxes_created_by").on(t.createdBy),
  ],
);

const configFileContentTypes = ["json", "text", "binary"] as const;

const configFileScopes = ["global", "workspace"] as const;

export const configFiles = sqliteTable(
  "config_files",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id"),
    path: text("path").notNull(),
    content: text("content").notNull(),
    contentType: text("content_type", {
      enum: configFileContentTypes,
    }).notNull(),
    scope: text("scope", { enum: configFileScopes }).notNull(),
    workspaceId: text("workspace_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_config_files_org_id").on(t.orgId)],
);

export const sharedAuth = sqliteTable("shared_auth", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  content: text("content").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

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

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id"),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    data: text("data", { mode: "json" }).notNull().$type<TaskData>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_tasks_workspace_id").on(t.workspaceId),
    index("idx_tasks_org_id").on(t.orgId),
  ],
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
