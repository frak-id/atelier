CREATE TABLE `config_files` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`content_type` text NOT NULL,
	`scope` text NOT NULL,
	`workspace_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `git_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `platform_config`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `workspace_id` text;--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `runtime` text NOT NULL;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `project_id`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `branch`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `ip_address`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `mac_address`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `urls_vscode`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `urls_opencode`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `urls_terminal`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `urls_ssh`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `vcpus`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `memory_mb`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `pid`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `error`;