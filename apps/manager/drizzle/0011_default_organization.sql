-- Create default organization for existing records
INSERT INTO `organizations` (`id`, `name`, `slug`, `personal`, `created_at`, `updated_at`)
VALUES ('default-org', 'Default Organization', 'default', 'false', datetime('now'), datetime('now'));
--> statement-breakpoint
-- Assign all existing workspaces to default org
UPDATE `workspaces` SET `org_id` = 'default-org' WHERE `org_id` IS NULL;
--> statement-breakpoint
-- Assign all existing sandboxes to default org
UPDATE `sandboxes` SET `org_id` = 'default-org' WHERE `org_id` IS NULL;
--> statement-breakpoint
-- Assign all existing tasks to default org
UPDATE `tasks` SET `org_id` = 'default-org' WHERE `org_id` IS NULL;
--> statement-breakpoint
-- Assign all existing config files to default org
UPDATE `config_files` SET `org_id` = 'default-org' WHERE `org_id` IS NULL;
--> statement-breakpoint
-- Assign all existing git sources to default org
UPDATE `git_sources` SET `org_id` = 'default-org' WHERE `org_id` IS NULL;
