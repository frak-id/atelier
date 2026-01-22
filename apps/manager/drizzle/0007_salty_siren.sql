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
CREATE INDEX `idx_ssh_keys_user_id` ON `ssh_keys` (`user_id`);