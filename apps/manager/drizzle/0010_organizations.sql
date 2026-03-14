CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`avatar_url` text,
	`personal` text DEFAULT 'false' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`avatar_url` text,
	`personal_org_id` text,
	`created_at` text NOT NULL,
	`last_login_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
CREATE TABLE `org_members` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_org_members_org_id` ON `org_members` (`org_id`);
--> statement-breakpoint
CREATE INDEX `idx_org_members_user_id` ON `org_members` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_org_members_org_user` ON `org_members` (`org_id`, `user_id`);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `org_id` text;
--> statement-breakpoint
CREATE INDEX `idx_workspaces_org_id` ON `workspaces` (`org_id`);
--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `org_id` text;
--> statement-breakpoint
ALTER TABLE `sandboxes` ADD `created_by` text;
--> statement-breakpoint
CREATE INDEX `idx_sandboxes_org_id` ON `sandboxes` (`org_id`);
--> statement-breakpoint
CREATE INDEX `idx_sandboxes_created_by` ON `sandboxes` (`created_by`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `org_id` text;
--> statement-breakpoint
CREATE INDEX `idx_tasks_org_id` ON `tasks` (`org_id`);
--> statement-breakpoint
ALTER TABLE `config_files` ADD `org_id` text;
--> statement-breakpoint
CREATE INDEX `idx_config_files_org_id` ON `config_files` (`org_id`);
--> statement-breakpoint
ALTER TABLE `git_sources` ADD `org_id` text;
--> statement-breakpoint
CREATE INDEX `idx_git_sources_org_id` ON `git_sources` (`org_id`);
