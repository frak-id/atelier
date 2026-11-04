ALTER TABLE `entity_toolboxes` ADD `refresh_steps` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `entity_toolboxes` ADD `refresh_schedule` text;--> statement-breakpoint
ALTER TABLE `entity_toolboxes` ADD `next_refresh_at` text;--> statement-breakpoint
ALTER TABLE `entity_toolboxes` ADD `last_refresh` text;