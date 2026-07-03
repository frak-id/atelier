CREATE TABLE `org_toolboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
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
CREATE INDEX `idx_org_toolboxes_org_id` ON `org_toolboxes` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_org_toolboxes_org_slug` ON `org_toolboxes` (`org_id`,`slug`);