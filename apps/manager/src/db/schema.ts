import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const configFileContentTypes = ["json", "text", "binary"] as const;
export type ConfigFileContentType = (typeof configFileContentTypes)[number];

export const configFileScopes = ["global", "project"] as const;
export type ConfigFileScope = (typeof configFileScopes)[number];

export const configFiles = sqliteTable("config_files", {
  id: text("id").primaryKey(),
  path: text("path").notNull(),
  content: text("content").notNull(),
  contentType: text("content_type", { enum: configFileContentTypes }).notNull(),
  scope: text("scope", { enum: configFileScopes }).notNull(),
  projectId: text("project_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type ConfigFileRow = typeof configFiles.$inferSelect;
export type NewConfigFileRow = typeof configFiles.$inferInsert;

export const sandboxStatusValues = [
  "creating",
  "running",
  "stopped",
  "error",
] as const;
export type SandboxStatus = (typeof sandboxStatusValues)[number];

export const prebuildStatusValues = [
  "none",
  "building",
  "ready",
  "failed",
] as const;
export type PrebuildStatus = (typeof prebuildStatusValues)[number];

export const baseImageValues = [
  "dev-base",
  "dev-node",
  "dev-rust",
  "dev-python",
  "dev-go",
] as const;
export type BaseImageId = (typeof baseImageValues)[number];

export const sandboxes = sqliteTable("sandboxes", {
  id: text("id").primaryKey(),
  status: text("status", { enum: sandboxStatusValues }).notNull(),
  projectId: text("project_id"),
  branch: text("branch"),
  ipAddress: text("ip_address").notNull(),
  macAddress: text("mac_address").notNull(),
  urlsVscode: text("urls_vscode").notNull(),
  urlsOpencode: text("urls_opencode").notNull(),
  urlsTerminal: text("urls_terminal"),
  urlsSsh: text("urls_ssh").notNull(),
  vcpus: integer("vcpus").notNull(),
  memoryMb: integer("memory_mb").notNull(),
  pid: integer("pid"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  gitUrl: text("git_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  baseImage: text("base_image", { enum: baseImageValues }).notNull(),
  vcpus: integer("vcpus").notNull(),
  memoryMb: integer("memory_mb").notNull(),
  initCommands: text("init_commands", { mode: "json" })
    .notNull()
    .$type<string[]>(),
  startCommands: text("start_commands", { mode: "json" })
    .notNull()
    .$type<string[]>(),
  secrets: text("secrets", { mode: "json" })
    .notNull()
    .$type<Record<string, string>>(),
  exposedPorts: text("exposed_ports", { mode: "json" })
    .notNull()
    .$type<number[]>(),
  latestPrebuildId: text("latest_prebuild_id"),
  prebuildStatus: text("prebuild_status", {
    enum: prebuildStatusValues,
  }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type SandboxRow = typeof sandboxes.$inferSelect;
export type NewSandboxRow = typeof sandboxes.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
