CREATE TABLE `launchpad_starters` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`icon` text,
	`guide` text,
	`published` integer DEFAULT 1 NOT NULL,
	`recipe` text NOT NULL,
	`services` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_launchpad_starters_owner` ON `launchpad_starters` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `launchpad_workspaces` (
	`sandbox_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`starter_id` text,
	`job_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_launchpad_workspaces_user` ON `launchpad_workspaces` (`user_id`);