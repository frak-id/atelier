CREATE TABLE `platform_config` (
	`id` text PRIMARY KEY NOT NULL,
	`vscode_settings` text NOT NULL,
	`vscode_extensions` text NOT NULL,
	`vscode_theme` text,
	`opencode_providers` text NOT NULL,
	`opencode_default_model` text,
	`opencode_mcp_servers` text NOT NULL,
	`opencode_rules` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `vscode_extensions` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `vscode_settings` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `opencode_rules` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `opencode_mcp_servers` text;