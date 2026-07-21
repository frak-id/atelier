CREATE TABLE `images` (
	`name` text PRIMARY KEY NOT NULL,
	`provenance` text NOT NULL,
	`status` text NOT NULL,
	`ref` text,
	`seed_id` text,
	`dockerfile` text,
	`digest` text,
	`build_log` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
