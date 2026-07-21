ALTER TABLE `entity_toolboxes` RENAME COLUMN `enabled` TO `auto_inject`;--> statement-breakpoint
ALTER TABLE `entity_toolboxes` ADD `processes` text;--> statement-breakpoint
ALTER TABLE `entity_toolboxes` ADD `ports` text;
