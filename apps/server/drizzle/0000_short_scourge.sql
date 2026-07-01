CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`expires_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_api_keys_user_id` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_api_keys_key_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `org_members` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_org_members_org_id` ON `org_members` (`org_id`);--> statement-breakpoint
CREATE INDEX `idx_org_members_user_id` ON `org_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_org_members_org_user` ON `org_members` (`org_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `org_policy_specs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`fragment` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_policy_specs_org_id_unique` ON `org_policy_specs` (`org_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `saved_specs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`name` text NOT NULL,
	`spec` text NOT NULL,
	`policy_refs` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_saved_specs_org_id` ON `saved_specs` (`org_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`name` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_secrets_org_id` ON `secrets` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_secrets_org_name` ON `secrets` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`username` text NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`expires_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ssh_keys_user_id` ON `ssh_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`avatar_url` text,
	`github_access_token` text,
	`personal_org_id` text,
	`created_at` text NOT NULL,
	`last_login_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);