CREATE TABLE `entity_toolbox_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`toolbox_id` text NOT NULL,
	`label` integer NOT NULL,
	`ref` text NOT NULL,
	`description` text NOT NULL,
	`provenance` text NOT NULL,
	`recipe_fingerprint` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_entity_toolbox_versions_toolbox` ON `entity_toolbox_versions` (`toolbox_id`);--> statement-breakpoint
ALTER TABLE `entity_toolboxes` ADD `active_version_id` text;