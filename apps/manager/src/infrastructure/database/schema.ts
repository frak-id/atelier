import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
  GitSourceConfig,
  SandboxRuntime,
  WorkspaceConfig,
} from "../../schemas/index.ts";

const gitSourceTypeValues = ["github", "gitlab", "custom"] as const;

export const gitSources = sqliteTable("git_sources", {
  id: text("id").primaryKey(),
  type: text("type", { enum: gitSourceTypeValues }).notNull(),
  name: text("name").notNull(),
  config: text("config", { mode: "json" }).notNull().$type<GitSourceConfig>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  config: text("config", { mode: "json" }).notNull().$type<WorkspaceConfig>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

const sandboxStatusValues = [
  "creating",
  "running",
  "stopped",
  "error",
] as const;
export type SandboxStatus = (typeof sandboxStatusValues)[number];

export const sandboxes = sqliteTable("sandboxes", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id"),
  status: text("status", { enum: sandboxStatusValues }).notNull(),
  runtime: text("runtime", { mode: "json" }).notNull().$type<SandboxRuntime>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

const configFileContentTypes = ["json", "text", "binary"] as const;

const configFileScopes = ["global", "workspace"] as const;

export const configFiles = sqliteTable("config_files", {
  id: text("id").primaryKey(),
  path: text("path").notNull(),
  content: text("content").notNull(),
  contentType: text("content_type", { enum: configFileContentTypes }).notNull(),
  scope: text("scope", { enum: configFileScopes }).notNull(),
  workspaceId: text("workspace_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sharedAuth = sqliteTable("shared_auth", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  content: text("content").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
});
