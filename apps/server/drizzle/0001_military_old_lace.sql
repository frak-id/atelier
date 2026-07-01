CREATE TABLE `sandboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`spec` text NOT NULL,
	`status` text NOT NULL,
	`generated` text NOT NULL,
	`metadata` text NOT NULL,
	`pod_name` text,
	`pvc_name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`ref` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`image` text NOT NULL,
	`parent` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_snapshots_hash` ON `snapshots` (`hash`);