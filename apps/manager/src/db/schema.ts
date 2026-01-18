import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
  GitSourceConfig,
  SandboxRuntime,
  WorkspaceConfig,
} from "../types/index.ts";

export const gitSourceTypeValues = ["github", "gitlab", "custom"] as const;

export const gitSources = sqliteTable("git_sources", {
  id: text("id").primaryKey(),
  type: text("type", { enum: gitSourceTypeValues }).notNull(),
  name: text("name").notNull(),
  config: text("config", { mode: "json" }).notNull().$type<GitSourceConfig>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type GitSourceRow = typeof gitSources.$inferSelect;
export type NewGitSourceRow = typeof gitSources.$inferInsert;

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  config: text("config", { mode: "json" }).notNull().$type<WorkspaceConfig>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;

export const sandboxStatusValues = [
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

export type SandboxRow = typeof sandboxes.$inferSelect;
export type NewSandboxRow = typeof sandboxes.$inferInsert;

export const configFileContentTypes = ["json", "text", "binary"] as const;
export type ConfigFileContentType = (typeof configFileContentTypes)[number];

export const configFileScopes = ["global", "workspace"] as const;
export type ConfigFileScope = (typeof configFileScopes)[number];

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

export type ConfigFileRow = typeof configFiles.$inferSelect;
export type NewConfigFileRow = typeof configFiles.$inferInsert;
