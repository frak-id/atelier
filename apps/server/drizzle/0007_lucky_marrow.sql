CREATE TABLE `entity_toolboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`slug` text NOT NULL,
	`description` text NOT NULL,
	`source` text,
	`build` text NOT NULL,
	`paths` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `entity_toolboxes` (`id`, `owner_type`, `owner_id`, `slug`, `description`, `source`, `build`, `paths`, `enabled`, `created_at`, `updated_at`)
	SELECT `id`, 'org', `org_id`, `slug`, `description`, `source`, `build`, `paths`, `enabled`, `created_at`, `updated_at` FROM `org_toolboxes`;--> statement-breakpoint
DROP TABLE `org_toolboxes`;--> statement-breakpoint
CREATE INDEX `idx_entity_toolboxes_owner` ON `entity_toolboxes` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_entity_toolboxes_owner_slug` ON `entity_toolboxes` (`owner_type`,`owner_id`,`slug`);
