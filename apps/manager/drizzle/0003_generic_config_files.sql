CREATE TABLE IF NOT EXISTS `config_files` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`content_type` text NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

DROP TABLE IF EXISTS `platform_config`;
