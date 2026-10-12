CREATE TABLE `integration_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`credential` text,
	`enabled` integer DEFAULT true NOT NULL,
	`min_risk` text DEFAULT 'high' NOT NULL,
	`delay_seconds` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integration_connections_user_integration` ON `integration_connections` (`user_id`,`integration_id`);--> statement-breakpoint
DROP TABLE `steery_notify_policies`;