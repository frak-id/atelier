/**
 * Control's tables. Per docs/archive/design.md §3.1: "everything identity-shaped lives
 * here and ONLY here". No FK to runtime's `sandboxes`/`snapshots` tables —
 * control treats the runtime as an authenticated principal talks to, not a
 * database it joins against.
 */

import type {
  FileEntry,
  PortEntry,
  ProcessEntry,
  Source,
  ToolboxRefreshStatus,
  ToolboxVersionProvenance,
} from "@atelier/spec";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  avatarUrl: text("avatar_url"),
  personal: integer("personal", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

const userKindValues = ["human", "service"] as const;
export type UserKind = (typeof userKindValues)[number];

/**
 * Every principal. `human` rows come from the GitHub login (id = the GitHub
 * user id). `service` rows are service accounts (id `sa_…`, username
 * `<name>[bot]`): no login, API keys only, details in `service_accounts`.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: userKindValues }).notNull().default("human"),
  username: text("username").notNull().unique(),
  email: text("email").notNull(),
  avatarUrl: text("avatar_url"),
  githubAccessToken: text("github_access_token"),
  personalOrgId: text("personal_org_id"),
  createdAt: text("created_at").notNull(),
  lastLoginAt: text("last_login_at").notNull(),
});

const orgMemberRoleValues = ["owner", "member"] as const;
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

const apiKeyScopeValues = ["full", "mcp"] as const;
/** `full`: every authenticated route. `mcp`: the sandbox MCP (`/mcp`) only. */
export type ApiKeyScope = (typeof apiKeyScopeValues)[number];

const managedByValues = ["console", "config"] as const;
/** `config`: declared in `serviceAccounts` (sandbox.config.json) and
 * reconciled at boot; the API refuses to change or delete it. */
export type ManagedBy = (typeof managedByValues)[number];

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scope: text("scope", { enum: apiKeyScopeValues }).notNull().default("full"),
    managedBy: text("managed_by", { enum: managedByValues })
      .notNull()
      .default("console"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
  },
  (t) => [
    index("idx_api_keys_user_id").on(t.userId),
    uniqueIndex("idx_api_keys_key_hash").on(t.keyHash),
  ],
);

const serviceAccountGitHubKindValues = ["none", "app", "token"] as const;
export type ServiceAccountGitHubKind =
  (typeof serviceAccountGitHubKindValues)[number];

/**
 * Service-account details, one row per `users` row of kind `service`
 * (`user_id`). A service account belongs to exactly one org (`org_id`, its
 * role lives in `org_members`). Its GitHub credential: `github_kind` says
 * which, `github_config` holds the non-secret part (App ids, repositories,
 * permissions; or the git name/email of a static token) and
 * `github_secret` the secret part (the App private key PEM or the static
 * token), encrypted like secrets (`enc:` format).
 */
export const serviceAccounts = sqliteTable(
  "service_accounts",
  {
    userId: text("user_id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description").notNull().default(""),
    orgId: text("org_id").notNull(),
    githubKind: text("github_kind", { enum: serviceAccountGitHubKindValues })
      .notNull()
      .default("none"),
    githubConfig: text("github_config", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    githubSecret: text("github_secret"),
    managedBy: text("managed_by", { enum: managedByValues })
      .notNull()
      .default("console"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_service_accounts_org_id").on(t.orgId)],
);

/**
 * Org-owned toolbox configs. "Personal" means "in the
 * user's personal org". `source`/`build`/`paths` mirror `ToolboxConfigInput`;
 * `files` are written into every sandbox the toolbox applies to (secret refs
 * resolved by enrichment). Auto-inject toolboxes are built into refs and
 * prepended to `SandboxSpec.toolsets` at the api/ seam, never here.
 */
export const toolboxes = sqliteTable(
  "toolboxes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    source: text("source", { mode: "json" }).$type<Source>(),
    build: text("build", { mode: "json" }).notNull().$type<string[]>(),
    paths: text("paths", { mode: "json" }).notNull().$type<string[]>(),
    harness: text("harness"),
    processes: text("processes", { mode: "json" }).$type<ProcessEntry[]>(),
    ports: text("ports", { mode: "json" }).$type<PortEntry[]>(),
    files: text("files", { mode: "json" }).$type<FileEntry[]>(),
    autoInject: integer("auto_inject").notNull().default(1),
    /** Pinned toolbox version (nullable — null means "resolve the recipe
     * build every spawn", the default). Owned/updated by
     * `ToolboxRepository.setActiveVersionId`, never by
     * `ToolboxRepository.update` (docs/toolbox-versions.md §2). */
    activeVersionId: text("active_version_id"),
    /** Update commands a refresh runs (docs/toolbox-versions.md §10). */
    refresh: text("refresh_steps", { mode: "json" })
      .notNull()
      .default([])
      .$type<string[]>(),
    /** Cron expression (UTC) for scheduled refreshes; null = manual only. */
    refreshSchedule: text("refresh_schedule"),
    /** Next scheduled refresh (ISO); null when not scheduled. Advanced by
     * the scheduler before it starts a run, so a failing refresh waits for
     * its next slot instead of retrying every tick. */
    nextRefreshAt: text("next_refresh_at"),
    /** Outcome of the last finished refresh. */
    lastRefresh: text("last_refresh", {
      mode: "json",
    }).$type<ToolboxRefreshStatus>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_toolboxes_org").on(t.orgId),
    uniqueIndex("idx_toolboxes_org_slug").on(t.orgId, t.slug),
  ],
);

/**
 * Versions of a toolbox's deliverable (docs/toolbox-versions.md §4). A row
 * per capture/build kept associated with the toolbox — the runtime
 * `ToolsetRecord` never learns about toolboxes, so this is the control-side
 * join by `ref`. `label` is a per-toolbox monotonic counter (v1, v2, …),
 * assigned by `ToolboxVersionRepository.nextLabel`.
 */
export const toolboxVersions = sqliteTable(
  "toolbox_versions",
  {
    id: text("id").primaryKey(),
    toolboxId: text("toolbox_id").notNull(),
    label: integer("label").notNull(),
    ref: text("ref").notNull(),
    description: text("description").notNull(),
    provenance: text("provenance", { mode: "json" })
      .notNull()
      .$type<ToolboxVersionProvenance>(),
    recipeFingerprint: text("recipe_fingerprint").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_toolbox_versions_toolbox").on(t.toolboxId)],
);

export const serverConfig = sqliteTable("server_config", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});
