CREATE TABLE `github_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`github_user_id` text NOT NULL,
	`github_username` text NOT NULL,
	`avatar_url` text,
	`access_token` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_connections_github_user_id_unique` ON `github_connections` (`github_user_id`);
