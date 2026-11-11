CREATE TABLE `service_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`org_id` text NOT NULL,
	`github_kind` text DEFAULT 'none' NOT NULL,
	`github_config` text,
	`github_secret` text,
	`managed_by` text DEFAULT 'console' NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_accounts_name_unique` ON `service_accounts` (`name`);--> statement-breakpoint
CREATE INDEX `idx_service_accounts_org_id` ON `service_accounts` (`org_id`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `scope` text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `managed_by` text DEFAULT 'console' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `kind` text DEFAULT 'human' NOT NULL;